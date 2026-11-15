/**
 * #6829: pi-web-access 0.46+ breaks the #2435 coexistence path, then the
 * #1662 fallback sends inline-origin traffic to real DNS.
 *
 * pi-web-access 0.46.0 stopped setting `__piWebAccessProxyFetch`
 * unconditionally and marks its wrapper `__piWebAccessSharedProxyFetch`
 * instead (propagating the old flag only when the wrapped fetch already has
 * it). bili never reads the new name, so the coexist branch is unreachable.
 * Worse, the #1662 escape in the older chain link cannot see the wrapper at
 * all: it checks the flag on `ds` (the link BELOW it), while the wrapper sits
 * ABOVE it — so the pending request is handed to the oldest live anchor, the
 * host's native fetch, which DNS-resolves `billion-context.inline` and dies
 * with ENOTFOUND.
 *
 * Fix (this branch): recognize the re-entering wrapper by identity, not by
 * what sits below the link. At depth 1 the `chainHop` store IS the foreign
 * wrapper that re-entered our chain; when it is a recognized pi-web-access
 * wrapper (either flag name) and the request targets the inline pseudo-origin
 * — the one origin the anchor can never serve — stay in the chain (`send`)
 * instead of terminating at the anchor, so the request reaches the inline
 * transport and is served in-process. Deliberately NOT a blanket
 * pseudo-origin guard: an inline request re-entering through an UNKNOWN
 * wrapper still takes the anchor path (pre-existing behavior, unchanged).
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { installFetchChain, resetFetchChainForTest } from "../src/agent/fetch-chain/index.ts";
import { INLINE_ORIGIN } from "../src/inline-engine.ts";

const MODEL_URL = `${INLINE_ORIGIN}/bili/https://api.anthropic.com/v1/messages`;
const EXTERNAL_URL = "https://api.anthropic.com/v1/messages";

const originalDesc = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const originalFetch = globalThis.fetch;

interface Harness {
    anchorSeen: string[];
    outerDispatches: number;
    inlineServed: number;
}

/** A fake host fetch (the module anchor): records every URL it is asked to
 *  fetch and answers 200. In the real world this is the host's native fetch,
 *  which DNS-resolves `billion-context.inline` and throws ENOTFOUND. */
function makeAnchor(seen: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
        seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return new Response("anchor");
    }) as typeof fetch;
}

/** Fake pi-web-access 0.46+ wrapper: marks itself ONLY with the new shared
 *  flag and delegates to the fetch it wrapped. */
function piWebAccess046(wrapped: typeof fetch): typeof fetch {
    const wrapper = (async (input: string | URL | Request, init?: RequestInit) => wrapped(input, init)) as typeof fetch;
    Object.defineProperty(wrapper, "__piWebAccessSharedProxyFetch", { value: true });
    return wrapper;
}

/** Fake pi-web-access <= 0.45 wrapper: marks itself with the old flag. */
function piWebAccess045(wrapped: typeof fetch): typeof fetch {
    const wrapper = (async (input: string | URL | Request, init?: RequestInit) => wrapped(input, init)) as typeof fetch;
    Object.defineProperty(wrapper, "__piWebAccessProxyFetch", { value: true });
    return wrapper;
}

/** Two chain links in the pi-native shape: an inner link that serves
 *  INLINE_ORIGIN traffic in-process (the inline transport) and an outer link
 *  that counts dispatches and forwards (the native intercept). */
function installTwoLinks(h: Harness): void {
    installFetchChain((send) => async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(INLINE_ORIGIN)) {
            h.inlineServed += 1;
            return new Response("inline");
        }
        return send(input, init);
    });
    installFetchChain((send) => async (input, init) => {
        h.outerDispatches += 1;
        return send(input, init);
    });
}

function setup(): Harness {
    const h: Harness = { anchorSeen: [], outerDispatches: 0, inlineServed: 0 };
    const anchor = makeAnchor(h.anchorSeen);
    globalThis.fetch = anchor;
    resetFetchChainForTest({ anchor });
    installTwoLinks(h);
    return h;
}

function teardown(): void {
    resetFetchChainForTest();
    if (originalDesc !== undefined) Object.defineProperty(globalThis, "fetch", originalDesc);
    else globalThis.fetch = originalFetch;
}

