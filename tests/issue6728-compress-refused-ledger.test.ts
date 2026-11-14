// #6728: policy-gate REFUSED receipts (compress.requireNudge /
// requireRecommendation) charged nothing to the compress failure ledger —
// neither recordCompressFailure (#4812 short receipt) nor
// noteCompressLoopFailure (#2146/#847 circuit breaker) — so a model
// re-submitting a range bili will never fold got byte-identical refusals
// forever (9 consecutive verbatim refusals in 125 s in the reported pi
// session) and the breaker never armed. Pinned here: both gate branches
// charge both ledgers, the breaker arms on the 3rd identical refusal, the
// repeat collapses to a one-liner from the 2nd, an empty recommendation set
// gets terminal wording instead of a dead-end acp_status pointer, and the
// preflight lane (loopTracking:false) still charges nothing. Gate
// discipline (#3617): BOTH directions asserted per gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage, CompressibleRange, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
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

const OUT_OF_OFFER = { content: [{ startId: "m00005", endId: "m00007", summary: SUM }] };
const IN_OFFER = { content: [{ startId: "m00001", endId: "m00004", summary: SUM }] };

test("#6728: requireRecommendation refusals charge the ledger — breaker arms on the 3rd identical refusal", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: false, requireRecommendation: true });
    const receipts = Array.from({ length: 8 }, () => runApply(ctx, OUT_OF_OFFER));
    assert.ok(receipts[0].startsWith("[Compression REFUSED"), `call 1 must be the full refusal, got: ${receipts[0].slice(0, 160)}`);
    assert.ok(receipts[0].includes("requireRecommendation"), "call 1 names the knob:\n" + receipts[0]);
    assert.ok(receipts[0].includes("m00005–m00007"), "call 1 names the offending span:\n" + receipts[0]);
    assert.ok(!receipts[0].includes("CIRCUIT BREAKER"), "call 1 is pre-arm");
    assert.ok(receipts[1].startsWith("[Compression REFUSED again"), `call 2 collapses to the one-liner, got: ${receipts[1].slice(0, 160)}`);
    assert.ok(receipts[1].includes("2 time(s)"), "one-liner counts the repeats:\n" + receipts[1]);
    assert.ok(!receipts[1].includes("CIRCUIT BREAKER"), "call 2 is pre-arm");
    assert.ok(receipts[2].includes("CIRCUIT BREAKER"), "call 3 arms the breaker:\n" + receipts[2]);
    assert.ok(receipts[2].includes("STOP calling compress"), "arm-moment receipt orders a full stop:\n" + receipts[2]);
    assert.ok(compressBreakerArmed(ctx.session), "breaker armed after 3 consecutive refusals");
    assert.ok(receipts[7].startsWith("[Compression REFUSED again"), `call 8 stays collapsed, got: ${receipts[7].slice(0, 160)}`);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

test("#6728: requireNudge refusals charge the ledger — breaker arms on the 3rd identical refusal", () => {
    const ctx = freshCtx();
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: true, requireRecommendation: false });
    const receipts = Array.from({ length: 8 }, () => runApply(ctx, IN_OFFER));
    assert.ok(receipts[0].startsWith("[Compression REFUSED"), `call 1 must be the full refusal, got: ${receipts[0].slice(0, 160)}`);
    assert.ok(receipts[0].includes("requireNudge"), "call 1 names the knob:\n" + receipts[0]);
    assert.ok(receipts[1].startsWith("[Compression REFUSED again"), `call 2 collapses to the one-liner, got: ${receipts[1].slice(0, 160)}`);
    assert.ok(receipts[1].includes("2 time(s)"), "one-liner counts the repeats:\n" + receipts[1]);
    assert.ok(receipts[2].includes("CIRCUIT BREAKER"), "call 3 arms the breaker:\n" + receipts[2]);
    assert.ok(compressBreakerArmed(ctx.session), "breaker armed after 3 consecutive refusals");
    assert.ok(receipts[7].startsWith("[Compression REFUSED again"), `call 8 stays collapsed, got: ${receipts[7].slice(0, 160)}`);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

test("#6728: preflight lane (loopTracking:false) charges nothing — the scope gate is bypassed", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: true, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, OUT_OF_OFFER, { loopTracking: false });
    assert.ok(out.startsWith("[Compressed"), `preflight self-save must stay available, got: ${out.slice(0, 160)}`);
    assert.ok(!compressBreakerArmed(ctx.session), "no streak recorded on the preflight lane");
    assert.equal(ctx.session.metadata["compressFailKeys"], undefined, "spec ledger untouched");
    assert.equal(ctx.session.metadata["compressFailStreak"], undefined, "loop ledger untouched");
});

test("#6728: empty recommendation set — refusal is terminal, no dead-end acp_status advice", () => {
    const ctx = freshCtx();
    ctx.session.state.deadRefs = ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006", "m00007"];
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, IN_OFFER);
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("No compressible ranges remain"), "terminal wording replaces the pointer:\n" + out);
    assert.ok(!out.includes("Call acp_status"), "no dead-end advice when nothing is recommended:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});

test("#6728: non-empty recommendation set keeps the acp_status advice", () => {
    const ctx = freshCtx();
    setOffer(ctx, [offerRange("m00001", "m00004", 4)]);
    storeUnpromptedGate(ctx.session, { nudgeInjected: false, requireNudge: false, requireRecommendation: true });
    const out = runApply(ctx, OUT_OF_OFFER);
    assert.ok(out.startsWith("[Compression REFUSED"), `expected refusal, got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("Call acp_status"), "live advice when ranges remain:\n" + out);
    assert.ok(!out.includes("No compressible ranges remain"), "no terminal wording while ranges remain:\n" + out);
    assert.equal(ctx.session.state.blocks.length, 0, "nothing folded");
});
