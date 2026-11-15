/**
 * #6829: pi-web-access 0.46+ breaks the #2435 coexistence path, then the
 * #1662 fallback sends inline-origin traffic to real DNS.
 *
 * From 0.46.0 pi-web-access only propagates `__piWebAccessProxyFetch` when
 * the wrapped fetch already has it and uses `__piWebAccessSharedProxyFetch`
 * for itself, so bili's #2435 coexist branch is unreachable and every
 * re-wrap falls into the generic re-chain. The #1662 escape then hands the
 * pending request to the oldest live fetch WITHOUT checking URL origin — for
 * bili's own `http://billion-context.inline/bili/...` URLs that means a real
 * DNS lookup, i.e. a guaranteed ENOTFOUND, and every model call dies until
 * the host process restarts.
 *
 * Fix (origin guard, #6829 suggestion 1): in the #1662 escape, INLINE_ORIGIN
 * traffic must never reach the anchor — the pseudo-origin is served
 * in-process by the inline transport and can never DNS-resolve. Route it
 * down the chain instead, where the inline transport serves it. Non-inline
 * traffic keeps the existing anchor escape.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { installFetchChain, resetFetchChainForTest } from "../src/agent/fetch-chain/index.ts";
import { INLINE_ORIGIN } from "../src/inline-engine.ts";

// Hermetic posture (same as native-intercept-selfheal.test.ts): logHostEvent
// writes to bili.log — point XDG_STATE_HOME at a throwaway dir for the life
// of the file (node --test runs each file in its own process).
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-6829-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const MODEL_URL = `${INLINE_ORIGIN}/bili/https://api.anthropic.com/v1/messages`;
const EXTERNAL_URL = "https://registry.npmjs.org/billion-context";

function urlOf(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

/** Host native fetch: records every URL it is asked to fetch. It throws a
 *  DNS-style error for the pseudo-origin — exactly what the real host fetch
 *  does, since billion-context.inline never resolves. */
function makeNativeFetch(sink: string[]): typeof globalThis.fetch {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        const url = urlOf(input);
        sink.push(url);
        if (url.startsWith(INLINE_ORIGIN)) {
            const err = new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`) as Error & { code?: string };
            err.code = "ENOTFOUND";
            throw err;
        }
        return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
}

async function withChain<T>(fn: (ctx: { nativeSink: string[] }) => Promise<T>): Promise<T> {
    const saved = globalThis.fetch;
    const nativeSink: string[] = [];
    const nativeFetch = makeNativeFetch(nativeSink);
    globalThis.fetch = nativeFetch;
    resetFetchChainForTest({ anchor: nativeFetch });
    // Innermost link: the inline transport shape — serve INLINE_ORIGIN
    // in-process, pass everything else down to the host fetch.
    installFetchChain((send) => async (input, init) => {
        const url = urlOf(input);
        if (url.startsWith(INLINE_ORIGIN)) {
            return new Response("inline-served", { status: 200 });
        }
        return send(input, init);
    });
    // Outer link: a pass-through dispatch (the native intercept shape).
    installFetchChain((send) => async (input, init) => send(input, init));
    // pi-web-access 0.46 shape: re-wraps the current top, carries ONLY the
    // new flag — bili's #2435 recognition (old flag) never fires.
    const capturedTop = globalThis.fetch;
    const webAccess046 = Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => capturedTop(input, init),
        { __piWebAccessSharedProxyFetch: true },
    ) as typeof globalThis.fetch;
    globalThis.fetch = webAccess046;
    try {
        return await fn({ nativeSink });
    } finally {
        // Restore the saved fetch WITHOUT tripping the guard accessor:
        // defineProperty bypasses the setter.
        Object.defineProperty(globalThis, "fetch", { value: saved, writable: true, configurable: true, enumerable: true });
        resetFetchChainForTest();
    }
}

test("#6829: inline-origin model traffic survives a pi-web-access 0.46 re-wrap", async () => {
    await withChain(async ({ nativeSink }) => {
        const res = await globalThis.fetch(MODEL_URL, { method: "POST", body: "{}" });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "inline-served");
        // The anchor (real DNS) must never see the pseudo-origin.
        assert.deepEqual(nativeSink, []);
    });
});

test("#6829: non-inline traffic still takes the #1662 anchor escape", async () => {
    await withChain(async ({ nativeSink }) => {
        const res = await globalThis.fetch(EXTERNAL_URL);
        assert.equal(res.status, 200);
        assert.deepEqual(nativeSink, [EXTERNAL_URL]);
    });
});
