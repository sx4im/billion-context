import type { ProviderRoutes } from "./config.js";
import { findRoute } from "./config.js";
import { defaultPrompts } from "acp-kernel";

/** A resolved wire-compat role map: source role → role name upstream accepts. */
export type CompatRoles = Record<string, string>;

/** Validate a `compat.roles`-shaped value: an object of string → string.
 *  Non-string entries are dropped (a malformed partial never breaks the
 *  proxy); returns undefined when there is nothing usable. */
export function parseCompatRoles(v: unknown): Record<string, string> | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj = v as Record<string, unknown>;
    let out: Record<string, string> | undefined;
    for (const [k, val] of Object.entries(obj)) {
        if (typeof val !== "string" || val.length === 0) continue;
        out ??= {};
        out[k] = val;
    }
    return out;
}

/** Merge the wire-compat role map for one request: global `compat.roles`
 *  (config root) overlaid by the per-provider route entry (longest-URL-prefix
 *  match, identical to the compress-settings lookup). Provider entries win
 *  per key; global keys not overridden still apply. Empty when unconfigured —
 *  the default, byte-for-byte transparent forward (#552). */
export function resolveCompatRoles(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    globalRoles: Record<string, string> | undefined,
): Record<string, string> {
    const providerRoles = findRoute(routes, upstreamUrl)?.compat?.roles;
    if (!globalRoles && !providerRoles) return {};
    return { ...globalRoles, ...providerRoles };
}

/** Apply the role map to a serialized chat-completions or Responses body.
 *  Rewrites exact-match roles only — position, content and every other field
 *  are untouched. Returns the original string (no re-stringify) when nothing
 *  matched, so the default path stays byte-identical.
 *
 *  Applied at the FINAL forward boundary on purpose: every emission site —
 *  client-sent items, bili's injected compress prompt, instructions hoisting,
 *  compress-loop items — is visible there, and the kernel already normalizes
 *  developer→system internally (session state / block IDs / prefix-cache are
 *  computed from pre-wire core messages), so only outbound bytes change. */
/** Object-level role rewrite shared by the forward boundary (string body)
 *  and the compress-retry loops (parsed body). Mutates `parsed` in place;
 *  returns the number of roles rewritten. */
export function applyCompatRolesJson(
    parsed: Record<string, unknown>,
    protocol: "openai" | "responses",
    roles: Record<string, string>,
): number {
    if (Object.keys(roles).length === 0) return 0;
    const items = protocol === "openai" ? parsed.messages : parsed.input;
    if (!Array.isArray(items)) return 0;
    let rewritten = 0;
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const msg = item as Record<string, unknown>;
        if (protocol === "responses" && msg.type !== undefined && msg.type !== "message") continue;
        const role = msg.role;
        if (typeof role !== "string") continue;
        const mapped = roles[role];
        if (mapped === undefined || mapped === role) continue;
        msg.role = mapped;
        rewritten++;
    }
    return rewritten;
}

/** Stop-words that follow "role" in prose ("Invalid role must be one…"):
 *  a captured token equal to one of these means the regex grabbed a word
 *  from the sentence, not a role name. */
const ROLE_CAPTURE_STOPWORDS = new Set([
    "must", "should", "be", "is", "one", "of", "the", "a", "an", "in", "for", "not", "was", "and", "or", "to", "only", "allowed", "supported", "valid", "value", "message", "messages",
]);

