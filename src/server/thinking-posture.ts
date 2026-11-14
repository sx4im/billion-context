// [#5998] Thinking-signature posture — learn-on-failure at the relay egress
// chokepoint. Two upstream personalities share one inbound wire and are
// byte-indistinguishable on it:
//   - signature-verifying peers (Anthropic proper) reject ANY thinking block
//     that carries no non-empty signature — pinned wording "thinking.signature:
//     Field required" (#2501); hosts whose transcripts store reasoning without
//     signatures (e.g. DSH: {type,text} only) therefore 400 on every rebuilt
//     turn until those blocks are gone;
//   - never-signing relays (DeepSeek's /anthropic endpoint, #5495) require the
//     unsigned thinking they produced to come back VERBATIM ("must be passed
//     back") — stripping there manufactures the 400 instead of fixing it.
// No content-based rule can tell the two apart (the histories are identical),
// so the upstream itself is asked: the first "Field required" 400 is answered
// with a single strip-and-resend probe. Accepted ⇒ causation confirmed — the
// session remembers the strict posture and later sends drop signature-less
// thinking proactively. Still failing ⇒ NOT this field — the second response
// is discarded, the original 400 is forwarded verbatim, nothing is learned.
// Session-scoped only (session.metadata, persisted with the session record);
// no config surface.
import type { Session } from "../session.js";

const POSTURE_KEY = "thinkingSignatureStrict";

export function thinkingPostureIsStrict(session: Pick<Session, "metadata">): boolean {
    return session.metadata[POSTURE_KEY] === true;
}

export function rememberStrictThinkingPosture(session: Pick<Session, "metadata">): void {
    session.metadata[POSTURE_KEY] = true;
}

/**
 * The signature-verifying upstream's rejection of a signature-less thinking
 * block ("thinking.signature: Field required", #2501). Deliberately narrow:
 * the #5495 mandatory-thinking wording ("must be passed back") and the #1960
 * tamper wording ("cannot be modified") are different pathologies with
 * different fixes — probing either would re-manufacture the 400 or rewrite a
 * signed channel (KDD#10), so both are excluded here.
 */
export function detectThinkingSignatureRejection(status: number, bodyText: string): boolean {
    if (status !== 400) return false;
    if (!/signature/i.test(bodyText)) return false;
    if (!/thinking/i.test(bodyText)) return false;
    if (!/(required|missing)/i.test(bodyText)) return false;
    if (/must be passed back/i.test(bodyText)) return false;
    if (/cannot be modified/i.test(bodyText)) return false;
    return true;
}

interface UnsignedThinkingStrip {
    body: string;
    removed: number;
}

function isUnsignedThinkingBlock(block: unknown): boolean {
    if (typeof block !== "object" || block === null) return false;
    const b = block as Record<string, unknown>;
    if (b.type !== "thinking") return false;
    const sig = b.signature;
    return !(typeof sig === "string" && sig.length > 0);
}

function assistantContent(msg: unknown): unknown[] | null {
    if (typeof msg !== "object" || msg === null) return null;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") return null;
    return Array.isArray(m.content) ? m.content : null;
}

/**
 * Drop signature-less thinking blocks from an outbound Anthropic wire body.
 * Signed blocks, redacted_thinking, text and tool blocks pass through
 * untouched; a message left with NO content at all (a turn that was pure
 * unsigned thinking) is dropped wholesale and any role-run the drop creates
 * is re-merged, so the result stays legal Anthropic shape. Returns the input
 * string untouched when nothing changed or the body is not JSON we understand
 * (never guess).
 */
