import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "summary ".repeat(20);

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeSession(): Session {
    return {
        id: `issue6712-${randomUUID()}`,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

function makeCtx(messages: CoreMessage[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: defaultConfig(200000), messages, session, log: () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

// Two sub-gate small messages + six big ones (frontier m00008), mirroring the
// #2146 fixture. The issue's shape: every requested ref above the frontier
// after a mid-conversation model switch (refs restarted at m00001).
function fixtureMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("#6712: all-refs-above-frontier receipt preserves the offending refs (marked stale, not masked)", () => {
    const ctx = makeCtx(fixtureMessages());
    const out = applyRanges(parseCompressInput(compressArgs("m00222", "m00267")), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${out.slice(0, 120)})`);
    assert.match(out, /above this session's highest ref \(m00008\)/, "frontier diagnosis present");
    // The caller must be able to tell WHICH refs it used: the numbers survive,
    // marked (stale) so they cannot be copy-pasted as live targets.
    assert.match(out, /m00222\(stale\)/, "start ref preserved with stale marker");
    assert.match(out, /m00267\(stale\)/, "end ref preserved with stale marker");
    assert.match(out, /range m00222\(stale\)\.\.m00267\(stale\):/, "range diagnostic line names the refs");
    assert.match(out, /failing endpoints: startId=m00222\(stale\)/, "failing endpoint names the ref");
    assert.doesNotMatch(out, /\[stale-ref\]/, "the bare [stale-ref] token is gone — it destroyed the diagnostic value");
});

test("#6712: in-frontier failures keep refs verbatim and unmarked", () => {
    const ctx = makeCtx(fixtureMessages());
    const mixed = applyRanges(parseCompressInput(compressArgs("m00001", "m00009")), ctx).text;
    assert.ok(mixed.startsWith("[Compressed "), "an out-frontier endId clamps to the highest allocated ref instead of failing");
    assert.match(mixed, /m00009/, "the above-frontier endpoint stays verbatim (typo-correctable)");
    assert.doesNotMatch(mixed, /\(stale\)/, "no stale marker on a live-range receipt");
});
