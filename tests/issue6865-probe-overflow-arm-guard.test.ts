import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyProbeBaselineAnchor, getSession } from "../src/session.ts";

// #6865: the #5974 "corrective second pass" probe inside
// preflightCompressIfNeeded writes its local estimate onto
// session.stats.lastInputTokens WITHOUT an overflow-arm guard — so in the
// caliber-delta case (post-fold local probe slightly above the armed wall,
// but the payload actually fits) the probe demotes the ACTIVE overflow-arm
// tag to "estimate" BEFORE the #5880 fix's guarded post-rebuild anchor
// (applyPostRebuildBaselineAnchor, #5899) runs, and the #5880 guard (which
// checks for overflow-arm) no longer fires. The session then fit-forwards
// on a stale local estimate and sails past the upstream wall → 400
// CONTEXT_WINDOW_EXCEEDED → re-arm → repeat: the exact #5880 livelock,
// re-opened on a different code path.
//
// The guard lives in applyProbeBaselineAnchor (src/session.ts), mirroring
// the #5880 anchor's shape and doctrine (same as relay.ts #2484
// armFailureShrink): a probe estimate must never demote an armed
// overflow baseline. Pinned both directions (#3617):
//   armed → not demoted (the bug: probe above the armed wall leaves the
//          tag and the value untouched);
//   unarmed → demoted as before (estimate/usage/absent sources still take
//          the probe write when it is larger — the guard is
//          overflow-arm-only, exactly as the maintainer specified).

_setStoreForTest(new SessionStore({ enabled: false }));

function armSession(id: string, tokens: number, source: "usage" | "estimate" | "overflow-arm" | undefined) {
    const session = getSession(id);
    session.stats.lastInputTokens = tokens;
    if (source === undefined) delete session.stats.lastInputTokensSource;
    else session.stats.lastInputTokensSource = source;
    return session;
}

test("#6865 armed: a probe above the armed wall must NOT demote the overflow-arm tag", () => {
    const session = armSession("issue6865-armed", 35_000, "overflow-arm");
    applyProbeBaselineAnchor(session, 45_000);
    assert.equal(session.stats.lastInputTokens, 35_000, "the armed baseline value must survive the probe");
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm", "the overflow-arm tag must survive the probe");
});

test("#6865 armed with a smaller probe: no write either way", () => {
    const session = armSession("issue6865-armed-small-probe", 35_000, "overflow-arm");
    applyProbeBaselineAnchor(session, 30_000);
    assert.equal(session.stats.lastInputTokens, 35_000);
    assert.equal(session.stats.lastInputTokensSource, "overflow-arm");
});

test("#6865 unarmed (estimate): the probe write lands as before", () => {
    const session = armSession("issue6865-unarmed-estimate", 1_000, "estimate");
    applyProbeBaselineAnchor(session, 45_000);
    assert.equal(session.stats.lastInputTokens, 45_000, "an unarmed baseline still takes the larger probe");
    assert.equal(session.stats.lastInputTokensSource, "estimate");
});

test("#6865 unarmed (usage): the guard is overflow-arm-only, so a usage baseline still takes the probe write", () => {
    const session = armSession("issue6865-unarmed-usage", 1_000, "usage");
    applyProbeBaselineAnchor(session, 45_000);
    assert.equal(session.stats.lastInputTokens, 45_000);
    assert.equal(session.stats.lastInputTokensSource, "estimate");
});

test("#6865 unarmed (no source): the probe write lands as before", () => {
    const session = armSession("issue6865-unarmed-none", 1_000, undefined);
    applyProbeBaselineAnchor(session, 45_000);
    assert.equal(session.stats.lastInputTokens, 45_000);
    assert.equal(session.stats.lastInputTokensSource, "estimate");
});

test("#6865 probe at or below the baseline: no write on any source", () => {
    const equal = armSession("issue6865-equal", 45_000, "estimate");
    applyProbeBaselineAnchor(equal, 45_000);
    assert.equal(equal.stats.lastInputTokens, 45_000);
    assert.equal(equal.stats.lastInputTokensSource, "estimate");

    const below = armSession("issue6865-below", 45_000, "estimate");
    applyProbeBaselineAnchor(below, 40_000);
    assert.equal(below.stats.lastInputTokens, 45_000);
    assert.equal(below.stats.lastInputTokensSource, "estimate");
});
