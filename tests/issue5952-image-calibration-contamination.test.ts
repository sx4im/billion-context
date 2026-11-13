import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, type Session } from "../src/session.ts";
import { outboundPayloadBreakdown, preflightCompressIfNeeded, type Prepared } from "../src/server.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import {
    noteFinalWireCalibrationFacts,
    settleOverflowCalibration,
    settleUsageReport,
    withCacheCapture,
} from "../src/cache-ledger.ts";
import { CALIBRATION_TEXT_ONLY_PROVENANCE, currentCalibrationFactor } from "../src/util.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

// #5952: on 0.1.212 (DSH plugin lane) a request's usage containing images
// contaminated the text-only estimate calibration, and concurrent requests
// could associate usage with another request's preparation estimate/model —
// a stale mixed-modal multiplier then rejected the first request after a
// model switch even though the payload fit. The fix captures the request's
// own final-wire facts {imageTokens, estimate, origin, model} in the ALS
// capture, excludes image-bearing samples from text calibration, and
// requires text-only-v1 provenance for calibration multipliers and rings.

const ORIGIN = "http://a";
const MODEL = "gpt-x";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i5952-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

// Settle one usage report inside a capture carrying this request's own
// final-wire facts — the relay mainSend chokepoint's note, in miniature.
async function pairCaptured(
    s: Session,
    facts: { textEstimate: number; imageTokens: number; origin: string; model: string },
    billed: number,
): Promise<void> {
    await withCacheCapture(s, async () => {
        noteFinalWireCalibrationFacts(s, facts);
        settleUsageReport(s, { total: billed, reportedCached: null, upstream: facts.origin });
    });
}

// The pre-fix shared-stats path (no capture): prepare's pending pair.
function pairShared(s: Session, est: number, origin: string, billed: number, model?: string): void {
    if (model !== undefined) s.metadata = { lastModel: model };
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

test("image-bearing usage near the upper accepted range never trains the text multiplier", async () => {
    const s = makeSession();
    const st = s.stats;
    // Ratio 4.5 sits inside the [0.2, 5] plausibility band — pre-fix it
    // trained a k̂≈4.5 from two agreeing image-bearing samples.
    await pairCaptured(s, { textEstimate: 10_000, imageTokens: 17_000, origin: ORIGIN, model: MODEL }, 45_000);
    assert.equal(st.calibratedEstimate, undefined, "one image sample must not publish");
    // Snapshot the ring through its declared type before asserting it away:
    // asserting `st.calibrationRing` undefined directly would narrow the
    // property for the rest of the scope, and the provenance read below
    // would not typecheck (TS2339, `never`).
    const ringAfterImages: Session["stats"]["calibrationRing"] = st.calibrationRing;
    assert.equal(ringAfterImages, undefined, "an image sample must not touch the ring");
    await pairCaptured(s, { textEstimate: 20_000, imageTokens: 34_000, origin: ORIGIN, model: MODEL }, 90_000);
    assert.equal(st.calibratedEstimate, undefined, "two agreeing image samples must still not publish");
    const ringStillEmpty: Session["stats"]["calibrationRing"] = st.calibrationRing;
    assert.equal(ringStillEmpty, undefined, "the ring must stay empty after image samples");

    // Negative direction of the same gate: text-only samples still train.
    await pairCaptured(s, { textEstimate: 10_000, imageTokens: 0, origin: ORIGIN, model: MODEL }, 5_000);
    assert.equal(st.calibratedEstimate, undefined, "one text sample must not publish");
    await pairCaptured(s, { textEstimate: 20_000, imageTokens: 0, origin: ORIGIN, model: MODEL }, 11_000);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9, `expected mean 0.525, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_TEXT_ONLY_PROVENANCE);
    assert.equal(st.calibratedEstimateModel, MODEL);
    assert.equal(st.calibrationRing?.provenance, CALIBRATION_TEXT_ONLY_PROVENANCE);
});

test("interleaved captures: only the text request trains, on its own final-wire facts", async () => {
    const s = makeSession();
    const st = s.stats;
    // Prepare wrote the IMAGE request's facts last into the shared stats
    // (text 10_000 + image reserve 17_000) — the pre-fix settle read these.
    s.stats.lastLocalTextEstimate = 27_000;
    s.stats.lastLocalTextEstimateOrigin = ORIGIN;
    s.metadata.lastModel = MODEL;

    await withCacheCapture(s, async () => {
        // Text request's own final-wire facts.
        noteFinalWireCalibrationFacts(s, { textEstimate: 10_000, imageTokens: 0, origin: ORIGIN, model: MODEL });
        await withCacheCapture(s, async () => {
            // Image request settles first, while the text request is in flight.
            noteFinalWireCalibrationFacts(s, { textEstimate: 10_000, imageTokens: 17_000, origin: ORIGIN, model: MODEL });
            settleUsageReport(s, { total: 45_000, reportedCached: null, upstream: ORIGIN });
            assert.equal(st.calibratedEstimate, undefined, "image settle must not publish");
            assert.ok(st.calibrationRing === undefined, "image settle must not touch the ring");
        });
        // Another request's prepare overwrote the shared stats after this
        // request's final wire estimation — the settle must ignore it.
        s.stats.lastLocalTextEstimate = 99_999;
        s.stats.lastLocalTextEstimateOrigin = ORIGIN;
        settleUsageReport(s, { total: 5_000, reportedCached: null, upstream: ORIGIN });
        assert.deepEqual(st.calibrationRing?.values, [0.5], "the text settle must pair with its own captured estimate, not the overwritten shared stats");
        assert.equal(st.calibratedEstimate, undefined, "one text sample must not publish");
    });

    // A second agreeing text sample publishes — from text-only evidence only.
    await pairCaptured(s, { textEstimate: 20_000, imageTokens: 0, origin: ORIGIN, model: MODEL }, 11_000);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9, `expected mean 0.525, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_TEXT_ONLY_PROVENANCE);
    assert.deepEqual(st.calibrationRing?.values, [0.5, 0.55]);
});

