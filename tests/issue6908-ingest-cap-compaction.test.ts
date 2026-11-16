// #6908: the 32 MiB ingest cost is measured against the PRE-folding inbound
// body. The dsh plugin lane re-sends the full history every round, so a normal
// session folded down to 446 KiB outbound still carries a 32 MiB inbound — and
// once inbound passes the band, EVERY round 413s BEFORE JSON.parse, so the
// request never reaches isDshCompactionCall and the session SELF-LOCKS: the
// only action that could shrink the host history (a compaction call) is itself
// a full-history inbound body. The fix is ORDERING: a compaction call must be
// recognised before the ingest cap rejects the body. This suite pins both
// directions with a small band (1 MiB) so the over-cap body stays a few MiB:
// a compaction call over the band must reach the #1729 guard (422 refusal,
// zero upstream calls), an ordinary over-band body must still 413 at ingest,
// and a body that merely QUOTES the instruction mid-history must still 413
// (the recognition is the full marker-decisive check, not a raw substring).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// 1 MiB test band. node:test can run several files in ONE process (the CI
// test lanes do), so the band is armed per-test and RESTORED in finally.
const TEST_BAND = 1024 * 1024;
function armIngestBand(): () => void {
    const prev = process.env.BILI_INGEST_BODY_BYTES;
    process.env.BILI_INGEST_BODY_BYTES = String(TEST_BAND);
    return () => {
        if (prev === undefined) delete process.env.BILI_INGEST_BODY_BYTES;
        else process.env.BILI_INGEST_BODY_BYTES = prev;
    };
}

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

const WINDOW = 20_000;

type Call = { bytes: number };

function chatSse(text: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 3 } }) + "data: [DONE]\n\n";
}

function makeUpstream(): { server: http.Server; calls: Call[] } {
    const calls: Call[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            calls.push({ bytes: Buffer.concat(chunks).length });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse("forwarded answer"));
        });
    });
    return { server, calls };
}

function proxyOptions(routes: Record<string, object>, window = WINDOW): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: window,
        kernelConfig: defaultConfig(window, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type Ctx = { url: string; headers: Record<string, string> };

async function setup(window = WINDOW): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { server: upstream, calls } = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions({ [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: window } } } }, window));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "s-6908" },
        },
        calls,
        close: () => {
            proxy.close();
            proxy.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        },
    };
}

/** First line of the real COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic (same string as
 * tests/dsh-compaction-guard.test.ts). */
const INSTRUCTION =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.";

const postBody = (ctx: Ctx, body: unknown) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify(body),
    });

test("e2e #6908: an over-band dsh compaction call reaches the guard instead of 413ing at ingest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908a-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // ~3 MiB replayed prefix + the directive as the FINAL user message:
        // over the 1 MiB test band, the exact self-lock shape from the field
        // report (32 MiB inbound, 446 KiB outbound after folding).
        const r = await postBody(ctx, {
            model: "gpt-test",
            stream: true,
            messages: [
                { role: "system", content: "you are dsh" },
                { role: "user", content: "x".repeat(3 * 1024 * 1024) },
                { role: "user", content: INSTRUCTION },
            ],
        });
        const body = await r.text();
        // THE behavior under test: the call must reach the #1729 guard and be
        // answered/refused there (422, dsh_compaction_refused) — never 413 at
        // ingest, never forwarded upstream.
        assert.equal(r.status, 422, `over-band compaction call must reach the guard (got ${r.status}): ${body.slice(0, 300)}`);
        assert.match(body, /dsh_compaction_refused/, "the guard refusal names the compaction call");
        assert.equal(calls.length, 0, `upstream must see zero calls (got ${JSON.stringify(calls)})`);
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908 control: an ordinary over-band body still 413s at ingest (the cap must keep biting)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908b-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        const r = await postBody(ctx, {
            model: "gpt-test",
            stream: true,
            messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }],
        });
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string } };
        assert.equal(r.status, 413, `ordinary over-band body must be refused (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "the STAGE names the ingest band");
        assert.equal(calls.length, 0, "upstream must see zero calls");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908 precision: an over-band body quoting the instruction MID-HISTORY still 413s (recognition is marker-decisive, not a substring)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908c-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup();
    try {
        // The instruction text sits in the middle of the history; the FINAL
        // user message is ordinary. A raw-substring exemption would let this
        // through to the parse sweep and the upstream — the verified
        // marker-decisive check must still refuse it at the cap.
        const r = await postBody(ctx, {
            model: "gpt-test",
            stream: true,
            messages: [
                { role: "user", content: "x".repeat(3 * 1024 * 1024) },
                { role: "user", content: INSTRUCTION },
                { role: "user", content: "please continue the refactor" },
            ],
        });
        const body = await r.text();
        const parsed = JSON.parse(body) as { error?: { type?: string; stage?: string } };
        assert.equal(r.status, 413, `quoted-instruction body must still be refused (got ${r.status}): ${body.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "the STAGE names the ingest band");
        assert.equal(calls.length, 0, "upstream must see zero calls");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});
