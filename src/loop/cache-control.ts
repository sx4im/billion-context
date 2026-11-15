import type { AnthropicRequestBody } from "acp-kernel/wire";
import { noCacheControl as knobNoCacheControl } from "../knobs.js";

/**
 * #1637: Anthropic prompt caching is EXPLICIT — content blocks must carry
 * `cache_control` breakpoints or nothing upstream caches. bili used to emit
 * none, so Anthropic-style upstreams never cached anything bili sent, and
 * relays that breakpoint only the system block left the ENTIRE history
 * re-billing at full price on every request (#1631: cached pinned at the
 * system head, 9–13%, for 40+ requests straight).
 *
 * Both the steady request path (prepareAnthropic) and the compress-loop
 * round-2 rebuild (adapter-anthropic) apply THE SAME marks through the
 * kernel's own `coreToAnthropic(messages, cacheControls)` machinery — one
 * applier, identical bytes on both paths (the dual-builder divergence class
 * the cache matrix pins; see #1554).
 *
 * Cadence: CUMULATIVE incremental breakpoints (Anthropic-recommended). A
 * marked message STAYS marked — removing a mid-history marker mutates that
 * element's bytes on the next request and breaks the byte prefix exactly
 * there. Marks die only by folding (covered messages vanish from the view).
 * Once the cap is reached no NEW marks are added until a fold retires
 * covered ones: a rolling drop would mutate an early element and collapse
 * the LCP. Cap = 3 message marks + 1 system breakpoint = Anthropic's 4-block
 * limit.
 *
 * Client-managed caching wins: any pre-existing cache_control (harvested
 * from the client's messages, present on system blocks, or on tools entries —
 * the 4-breakpoint budget counts all three) suppresses our stamps entirely
 * (pass no marks / return the system unchanged).
 * BILI_NO_CACHE_CONTROL / compat.noCacheControl disables everything.
 */

const MESSAGE_MARK_CAP = 3;

type AnthropicCacheMarks = Map<string, { type: "ephemeral" }>;

export function computeAnthropicMessageMarks(
    processed: { id?: string }[],
    ephemeralTailCount: number,
    session: { metadata: Record<string, unknown> },
): AnthropicCacheMarks {
    const marks = new Map<string, { type: "ephemeral" }>();
    if (knobNoCacheControl()) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    if (processed.length === 0 || processed.length <= ephemeralTailCount) {
        session.metadata["anthropicCacheMarkIds"] = [];
        return marks;
    }
    const liveIds = new Set(processed.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0));
    // Retire marks whose messages folded away; keep the survivors' order.
    const kept = ((session.metadata["anthropicCacheMarkIds"] as string[] | undefined) ?? []).filter((id) => liveIds.has(id));
    const lastIndex = processed.length - 1 - ephemeralTailCount;
    const currentId = processed[lastIndex]?.id;
    if (typeof currentId === "string" && currentId.length > 0 && !kept.includes(currentId) && kept.length < MESSAGE_MARK_CAP) {
        kept.push(currentId);
    }
    session.metadata["anthropicCacheMarkIds"] = kept;
    for (const id of kept) marks.set(id, { type: "ephemeral" });
    return marks;
}