test("overflow measurement pairs with the capture facts, not the shared pending pair", async () => {
    const s = makeSession();
    const st = s.stats;
    // The shared pending pair is the stale prepare-time estimate; the
    // capture carries this rejected body's own final-wire text estimate.
    s.stats.lastLocalTextEstimate = 27_000;
    s.stats.lastLocalTextEstimateOrigin = ORIGIN;
    s.metadata.lastModel = MODEL;
    await withCacheCapture(s, async () => {
        noteFinalWireCalibrationFacts(s, { textEstimate: 10_000, imageTokens: 0, origin: ORIGIN, model: MODEL });
        settleOverflowCalibration(s, 5_000, ORIGIN);
    });
    assert.deepEqual(st.calibrationRing?.values, [0.5], "overflow must pair the measured count with the captured text estimate");
    assert.equal(st.lastLocalTextEstimate, undefined, "the consumed pair still retires");

    // An image-bearing overflow must not teach the text ring either.
    const s2 = makeSession();
    await withCacheCapture(s2, async () => {
        noteFinalWireCalibrationFacts(s2, { textEstimate: 10_000, imageTokens: 17_000, origin: ORIGIN, model: MODEL });
        settleOverflowCalibration(s2, 45_000, ORIGIN);
    });
    assert.ok(s2.stats.calibrationRing === undefined, "image-bearing overflow must not touch the ring");
});

