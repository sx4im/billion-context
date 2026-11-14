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

function makeCtx(messages: CoreMessage[], config?: Config, logs?: string[]): RewriteCtx & { session: Session; config: Config } {
    const session = makeSession();
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    return { core: createCore(), config: config ?? defaultConfig(200000), messages, session, log: logs ? (m) => logs.push(m) : () => {} };
}

function compressArgs(startId: string, endId: string) {
    return JSON.parse(JSON.stringify({ content: [{ startId, endId, summary: SUMMARY }] }));
}

// Same fixture as #2146: refs m00001–m00008, highest mapped ref m00008.
function fixtureMessages(): CoreMessage[] {
    const msgs: CoreMessage[] = [
        textMsg("raw_1", "assistant", "a".repeat(800)),
        textMsg("raw_2", "assistant", "b".repeat(800)),
    ];
    for (let i = 3; i <= 8; i++) msgs.push(textMsg(`raw_${i}`, "assistant", "x".repeat(5000)));
    return msgs;
}

test("#6712: all-refs-above-frontier receipt keeps the offending refs quotable, marked stale", () => {
    const ctx = makeCtx(fixtureMessages());
    // The reporter's shape: every requested ref above the session frontier
    // (their m00222–m00267 above m00183 after a mid-conversation model switch).
    const out = applyRanges(parseCompressInput(compressArgs("m00010", "m00014")), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown refs fail (got: ${out.slice(0, 120)})`);
    assert.match(out, /above this session's highest ref \(m00008\)/, "frontier diagnosis present");
    // The offending refs stay in the receipt in number-preserving stale form,
    // so the caller can confirm what it asked for and quote it in a report.
    assert.match(out, /m00010\(stale\)/, "start ref stays quotable, marked stale");
    assert.match(out, /m00014\(stale\)/, "end ref stays quotable, marked stale");
    assert.match(out, /range m00010\(stale\)\.\.m00014\(stale\):/, "range diagnostic line keeps the numbers");
    // No bare phantom ref is echoed back as if it were a live ref (#2146),
    // and the old number-erasing token is gone.
    assert.doesNotMatch(out, /m00010(?!\()/, "no bare start ref in the receipt");
    assert.doesNotMatch(out, /m00014(?!\()/, "no bare end ref in the receipt");
    assert.doesNotMatch(out, /\[stale-ref\]/, "literal mask token is gone");
});

test("#6712: single-message range above the frontier marks the ref exactly once", () => {
    const ctx = makeCtx(fixtureMessages());
    const out = applyRanges(parseCompressInput(compressArgs("m00010", "m00010")), ctx).text;
    assert.ok(out.startsWith("[Compression FAILED:"), `unknown ref fails (got: ${out.slice(0, 120)})`);
    assert.match(out, /m00010\(stale\)/, "ref marked stale");
    assert.doesNotMatch(out, /m00010\(stale\)\(stale\)/, "no double marking on a repeated endpoint");
    assert.doesNotMatch(out, /\[stale-ref\]/, "literal mask token is gone");
});

test("#6712: mixed in-frontier/above-frontier ranges still keep endpoints verbatim", () => {
    const ctx = makeCtx(fixtureMessages());
    const out = applyRanges(parseCompressInput(compressArgs("m00001", "m00010")), ctx).text;
    assert.match(out, /m00010/, "the above-frontier endpoint stays verbatim (typo-correctable)");
    assert.doesNotMatch(out, /m00010\(stale\)/, "no stale marker when the range is not all-above-frontier");
    assert.doesNotMatch(out, /\[stale-ref\]/, "no mask token on a mixed range");
});
