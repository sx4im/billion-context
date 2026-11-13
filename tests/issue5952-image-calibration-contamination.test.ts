import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.js";
import assert from "node:assert/strict";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { currentCalibrationFactor } from "../src/util.ts";
import { noteCalibrationPair, settleOverflowCalibration, settleUsageReport, withCacheCapture } from "../src/cache-ledger.ts";

// #5952: image usage contaminates the text-only estimate calibration, and
// concurrent requests associate usage with another request's preparation
// estimate/model — the pending pair lived in one shared session slot
// (lastLocalTextEstimate, written at prepare time WITH the image reserve),
// so settlement paired a billed total against whatever request prepared
// last. The fix carries the request's own final-wire pair
// (text-only estimate, image count, origin, model) in the AsyncLocalStorage
// capture and settles from it; image-bearing samples never train the text
// multiplier (their mass is learned separately by #1843).

const testData = mkdtempSync(path.join(tmpdir(), "bili-5952-"));
const priorData = process.env.XDG_DATA_HOME;
const priorStorage = process.env.BILI_STORAGE_UNIFIED;
process.env.XDG_DATA_HOME = testData;
process.env.BILI_STORAGE_UNIFIED = "legacy";
_setStoreForTest(new SessionStore({ enabled: false }));
after(() => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    if (priorStorage === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = priorStorage;
    rmrf(testData);
});

let seq = 0;
const session = (): Session => ({ id: `issue5952-${++seq}`, metadata: {}, stats: {}, state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} } }) as unknown as Session;
const UPSTREAM = "https://upstream.example/v1";
const settle = (s: Session, total: number): void => settleUsageReport(s, { total, reportedCached: null, output: 1, upstream: UPSTREAM });
function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
}

test("text-only capture pairs train the multiplier from the request's own estimate", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        settle(s, 20_000);
    });
    assert.deepEqual(s.stats.calibrationRing?.values, [2]);
    assert.equal(s.stats.calibratedEstimate, undefined);
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        settle(s, 21_000);
    });
    assert.equal(s.stats.calibratedEstimate, 2.05);
    assert.equal(currentCalibrationFactor(s.stats, "m1"), 2.05);
});

test("image-bearing capture pairs never train the text multiplier", async () => {
    const s = session();
    for (const billed of [40_000, 42_000]) {
        await withCacheCapture(s, async () => {
            noteCalibrationPair(s, { estimate: 10_000, nImages: 2, origin: UPSTREAM, model: "m1" });
            settle(s, billed);
        });
    }
    assert.equal(s.stats.calibratedEstimate, undefined);
    assert.equal(s.stats.calibrationRing, undefined);
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        settle(s, 20_000);
    });
    // Read through a fresh alias: the assert.equal above narrows
    // s.stats.calibrationRing to undefined for the rest of this scope, so a
    // direct read would type the values access as `never`.
    const stats = s.stats;
    assert.deepEqual(stats.calibrationRing?.values, [2]);
});

test("overlapping captures settle against their own pair, never the other request's", async () => {
    const s = session();
    const readyA = gate(), readyB = gate(), doneA = gate(), doneB = gate();
    const runA = withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        readyA.open();
        await doneA.wait;
        assert.equal(s.stats.lastLocalTextEstimate, 50_000);
        settle(s, 20_000);
    });
    await readyA.wait;
    s.stats.lastLocalTextEstimate = 50_000;
    s.stats.lastLocalTextEstimateOrigin = UPSTREAM;
    const runB = withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 50_000, nImages: 2, origin: UPSTREAM, model: "m1" });
        readyB.open();
        await doneB.wait;
        settle(s, 200_000);
    });
    await readyB.wait;
    doneA.open();
    await runA;
    doneB.open();
    await runB;
    assert.deepEqual(s.stats.calibrationRing?.values, [2]);
    assert.equal(s.stats.calibratedEstimate, undefined);
});

test("a model switch in the capture pair starts a fresh ring", async () => {
    const s = session();
    for (const billed of [20_000, 21_000]) {
        await withCacheCapture(s, async () => {
            noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
            settle(s, billed);
        });
    }
    assert.equal(s.stats.calibratedEstimate, 2.05);
    assert.equal(s.stats.calibrationRing?.model, "m1");
    assert.equal(s.metadata.lastModel, undefined);
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m2" });
        settle(s, 30_000);
    });
    assert.deepEqual(s.stats.calibrationRing?.values, [3]);
    assert.equal(s.stats.calibrationRing?.model, "m2");
    assert.equal(s.stats.calibratedEstimate, undefined);
});

test("without a capture pair the shared prepare slot still trains, exactly as before", () => {
    const s = session();
    s.metadata.lastModel = "m1";
    for (const billed of [20_000, 21_000]) {
        s.stats.lastLocalTextEstimate = 10_000;
        s.stats.lastLocalTextEstimateOrigin = UPSTREAM;
        settle(s, billed);
    }
    assert.equal(s.stats.calibratedEstimate, 2.05);
});

test("overflow calibration skips image-bearing pairs and trains text-only pairs", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 1, origin: UPSTREAM, model: "m1" });
        settleOverflowCalibration(s, 40_000, UPSTREAM);
    });
    assert.equal(s.stats.calibrationRing, undefined);
    assert.equal(s.stats.calibratedEstimate, undefined);
    for (const measured of [20_000, 21_000]) {
        await withCacheCapture(s, async () => {
            noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
            settleOverflowCalibration(s, measured, UPSTREAM);
        });
    }
    assert.equal(s.stats.calibratedEstimate, 2.05);
});

test("a capture pair trains at most once", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        settle(s, 20_000);
        settle(s, 20_000);
    });
    assert.deepEqual(s.stats.calibrationRing?.values, [2]);
});

test("outside a capture the pair rides the last-sent fallback exactly once", () => {
    const s = session();
    noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
    settle(s, 20_000);
    assert.deepEqual(s.stats.calibrationRing?.values, [2]);
    settle(s, 20_000);
    assert.deepEqual(s.stats.calibrationRing?.values, [2]);
});

test("an aborted capture cannot leak its calibration pair into the next forward", async () => {
    const s = session();
    await assert.rejects(withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10_000, nImages: 0, origin: UPSTREAM, model: "m1" });
        throw new Error("synthetic abort");
    }), /synthetic abort/);
    await withCacheCapture(s, async () => {
        settle(s, 20_000);
    });
    assert.equal(s.stats.calibrationRing, undefined);
    assert.equal(s.stats.calibratedEstimate, undefined);
});