test("settles outside any capture keep the shared-stats fallback", () => {
    const s = makeSession();
    const st = s.stats;
    // Lanes without capture facts (plugin usage lane) train exactly as
    // before — the fallback is unchanged, only now stamped text-only-v1.
    pairShared(s, 10_000, ORIGIN, 5_000, MODEL);
    pairShared(s, 20_000, ORIGIN, 11_000, MODEL);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 0.525) < 1e-9, `expected mean 0.525, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_TEXT_ONLY_PROVENANCE);
});

test("currentCalibrationFactor: a factor without text-only-v1 provenance acts as absent", () => {
    // The incident's stale multiplier: published pre-fix from mixed-modal
    // samples, no provenance recorded — it must not decide preflight.
    const legacy = { calibratedEstimate: 4, calibratedEstimateOrigin: ORIGIN, calibratedEstimateModel: MODEL };
    assert.equal(currentCalibrationFactor(legacy, MODEL), undefined);
    assert.equal(currentCalibrationFactor(legacy, undefined), undefined);
    // The same factor re-published from text-only evidence applies.
    const stamped = { ...legacy, calibratedEstimateProvenance: CALIBRATION_TEXT_ONLY_PROVENANCE };
    assert.equal(currentCalibrationFactor(stamped, MODEL), 4);
    assert.equal(currentCalibrationFactor(stamped, undefined), 4, "missing model info still keeps a provenanced factor (#2117)");
    assert.equal(currentCalibrationFactor(stamped, "gpt-y"), undefined, "cross-model provenanced factors still act as absent (#2117)");
    // A bogus provenance value is not the stamp.
    assert.equal(currentCalibrationFactor({ ...legacy, calibratedEstimateProvenance: "text-only-v2" }, MODEL), undefined);
});

// --- Regression shape step 3: preflight with a stale multiplier of 4 ---
// Unchanged messages, window 262144 scale (windowRatio 1.5: raw fits, 4x
// does not), system/tool overhead 22000, image reserve 17000 — the incident
// numbers, scaled to the harness. A legacy k̂=4 must NOT reject the payload;
// the same k̂ stamped text-only-v1 MUST still reject it (both directions).

async function runPreflight(s: { k: number; provenance?: string }) {
    let summaryCalls = 0;
    const summary = "An unusably growing summary. ".repeat(6000);
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            summaryCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/responses`;
    const session = getSession(`i5952-preflight-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(10_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the goal and acceptance criteria." },
        { id: "output", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue." },
    ];
    const input: unknown[] = messages.map(m => ({ role: m.role, content: m.text }));
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", stream: true, input }),
        session, processedMessages: messages,
        originalMessages: messages, protocol: "responses", stream: true,
        compressInjected: false, pluginMode: false,
    };
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: config.modelContextLimit, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const route = { upstream: url, rewrittenUrl: url };
    const parts = outboundPayloadBreakdown(prepared, opts, route, "/responses");
    const rawText = parts.textEstimate + parts.overheadEstimate;
    const limit = Math.ceil(rawText * 1.5);
    config.modelContextLimit = limit;
    opts.modelContextLimit = limit;
    session.stats.lastInputTokens = Math.ceil(limit * 1.05);
    session.stats.lastInputTokensSource = "usage";
    session.stats.lastInputTokensOrigin = origin;
    session.stats.calibratedEstimate = s.k;
    session.stats.calibratedEstimateOrigin = origin;
    session.stats.calibratedEstimateModel = "test-model";
    if (s.provenance !== undefined) session.stats.calibratedEstimateProvenance = s.provenance;
    session.metadata.lastModel = "test-model";
    const turn = core.processTurn({ messages, state: session.state, config,
        tokenCount: Math.ceil(limit * 1.05), renderTags: "text-only" });
    prepared.nudge = turn.nudge ?? undefined;
    assert.ok((prepared.nudge?.compressibleRanges.length ?? 0) > 0, "fixture needs an advertised candidate");
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = "/responses";
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const logs: string[] = [];
    let rebuilds = 0;
    try {
        const result = await preflightCompressIfNeeded(prepared, async () => {
            rebuilds++;
            return prepared;
        }, req, Buffer.from(prepared.body), res, opts, core, config, limit,
        "test-model", undefined, undefined, route, undefined, false,
        (_level, msg) => logs.push(msg), "i5952-preflight");
        assert.equal(rebuilds, 0, "a rejected or unnecessary summary cannot rebuild the payload");
        assert.equal(session.state.blocks.length, 0, "no growing summary may land");
        assert.ok(logs.some(line => line.includes("preflight compressing before forward")), "must exercise preflight");
        return { result, prepared, logs, summaryCalls, rawText, limit };
    } finally {
        const closed = once(upstream, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        upstream.closeAllConnections();
        await closed;
        req.destroy();
        res.destroy();
    }
}

test("preflight: stale legacy multiplier 4 does not reject a fitting payload", { timeout: 15_000 }, async () => {
    const f = await runPreflight({ k: 4 });
    assert.ok(f.rawText < f.limit && f.rawText * 4 > f.limit, `fixture must fit raw but not at 4x (raw ${f.rawText}, limit ${f.limit})`);
    assert.ok(f.result === f.prepared, JSON.stringify(f.logs));
});

test("preflight: the same multiplier stamped text-only-v1 still rejects it", { timeout: 15_000 }, async () => {
    const f = await runPreflight({ k: 4, provenance: CALIBRATION_TEXT_ONLY_PROVENANCE });
    assert.ok(f.rawText < f.limit && f.rawText * 4 > f.limit, `fixture must fit raw but not at 4x (raw ${f.rawText}, limit ${f.limit})`);
    assert.ok("failFast" in f.result, JSON.stringify(f.logs));
    assert.ok(f.summaryCalls > 0, "must reject a growing summary, not bypass the walk");
});