const ROLE_REJECTION_PATTERNS = [
    /(?:invalid|unknown|unsupported|unrecognized|unexpected)[a-z ]{0,24}?role\s*[:=]?\s*["'`]?([a-z][a-z0-9_-]{1,31})["'`]?/i,
    /role\s*[:=]?\s*["'`]?([a-z][a-z0-9_-]{1,31})["'`]?\s+(?:is\s+)?not\s+(?:supported|allowed|recognized|valid|accepted)/i,
    // Rust serde deserialization shape (DeepSeek official API, #6063): the
    // field path comes FIRST and "unknown variant" after — the reverse word
    // order of pattern 1, so it needs its own rule:
    //   messages[0].role: unknown variant `developer`, expected one of ...
    /role\s*:\s*(?:unknown|invalid|unsupported)\s+variant\s*["'`]?([a-z][a-z0-9_-]{1,31})["'`]?/i,
];

/** Detect an upstream 400/422 that exists only because of a message role the
 *  provider does not support (e.g. codex ≥0.153 sends "developer"; converting
 *  backends answer 400 "Invalid role: developer", serde-based ones such as
 *  DeepSeek answer 422 "messages[0].role: unknown variant `developer`", #6063).
 *  Conservative by design: status must be 400 or 422, the body must blame a
 *  role, and the captured token must look like a role name. Returns the
 *  offending role so the caller can auto-rewrite it to a supported one. */
export function detectRoleRejection(status: number, bodyText: string): { role: string } | null {
    if (status !== 400 && status !== 422) return null;
    const head = bodyText.slice(0, 4096);
    for (const re of ROLE_REJECTION_PATTERNS) {
        const m = re.exec(head);
        if (!m) continue;
        const role = m[1].toLowerCase();
        if (ROLE_CAPTURE_STOPWORDS.has(role)) continue;
        return { role };
    }
    return null;
}

/** Detect the OTHER half of the #552 edge (#583): a backend that ACCEPTS the
 *  role name but rejects a `system` message that is not at index 0 (or more
 *  than one system message) — the SGLang-style strict-placement class behind
 *  #377. Distinct from detectRoleRejection, which names an unsupported ROLE;
 *  here the role is fine and the POSITION/count is the problem, so there is no
 *  role to capture — just a boolean gate for the second-chance developer→user
 *  hop. Conservative: requires a 400/422 (#552 ladder gate) plus the literal
 *  word "system" plus one strong placement/multiplicity marker, so unrelated
 *  errors (quota, overflow, missing-system, auth) never trip it.
 *  Quotes/brackets are normalized away so phrasings like "Only one 'system'
 *  message…" still match. */
export function detectSystemPlacementError(status: number, bodyText: string): boolean {
    if (status !== 400 && status !== 422) return false;
    const head = bodyText.slice(0, 4096);
    if (!/system/i.test(head)) return false;
    const norm = head.replace(/['"`[\](){}]/g, " ");
    const PLACEMENT_MARKERS = [
        /\b(multiple|more\s+than\s+one|exactly\s+one|only\s+one|single|another|second|third)\s+system/i,
        /\b[2-9]\d*\s+system\s+messages?\b/i,
        /system\s+messages?\b[^.\n]{0,50}\bindex\s*\d+\b/i,
        /(system\s+messages?|system\s+roles?)\b[^.\n]{0,50}\b(beginning|start|front|first\s+message|must\s+be\s+first)/i,
    ];
    return PLACEMENT_MARKERS.some((re) => re.test(norm));
}

/** #1996 — Responses item types that materialize as chat messages upstream
 *  (vLLM maps function_call/custom_tool_call→assistant, *_output→tool,
 *  reasoning→assistant), so a system item placed after any of them is
 *  off-head for the model's chat template. */
const ROLE_PRODUCING_TYPES = new Set([
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "reasoning",
]);

/**
 * #1996 — does this wire body carry the shape placement-strict backends
 * reject? A literal role:"system" message that is not the first chat-producing
 * item (or a second system anywhere) trips Qwen-family Jinja chat templates
 * served by vLLM/SGLang: "System message must be at the beginning." Bili never
 * emits such items itself (front block/anchors ride as developer,
 * nudges/separators as user, top-level instructions stripped), so offenders
 * are client-origin mid-history system items forwarded verbatim by the
 * plugin-mode position-preserving pass-through (#1638). Eligibility mirrors
 * applyCompatRolesJson exactly; on the Responses wire a non-empty top-level
 * `instructions` string becomes a leading system upstream, so with it present
 * ANY input[] system is off-head.
 */
export function hasOffHeadSystem(body: string, protocol: "openai" | "responses"): boolean {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return false;
    }
    const items = protocol === "openai" ? parsed.messages : parsed.input;
    if (!Array.isArray(items)) return false;
    const virtualLeading =
        protocol === "responses" && typeof parsed.instructions === "string" && parsed.instructions.length > 0;
    let systems = 0;
    let firstSlotIdx = -1;
    let firstSystemIdx = -1;
    items.forEach((item, i) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const msg = item as Record<string, unknown>;
        const t = msg.type;
        const isMessage = t === undefined || t === "message";
        if (protocol === "responses" && !isMessage && !ROLE_PRODUCING_TYPES.has(t as string)) return;
        if (firstSlotIdx < 0) firstSlotIdx = i;
        if (isMessage && msg.role === "system") {
            systems++;
            if (firstSystemIdx < 0) firstSystemIdx = i;
        }
    });
    if (systems === 0) return false;
    if (systems > 1) return true;
    if (virtualLeading) return true;
    return firstSystemIdx !== firstSlotIdx;
}

/** #6636 — the bili-injected ACP tags prompt. A leading system message whose
 *  content starts with this marker is bili's own tags-only standing prompt
 *  (buildAcpTagsOnlyPrompt: the acpTags section, byte-stable across the
 *  timestamped/default variants up to the example tag's type attribute).
 *  Never client prose: the marker is bili's own template text. Written with
 *  hex escapes per KDD #2 (no literal angle brackets in source). */
const ACP_TAGS_SYSTEM_MARKER =
    "ACP TAGS\n\nAddressable messages in the conversation are annotated with a \x3cacp tokens=\"2.1K\" type=\"tool:bash\"";

/** #6636 — detect an upstream 400/422 that exists ONLY because a `system`
 *  role is forbidden outright on this endpoint (Xiaomi MiMo TTS:
 *  "messages[0] system role is not allowed for TTS model"). Distinct from
 *  detectRoleRejection (an unsupported role NAME — the #552 ladder owns
 *  those) and detectSystemPlacementError (the role is fine, its POSITION is
 *  wrong — also the ladder's): here the role name is accepted in principle
 *  and the position is index 0, but the endpoint allows no system message
 *  at all, so the repair is removal, not re-voicing. Conservative: status
 *  must be 400/422, the error must blame a system role with a rejection
 *  word, and when it names a message index that index must be 0 — a
 *  messages[3] rejection is a mid-history client system, not bili's
 *  injected head, and the strip probe cannot fix it. */
const SYSTEM_ROLE_REJECTION_PATTERNS = [
    /system\s+role\s+is\s+not\s+(allowed|supported|permitted|accepted|valid)/i,
    /system\s+role\s+not\s+(allowed|supported|permitted|accepted|valid)/i,
    /system\s+role\b[^.\n]{0,40}\b(forbidden|disallowed|prohibited)\b/i,
];
export function detectSystemRoleRejection(status: number, bodyText: string): boolean {
    if (status !== 400 && status !== 422) return false;
    const head = bodyText.slice(0, 4096);
    const indexed = /messages?\[(\d+)\]/.exec(head);
    if (indexed !== null && Number(indexed[1]) !== 0) return false;
    return SYSTEM_ROLE_REJECTION_PATTERNS.some((re) => re.test(head));
}

/** #6636 — a leading <acp> tag prefix as renderMessage emits it:
 *  `<acp tokens="…" type="…" [time="…"]>mNNNNN</acp>` + newline, anchored
 *  at the start of the message text. Written with hex escapes per KDD #2. */
const ACP_TAG_PREFIX_RE = /^\x3cacp tokens="[^"]*" type="[^"]*"(?: time="[^"]*")?\x3em\d+\x3c\/acp\x3e\n?/;

/** Strip one leading tag prefix from a message's text content, when the
 *  content is a plain string or a text-parts array. Tool-call arguments are
 *  never touched (#1039) — only the `content` text channel, which is where
 *  renderMessage stamps the tag. Returns true when a prefix was removed. */
function stripMessageTagPrefix(msg: Record<string, unknown>): boolean {
    const content = msg.content;
    if (typeof content === "string") {
        if (!ACP_TAG_PREFIX_RE.test(content)) return false;
        msg.content = content.replace(ACP_TAG_PREFIX_RE, "");
        return true;
    }
    if (Array.isArray(content)) {
        for (const part of content) {
            if (!part || typeof part !== "object" || Array.isArray(part)) continue;
            const p = part as Record<string, unknown>;
            if (typeof p.text !== "string") continue;
            if (p.type !== undefined && p.type !== "text") continue;
            if (!ACP_TAG_PREFIX_RE.test(p.text)) return false;
            p.text = p.text.replace(ACP_TAG_PREFIX_RE, "");
            return true;
        }
    }
    return false;
}

export interface StrippedAcpDecoration {
    /** The undecorated body, re-serialized. All fields other than messages
     *  pass through untouched (model, audio, stream, tools, …). */
    body: string;
    /** True when the leading system message was bili's own and dropped. */
    strippedSystem: boolean;
    /** How many message texts lost a leading <acp> tag prefix. */
    strippedTags: number;
}

/** #6636: remove bili's own injected ACP decoration from a serialized
 *  OpenAI chat-completions body — the leading system message plus the
 *  leading <acp> tag prefix on each message's text — returning the body
 *  the client originally sent, as closely as the wire allows. Returns null
 *  when the body is NOT provably bili-decorated, so the caller never
 *  strips client-authored text:
 *   - the leading message must be role:"system" with STRING content
 *     starting with either the tags-only ACP prompt marker or the default
 *     compress-philosophy text (the full-prompt lane, client sent no
 *     system of its own). A client system message — including one merged
 *     with bili's prompt by injectOpenaiSystem (`client\n\n---\n\nprompt`)
 *     — matches neither prefix and bails the probe.
 *   - tag prefixes are stripped only from the text channel (string content
 *     or first text part); tool-call arguments are never touched (#1039).
 *  A null return means "do not retry": the 400 is not bili's decoration to
 *  remove (or not removable without touching client bytes), so the original
 *  400 stands. */
export function stripBiliAcpDecoration(body: string): StrippedAcpDecoration | null {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return null;
    }
    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const head = messages[0];
    if (!head || typeof head !== "object" || Array.isArray(head)) return null;
    const headRec = head as Record<string, unknown>;
    if (headRec.role !== "system") return null;
    const headText = headRec.content;
    if (typeof headText !== "string") return null;
    const isTagsOnly = headText.startsWith(ACP_TAGS_SYSTEM_MARKER);
    const isFullPrompt = headText.startsWith(defaultPrompts.compressPhilosophy);
    if (!isTagsOnly && !isFullPrompt) return null;
    messages.shift();
    let strippedTags = 0;
    for (const item of messages) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        if (stripMessageTagPrefix(item as Record<string, unknown>)) strippedTags++;
    }
    return { body: JSON.stringify(parsed), strippedSystem: true, strippedTags };
}

export function applyCompatRoles(
    body: string,
    protocol: "openai" | "responses",
    roles: Record<string, string>,
): { body: string; rewritten: number } {
    if (Object.keys(roles).length === 0) return { body, rewritten: 0 };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
        return { body, rewritten: 0 };
    }
    const rewritten = applyCompatRolesJson(parsed, protocol, roles);
    if (rewritten === 0) return { body, rewritten: 0 };
    return { body: JSON.stringify(parsed), rewritten };
}