export function stripUnsignedThinkingFromWire(body: string): UnsignedThinkingStrip {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, removed: 0 };
    }
    if (typeof parsed !== "object" || parsed === null) return { body, removed: 0 };
    const wire = parsed as Record<string, unknown>;
    const messages = wire.messages;
    if (!Array.isArray(messages)) return { body, removed: 0 };

    let removed = 0;
    const survivors: unknown[] = [];
    for (const msg of messages) {
        const content = assistantContent(msg);
        if (content === null || content.length === 0) {
            survivors.push(msg);
            continue;
        }
        if (content.every(isUnsignedThinkingBlock)) {
            // Pure-unsigned-thinking turn: dropping the blocks would leave
            // content: [], which is its own 400 — drop the message instead.
            removed += content.length;
            continue;
        }
        if (content.some(isUnsignedThinkingBlock)) {
            const kept = content.filter((b: unknown) => !isUnsignedThinkingBlock(b));
            (msg as Record<string, unknown>).content = kept;
            removed += content.length - kept.length;
        }
        survivors.push(msg);
    }
    if (removed === 0) return { body, removed: 0 };
    wire.messages = reconcileRoleRuns(survivors);
    return { body: JSON.stringify(wire), removed };
}

function reconcileRoleRuns(messages: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const msg of messages) {
        const prev = out[out.length - 1];
        if (prev !== undefined && typeof prev === "object" && prev !== null &&
            typeof msg === "object" && msg !== null &&
            (prev as Record<string, unknown>).role === (msg as Record<string, unknown>).role) {
            const p = prev as Record<string, unknown>;
            p.content = [...asContentBlocks(p.content), ...asContentBlocks((msg as Record<string, unknown>).content)];
            continue;
        }
        out.push(msg);
    }
    return out;
}

function asContentBlocks(content: unknown): unknown[] {
    if (Array.isArray(content)) return content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    return [];
}

// ---------------------------------------------------------------------------
// #6632: thinking-block binding on Fable-class upstreams.
// ---------------------------------------------------------------------------
//
// Fable-class upstreams (claude-fable-5-2) bind each signed thinking block to
// the exact history prefix it was created on. Any fold that rewrites that
// prefix — snapshot render, legacy processTurn, a client-side compaction, or
// a compress executed mid-request — makes the NEXT request fail with 400
// "Invalid `signature` in `thinking` block", and the invalid block stays in
// the client history, so the session bricks permanently. Opus 5.5 does NOT
// enforce the binding (evidence: #6632 — same fold, Opus unaffected).
//
// The remedy is the one the 400 itself names: opt into Anthropic's handling
// by adding `thinking-binding-controls-2026-08-01` to `anthropic-beta` and
// setting `thinking.block_binding.prefix_mismatch_behavior` to `drop_block`,
// so the upstream drops the mismatched block instead of rejecting the whole
// request. This is proactive, not learn-on-failure: the opt-in is inert
// upstream whenever no prefix mismatch exists (nothing is dropped), so it is
// applied on every extended-thinking request for a binding model — including
// pre-fold turns, so a fold created mid-request rides into the round-2
// re-request through the prepared body. It never touches the thinking bytes
// themselves (KDD #10): the block is dropped server-side by Anthropic, and
// the client's persisted history is left verbatim.
//
// Scope is deliberately narrow (KDD #9 evidence-permitlist discipline): only
// models observed to enforce the binding join the family — a new model joins
// only with traffic evidence, never by analogy.

/** The Anthropic beta that enables thinking-binding controls. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** True for model ids in the thinking-binding family (the `fable` segment). */
export function isThinkingBindingModel(model: string | undefined): boolean {
    if (typeof model !== "string" || model.length === 0) return false;
    const bare = model.replace(/\[[^\]]*\]$/, "");
    return bare.toLowerCase().split("-").some((segment) => segment === "fable");
}

/**
 * Set `thinking.block_binding.prefix_mismatch_behavior` to `drop_block` on an
 * outbound Anthropic body, when the request is for a binding model with
 * extended thinking on. Returns true when it set the field. A client-set
 * block_binding is never clobbered; a missing or explicitly-disabled
 * `thinking` param is left alone (block_binding without a thinking type
 * would invent a config the client never asked for).
 */
export function applyThinkingBinding(body: Record<string, unknown>, model: string | undefined): boolean {
    if (!isThinkingBindingModel(model)) return false;
    const thinking = body.thinking;
    if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) return false;
    const t = thinking as Record<string, unknown>;
    if (t.type === "disabled") return false;
    if (t.block_binding !== undefined) return false;
    t.block_binding = { prefix_mismatch_behavior: "drop_block" };
    return true;
}
