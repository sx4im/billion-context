// #6908: the 32 MiB ingest cost is measured against the pre-folding inbound
// body, so a normal session folded down to 446 KiB is permanently 413 — and
// SELF-LOCKING: the only action that could shrink the host history (a dsh
// compaction call) is itself a full-history inbound body, so it 413s BEFORE
// JSON.parse, before the request ever reaches the #1729 compaction guard
// (isDshCompactionCall runs on the parsed body). The fix lets a compaction
// call reach the guard: at the ingest gate, a cheap 48-byte marker sniff on
// the raw decoded bytes (same precedent as the passthrough detector, #2709)
// admits only bodies that pass the FULL marker-decisive check; everything
// else — including bodies that merely quote the instruction mid-history —
// still 413s, and the 32 MiB default is untouched. Pinned with a small band
// (1 MiB) like #5794 so the over-cap body stays a few MiB.
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
import { isDshCompactionCallInRawBody } from "../src/server/dsh-compaction-guard.ts";

const WINDOW = 20_000;

/** First line of the real COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic (same fixture as
 * tests/dsh-compaction-guard.test.ts). */
const INSTRUCTION =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.";

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

async function setup(sessionId: string, window = WINDOW): Promise<{ ctx: Ctx; calls: Call[]; close: () => void }> {
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
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
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

// ~1.5 MiB of replayed prefix in ONE user message: over the 1 MiB test
// band, far under the receive/decode caps — the #6908 shape (a full-history
// replay whose folded outbound is tiny but whose inbound keeps growing).
const REPLAY = "x".repeat(1_500_000);

function compactionBody() {
    return {
        model: "gpt-test",
        stream: true,
        messages: [
            { role: "system", content: "you are dsh" },
            { role: "user", content: REPLAY },
            { role: "user", content: INSTRUCTION },
        ],
    };
}

test("e2e #6908: an over-cap dsh compaction call reaches the #1729 guard instead of 413ing at ingest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908a-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup("s-6908-compaction");
    try {
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify(compactionBody()),
        });
        const text = await r.text();
        const parsed = JSON.parse(text) as { bili_final?: boolean; error?: { code?: string; type?: string } };
        // The call must NOT 413 at ingest: it reaches the compaction guard,
        // which refuses it as a policy decision (422, terminal, bili_final).
        assert.equal(r.status, 422, `over-cap compaction call must reach the guard (got ${r.status}): ${text.slice(0, 300)}`);
        assert.equal(parsed.bili_final, true, "the refusal is terminal (bili_final)");
        assert.equal(parsed.error?.code, "dsh_compaction_refused", "the refusal names the compaction guard");
        assert.equal(calls.length, 0, "the refused call never reaches the upstream");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908 control: an over-cap NON-compaction body still 413s at ingest", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908b-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup("s-6908-control");
    try {
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                messages: [
                    { role: "user", content: REPLAY },
                    { role: "user", content: "please continue the refactor" },
                ],
            }),
        });
        const text = await r.text();
        const parsed = JSON.parse(text) as { error?: { type?: string; stage?: string } };
        assert.equal(r.status, 413, `over-band non-compaction body must be refused (got ${r.status}): ${text.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "the refusal is still the ingest band");
        assert.equal(calls.length, 0, "upstream must see zero calls");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("e2e #6908: quoting the instruction mid-history does NOT exempt an over-cap body (the full check decides, not the sniff)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-6908c-"));
    const disarm = armIngestBand();
    const { ctx, calls, close } = await setup("s-6908-quote");
    try {
        const r = await fetch(ctx.url, {
            method: "POST",
            headers: { ...ctx.headers },
            body: JSON.stringify({
                model: "gpt-test",
                stream: true,
                messages: [
                    { role: "user", content: INSTRUCTION },
                    { role: "assistant", content: REPLAY },
                    { role: "user", content: "please continue the refactor" },
                ],
            }),
        });
        const text = await r.text();
        const parsed = JSON.parse(text) as { error?: { type?: string; stage?: string } };
        // The raw bytes contain the marker (sniff hit) but the final user
        // message does not start with it, so the full check says no — 413.
        assert.equal(r.status, 413, `mid-history quote must not exempt the body (got ${r.status}): ${text.slice(0, 300)}`);
        assert.equal(parsed.error?.stage, "ingest", "the refusal is still the ingest band");
        assert.equal(calls.length, 0, "upstream must see zero calls");
    } finally {
        disarm();
        await close();
        rmrf(root);
    }
});

test("unit #6908: the raw-body compaction detector is sniff-gated and fail-closed", () => {
    const compaction = Buffer.from(JSON.stringify(compactionBody()), "utf8");
    assert.equal(isDshCompactionCallInRawBody("openai", compaction), true, "raw compaction envelope is recognised");
    const plain = Buffer.from(JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: REPLAY }, { role: "user", content: "please continue" }],
    }), "utf8");
    assert.equal(isDshCompactionCallInRawBody("openai", plain), false, "plain over-cap text is not a compaction call");
    // Unparseable bytes that happen to contain the marker must not exempt:
    // the 413 stands (fail-closed toward the cap).
    const garbage = Buffer.from(`{"messages": [{"role": "user", "content": "${INSTRUCTION}"`, "utf8");
    assert.equal(isDshCompactionCallInRawBody("openai", garbage), false, "unparseable marker bytes do not exempt");
    assert.equal(isDshCompactionCallInRawBody(null, compaction), false, "no protocol, no exemption");
    // The responses wire reads input[], not messages[] — an openai-shaped
    // body is not a compaction call there.
    assert.equal(isDshCompactionCallInRawBody("responses", compaction), false, "openai shape on the responses wire is not a compaction call");
    const responsesBody = Buffer.from(JSON.stringify({
        model: "qwen-3.8-27b",
        input: [
            { type: "message", role: "user", content: REPLAY },
            { type: "message", role: "user", content: INSTRUCTION },
        ],
    }), "utf8");
    assert.equal(isDshCompactionCallInRawBody("responses", responsesBody), true, "responses-shaped compaction envelope is recognised");
});
