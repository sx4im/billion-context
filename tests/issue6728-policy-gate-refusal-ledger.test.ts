// #6728: policy-gate REFUSED receipts (compress.requireNudge /
// requireRecommendation) charge no failure ledger — endless byte-identical
// refusals, breaker never arms. The two gate branches in applyRanges return
// before any ledger call, unlike every other reject path. This file pins the
// fix: both gate refusals charge the #4812 spec-repeat ledger AND the
// #2146/#847 loop streak, so the 3rd consecutive refusal carries the
// circuit-breaker paragraph; and a scope-gate refusal with an EMPTY
// recommendation set uses terminal wording instead of the dead-end
// "call acp_status and stay within them" advice.
// Harness mirrors tests/issue5683-forbid-unprompted-compress.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressibleRange, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { liveCompressionRanges } from "../src/acp-status.js";
import { applyRanges, compressBreakerArmed, type RewriteCtx } from "../src/stream.ts";
import { storeUnpromptedGate } from "../src/unprompted-gate.ts";

const SUM = "SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK-XYZ";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "issue6728-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 100000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

/** Nine 5000-char messages; preserveRecentMessages 2 keeps m8-m9 protected,
 *  so m1-m7 are the live fold space. */
function freshCtx(): Ctx {
    const msgs = Array.from({ length: 9 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", "x".repeat(5000)));
    return withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
}

function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}

function setOffer(ctx: Ctx, ranges: CompressibleRange[]): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier: null } as unknown as NudgeDecision;
}

function runApply(ctx: Ctx, args: unknown, opts?: { loopTracking?: boolean }): string {
    return applyRanges(parseCompressInput(args), ctx, opts).text;
}

// ---------------------------------------------------------------------------
// requireRecommendation — scope gate refusals charge the ledgers.
// ---------------------------------------------------------------------------

test("#6728: scope-gate refusal charges the failure ledger — breaker arms by the 3rd identical refusal", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: false, requireRecommendation: true });
    const args = { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] };
    const first = runApply(ctx, args);
    assert.ok(first.startsWith("[Compression REFUSED"), `expected refusal, got: ${first.slice(0, 160)}`);
    assert.ok(!first.includes("COMPRESS CIRCUIT BREAKER"), "first refusal must not carry the breaker text:\n" + first);
    assert.equal(compressBreakerArmed(ctx.session), false, "breaker must not arm on one refusal");

    const second = runApply(ctx, args);
    assert.notEqual(second, first, "2nd identical refusal must not be byte-identical to the 1st");

    const third = runApply(ctx, args);
    assert.ok(third.includes("COMPRESS CIRCUIT BREAKER"), "3rd consecutive refusal must carry the breaker paragraph:\n" + third);
    assert.equal(compressBreakerArmed(ctx.session), true, "breaker must arm after 3 consecutive gate refusals");
});

test("#6728: scope-gate refusal — first receipt keeps the acp_status advice when ranges ARE recommended", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] });
    assert.ok(out.includes("Call acp_status for the current compressible ranges"), "non-empty offer keeps the acp_status advice:\n" + out);
});

// ---------------------------------------------------------------------------
// requireNudge — timing gate refusals charge the ledgers.
// ---------------------------------------------------------------------------

test("#6728: nudge-gate refusal charges the failure ledger — breaker arms by the 3rd identical refusal", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    const args = { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] };
    const first = runApply(ctx, args);
    assert.ok(first.startsWith("[Compression REFUSED"), `expected refusal, got: ${first.slice(0, 160)}`);
    assert.ok(first.includes("requireNudge"), "receipt names the knob:\n" + first);
    assert.ok(!first.includes("COMPRESS CIRCUIT BREAKER"), "first refusal must not carry the breaker text");
    assert.equal(compressBreakerArmed(ctx.session), false, "breaker must not arm on one refusal");

    const second = runApply(ctx, args);
    assert.notEqual(second, first, "2nd identical refusal must not be byte-identical to the 1st");

    const third = runApply(ctx, args);
    assert.ok(third.includes("COMPRESS CIRCUIT BREAKER"), "3rd consecutive refusal must carry the breaker paragraph:\n" + third);
    assert.equal(compressBreakerArmed(ctx.session), true, "breaker must arm after 3 consecutive gate refusals");
});

// ---------------------------------------------------------------------------
// Terminal wording — empty recommendation set is a dead end for the advice.
// ---------------------------------------------------------------------------

test("#6728: scope-gate refusal with an EMPTY recommendation set uses terminal wording, not the acp_status dead end", () => {
    const ctx = freshCtx();
    // Kill every candidate: the live recommendation set is empty.
    ctx.session.state.deadRefs = ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006", "m00007"];
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] });
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("requireRecommendation"), "receipt names the knob:\n" + out);
    assert.ok(out.includes("genuinely new content to fold"), "empty-set refusal must use terminal wording:\n" + out);
    assert.ok(!out.includes("Call acp_status for the current compressible ranges and stay within them"), "empty-set refusal must not point at an empty set:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

// ---------------------------------------------------------------------------
// Negative directions (#3617): preflight stays exempt, single refusal stays quiet.
// ---------------------------------------------------------------------------

test("#6728: preflight lane (loopTracking:false) charges nothing — gate bypassed, success clears nothing it never recorded", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] }, { loopTracking: false });
    assert.ok(out.startsWith("[Compressed"), `preflight self-save must stay available, got: ${out.slice(0, 160)}`);
    assert.equal(ctx.session.metadata["compressFailKeys"], undefined, "preflight must not charge the spec-repeat ledger");
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "preflight must not charge the loop streak");
    assert.equal(compressBreakerArmed(ctx.session), false, "preflight must not arm the breaker");
});

test("#6728: one gate refusal does not arm the breaker and does not repeat-guard (both gates)", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] });
    assert.ok(!out.includes("Repeat-failure guard"), "first refusal carries no repeat guard:\n" + out);
    assert.ok(!out.includes("COMPRESS CIRCUIT BREAKER"), "first refusal carries no breaker text");
    assert.equal(compressBreakerArmed(ctx.session), false);
});