// #6861: pin CLIENT-harvested cache_control marks cumulatively on the steady
// proxy path. Claude Code stamps a breakpoint on its last message + last
// assistant message and MOVES them as the conversation grows (#2188); the
// steady path forwarded the client's CURRENT placement verbatim, so every
// request stripped the breakpoint off the message that carried it last turn
// and the outbound prefix broke exactly there (12/12 consecutive pairs in
// the report, cache hit 8.7% on one request, 119K tokens re-billed). The
// opencode lane already handles rolling marks via the retouch channel; the
// steady path had no equivalent. The seam detector cannot see it either —
// marks live in the harvested map, not in the core messages it fingerprints
// — so the seam stays "unexplained". Proxy mode ONLY: in plugin mode the
// host owns the rolling marks and the lane pins "no accumulation", so the
// call site must not pin there (it would add a third breakpoint to the
// host's two).
//
// The pin applies the #1637 discipline ("a marked message STAYS marked")
// to the client's own marks: an adopted mark stays on its message until the
// message leaves the live history (fold/edit), new client marks are adopted
// in first-seen order up to the same 3-message cap, and the total never
// grows past the cap. Mid-conversation system marks ride through verbatim
// (they are not message marks; the frozen client head keeps the top-level
// system mark stable, #1085/#1876). BILI_NO_CACHE_CONTROL gates bili's OWN
// stamps only — client marks pass through with or without it — so the pin
// applies either way; it never invents a mark the client did not place.
export function pinClientCacheMarks(
    session: { metadata: Record<string, unknown> },
    harvested: Map<string, unknown>,
    liveMessages: readonly { id?: string; role?: string }[],
): Map<string, unknown> {
    const liveMessageIds = new Set(liveMessages.filter((m) => m.id && m.role !== "system").map((m) => m.id as string));
    const liveSystemIds = new Set(liveMessages.filter((m) => m.id && m.role === "system").map((m) => m.id as string));
    // Pinned message marks: one metadata record, id -> mark value; plain
    // object string keys keep first-seen order.
    const stored = session.metadata["anthropicClientCacheMarks"];
    const pinned: Record<string, unknown> = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
    // Drop marks whose message left the live history (fold/edit).
    for (const id of Object.keys(pinned)) if (!liveMessageIds.has(id)) delete pinned[id];
    // Adopt this request's harvested message marks, earliest first, cap 3.
    for (const [id, mark] of harvested) {
        if (!liveMessageIds.has(id)) continue;
        if (!(id in pinned) && Object.keys(pinned).length >= MESSAGE_MARK_CAP) continue;
        pinned[id] = mark;
    }
    session.metadata["anthropicClientCacheMarks"] = pinned;
    // Outbound map: pinned message marks + this request's live system marks
    // verbatim (unpinned, uncapped — system marks are a separate budget).
    const out = new Map<string, unknown>();
    for (const [id, mark] of Object.entries(pinned)) out.set(id, mark);
    for (const [id, mark] of harvested) if (liveSystemIds.has(id)) out.set(id, mark);
    return out;
}

/** WC-010: Anthropic's 4-breakpoint budget spans system blocks + tools entries
 *  + message blocks COMBINED; anthropicToCore only harvests messages, so a
 *  tools-only client mark must suppress ours too or the 5th breakpoint 400s. */
export function anthropicToolsCarryCacheControl(tools: unknown): boolean {
    if (!Array.isArray(tools)) return false;
    return tools.some((t) => typeof t === "object" && t !== null && (t as { cache_control?: unknown }).cache_control !== undefined);
}

export function stampAnthropicSystemCacheControl(systemOut: AnthropicRequestBody["system"], ours = true): AnthropicRequestBody["system"] {
    if (knobNoCacheControl()) return systemOut;
    if (!ours) return systemOut;
    if (typeof systemOut === "string" && systemOut.length > 0) {
        // Deterministic string→block conversion (semantically identical for
        // Anthropic; stable across turns). A string system can carry no
        // client cache_control, so conversion never discards one.
        return [{ type: "text", text: systemOut, cache_control: { type: "ephemeral" } }];
    }
    if (!Array.isArray(systemOut) || systemOut.length === 0) return systemOut;
    for (const block of systemOut) {
        if ((block as { cache_control?: unknown }).cache_control) return systemOut;
    }
    // Stamp by replacement, never in place: the array may share block
    // references with the frozen client head (parsed.system), which must stay
    // unmarked (#1085).
    const last = systemOut.length - 1;
    systemOut[last] = { ...systemOut[last], cache_control: { type: "ephemeral" } };
    return systemOut;
}