test("#6829: 0.46 wrapper above the chain serves inline-origin traffic in-process", async () => {
    const h = setup();
    try {
        globalThis.fetch = piWebAccess046(globalThis.fetch);
        const res = await globalThis.fetch(MODEL_URL, { method: "POST" });
        assert.equal(await res.text(), "inline", "inline-origin model request must be served in-process");
        assert.equal(h.inlineServed, 1, "the inline transport dispatch ran once");
        assert.equal(h.outerDispatches, 1, "the outer dispatch ran exactly once");
        assert.deepEqual(h.anchorSeen, [], "the anchor must never see an inline-origin URL");
    } finally {
        teardown();
    }
});

test("#6829: 0.46 wrapper installed before the chain serves inline-origin traffic in-process", async () => {
    const h: Harness = { anchorSeen: [], outerDispatches: 0, inlineServed: 0 };
    const anchor = makeAnchor(h.anchorSeen);
    globalThis.fetch = piWebAccess046(anchor);
    resetFetchChainForTest({ anchor });
    installTwoLinks(h);
    try {
        const res = await globalThis.fetch(MODEL_URL, { method: "POST" });
        assert.equal(await res.text(), "inline", "inline-origin model request must be served in-process");
        assert.equal(h.inlineServed, 1, "the inline transport dispatch ran once");
        assert.deepEqual(h.anchorSeen, [], "the anchor must never see an inline-origin URL");
    } finally {
        teardown();
    }
});

test("#6829: 0.46 wrapper below the chain + unknown wrapper above still serves inline-origin traffic in-process", async () => {
    const h: Harness = { anchorSeen: [], outerDispatches: 0, inlineServed: 0 };
    const anchor = makeAnchor(h.anchorSeen);
    globalThis.fetch = piWebAccess046(anchor);
    resetFetchChainForTest({ anchor });
    installTwoLinks(h);
    try {
        // A second, unknown plugin re-wraps the chain from above: the older
        // link's depth-1 branch must see the 0.46 wrapper below it (through
        // the chain's marker passthrough) and stay in the chain.
        const base = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
        const res = await globalThis.fetch(MODEL_URL, { method: "POST" });
        assert.equal(await res.text(), "inline", "inline-origin model request must be served in-process");
        assert.equal(h.inlineServed, 1, "the inline transport dispatch ran once");
        assert.deepEqual(h.anchorSeen, [], "the anchor must never see an inline-origin URL");
    } finally {
        teardown();
    }
});

test("#6829: 0.45 wrapper above the chain keeps serving inline-origin traffic in-process", async () => {
    const h = setup();
    try {
        globalThis.fetch = piWebAccess045(globalThis.fetch);
        const res = await globalThis.fetch(MODEL_URL, { method: "POST" });
        assert.equal(await res.text(), "inline", "inline-origin model request must be served in-process");
        assert.equal(h.inlineServed, 1, "the inline transport dispatch ran once");
        assert.deepEqual(h.anchorSeen, [], "the anchor must never see an inline-origin URL");
    } finally {
        teardown();
    }
});

test("#6829: unknown wrapper above the chain still terminates external traffic at the anchor (#1662 preserved)", async () => {
    const h = setup();
    try {
        const base = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => base(input, init)) as typeof fetch;
        const res = await globalThis.fetch(EXTERNAL_URL, { method: "POST" });
        assert.equal(await res.text(), "anchor", "external traffic still terminates at the anchor");
        assert.deepEqual(h.anchorSeen, [EXTERNAL_URL], "the anchor saw the external URL exactly once");
        assert.equal(h.outerDispatches, 1, "the outer dispatch ran exactly once");
    } finally {
        teardown();
    }
});

test("#6829: 0.46 wrapper above the chain still lets external traffic reach the anchor once", async () => {
    const h = setup();
    try {
        globalThis.fetch = piWebAccess046(globalThis.fetch);
        const res = await globalThis.fetch(EXTERNAL_URL, { method: "POST" });
        assert.equal(await res.text(), "anchor", "external traffic reaches the anchor");
        assert.deepEqual(h.anchorSeen, [EXTERNAL_URL], "the anchor saw the external URL exactly once");
        assert.equal(h.outerDispatches, 1, "the outer dispatch ran exactly once");
    } finally {
        teardown();
    }
});
