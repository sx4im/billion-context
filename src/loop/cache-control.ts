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

/** WC-010: Anthropic's cache_control budget is 4 breakpoints per request,
 *  spanning system blocks + tools entries + message blocks COMBINED. */
const ANTHROPIC_BREAKPOINT_BUDGET = 4;

/** #6861: pin a client-managed cache_control set with the same cumulative
 *  discipline as bili's own marks above. Clients rotate their breakpoint
 *  onto the newest message each request and drop it from the previous one;
 *  mirroring that rotation verbatim rewrites the un-marked message
 *  mid-history and breaks the byte prefix exactly there — while the #3023
 *  client arm cannot see it, because its inbound fingerprints are computed
 *  over cache-control-stripped CoreMessages, so the seam stays unattributed.
 *  A marked message therefore STAYS marked until it folds away (liveness is
 *  judged against the post-turn view); once the budget is full no NEW mark
 *  is added — the set freezes instead of dropping an old one. The pin store
 *  lives in session metadata beside `anthropicCacheMarkIds`, as an id ->
 *  mark-value record (values are the client's own harvested objects, so a
 *  re-pinned mark re-applies byte-identically). `reservedBreakpoints` counts
 *  the breakpoints this request already spends outside the message array
 *  (client system + tools marks); the pinned message set must fit what is
 *  left of the 4-breakpoint budget. Returns the map coreToAnthropic applies
 *  — the pinned set, which the round-2 rebuild reuses via the same
 *  `anthropicCacheMarks ?? anthropicClientCacheControls` source (#2499). */
export function pinClientCacheMarks(
    harvested: Map<string, unknown>,
    processed: { id?: string }[],
    session: { metadata: Record<string, unknown> },
    reservedBreakpoints: number,
): Map<string, unknown> {
    const liveIds = new Set(processed.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0));
    const stored = session.metadata["anthropicPinnedClientCacheMarks"];
    const kept: Array<[string, unknown]> = [];
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
            if (liveIds.has(id)) kept.push([id, value]);
        }
    }
    const cap = Math.max(0, Math.min(MESSAGE_MARK_CAP, ANTHROPIC_BREAKPOINT_BUDGET - Math.max(0, Math.floor(reservedBreakpoints))));
    for (const [id, value] of harvested) {
        if (!liveIds.has(id)) continue;
        const existing = kept.find(([keptId]) => keptId === id);
        if (existing) {
            // Same message, freshest mark value wins; the position never moves.
            existing[1] = value;
            continue;
        }
        if (kept.length >= cap) break;
        kept.push([id, value]);
    }
    // Trim to the cap when the reserved count grew since the pins were
    // stored — keep the earliest, they guard the longest prefix.
    const pinned = kept.slice(0, cap);
    session.metadata["anthropicPinnedClientCacheMarks"] = Object.fromEntries(pinned);
    return new Map(pinned);
}

/** WC-010: count the client's cache_control breakpoints on the top-level
 *  system field (string systems carry none). */
export function countAnthropicSystemCacheControl(system: unknown): number {
    if (!Array.isArray(system)) return 0;
    let n = 0;
    for (const b of system) {
        if (b && typeof b === "object" && (b as { cache_control?: unknown }).cache_control !== undefined) n++;
    }
    return n;
}

/** WC-010: count the client's cache_control breakpoints on tools entries. */
export function countAnthropicToolsCacheControl(tools: unknown): number {
    if (!Array.isArray(tools)) return 0;
    let n = 0;
    for (const t of tools) {
        if (t && typeof t === "object" && (t as { cache_control?: unknown }).cache_control !== undefined) n++;
    }
    return n;
}

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
