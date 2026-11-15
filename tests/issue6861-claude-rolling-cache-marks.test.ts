import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

// #6861: bili claude rewrites mid-history on every request, breaking the
// prefix cache (cache hit falls to 8.7% on one request, 119K tokens
// re-billed, no fold or switch attribution).
//
// Root cause: Claude Code stamps a `cache_control` breakpoint on its last
// message + last assistant message and MOVES them as the conversation grows
// (#2188 documents the roll; the opencode lane already handles it via the
// retouch channel). The steady proxy path forwarded the client's CURRENT
// marks verbatim — so every request stripped the breakpoint off the message
// that carried it last turn and the outbound prefix broke exactly there.
// The seam detector cannot see it (marks live in the harvested map, not in
// the core messages it fingerprints), so the seam stays "unexplained".
//
// Fix: the steady path pins client-harvested marks cumulatively — the #1637
// discipline ("a marked message STAYS marked") extended to the client's own
// marks. A mark adopted once stays on that message until it folds away; new
// client marks on new messages are adopted up to the same 3-message cap.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string {
    return anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" });
}

interface Rig {
    proxyPort: number;
    portHint(): number;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l6861-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const server = await startServer(opts);
    await listen(server);
    const proxyPort = (server.address() as { port: number }).port;

    return {
        proxyPort,
        portHint: () => upstreamPort,
        upstreamBodies,
        closeAll: async () => {
            await close(server);
            await close(upstream);
        },
    };
}

interface Msg {
    role: "user" | "assistant";
    content: string | { type: "text"; text: string; cache_control?: unknown }[];
}

async function postModel(rig: Rig, sessionId: string, messages: Msg[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.portHint()}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": sessionId },
        body: JSON.stringify({ model: "l6861-model", max_tokens: 8192, stream: true, messages }),
    });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pred(), `timeout waiting for ${what}`);
}

interface AnthropicBody {
    system?: { type: string; text?: string; cache_control?: unknown }[];
    tools?: { name?: string; cache_control?: unknown }[];
    messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown }[] }[];
}

// Canonical form for cross-turn byte comparisons: mask the per-request
// `<bili-chain …/>` checkpoint and kernel `time="…"` attributes (same
// sanctioned normalization as the rolling-marks and watermark tests).
function canonMsg(m: unknown): string {
    return JSON.stringify(m)
        .replace(/\x3cbili-chain v="1"[^]*?\/\x3e/g, "\x3cbili-chain\x3e")
        .replace(/\stime=\\?"[0-9T:.Z+\- ]+\\?"/g, ' time="X"');
}

function markedIndexes(body: string): number[] {
    const parsed = JSON.parse(body) as AnthropicBody;
    const out: number[] = [];
    parsed.messages.forEach((m, i) => {
        if (Array.isArray(m.content) && m.content.some((b) => b.cache_control)) out.push(i);
    });
    return out;
}

const MARK = { type: "ephemeral" };

test("#6861: a client rolling its cache_control breakpoint must not rewrite the outbound prefix", async () => {
    const rig = await startRig();
    try {
        const sid = "sess-6861-a";
        // Turn 1: Claude Code style — breakpoint on the last message.
        const h1: Msg[] = [
            { role: "user", content: "task one" },
            { role: "assistant", content: "ack one" },
            { role: "user", content: [{ type: "text", text: "task two", cache_control: MARK }] },
        ];
        await postModel(rig, sid, h1);
        await waitFor(() => rig.upstreamBodies.length >= 1, "turn 1 forward");
        assert.deepEqual(markedIndexes(rig.upstreamBodies[0]), [2], "turn 1: exactly the client's own breakpoint, on the last message");

        // Turn 2: the breakpoint MOVED to the new last message; turn 1's
        // marked message is now mid-history and unmarked client-side.
        const h2: Msg[] = [
            { role: "user", content: "task one" },
            { role: "assistant", content: "ack one" },
            { role: "user", content: [{ type: "text", text: "task two" }] },
            { role: "assistant", content: "ack two" },
            { role: "user", content: [{ type: "text", text: "task three", cache_control: MARK }] },
        ];
        await postModel(rig, sid, h2);
        await waitFor(() => rig.upstreamBodies.length >= 2, "turn 2 forward");

        const b1 = JSON.parse(rig.upstreamBodies[0]) as AnthropicBody;
        const b2 = JSON.parse(rig.upstreamBodies[1]) as AnthropicBody;
        // Prefix-cache contract: every turn-1 message serializes identically
        // on turn 2 — the moved breakpoint must not rewrite it.
        for (let i = 0; i < b1.messages.length; i++) {
            assert.equal(canonMsg(b2.messages[i]), canonMsg(b1.messages[i]), `message ${i} byte-stable across turns despite the moved breakpoint`);
        }
        // The adopted mark stays: turn 1's marked message is still marked.
        assert.deepEqual(markedIndexes(rig.upstreamBodies[1]), [2, 4], "turn 2: turn 1's mark pinned AND the new last message marked");
        // Negative direction: a message the client never marked stays unmarked.
        const a1 = b2.messages[1];
        assert.ok(Array.isArray(a1.content) && a1.content.every((b) => !b.cache_control), "never-marked message stays unmarked");
    } finally {
        await rig.closeAll();
    }
});

test("#6861: pinned client marks freeze at the 3-message cap and never accumulate past it", async () => {
    const rig = await startRig();
    try {
        const sid = "sess-6861-b";
        let history: Msg[] = [];
        for (let turn = 1; turn <= 5; turn++) {
            // Each turn the client marks ONLY its newest message (rolling).
            const next: Msg[] = history.map((m) => ({
                role: m.role,
                content: typeof m.content === "string"
                    ? m.content
                    : m.content.map((b) => { const c = { ...b }; delete c.cache_control; return c; }),
            }));
            next.push({ role: "user", content: [{ type: "text", text: `task ${turn}`, cache_control: MARK }] });
            if (turn > 1) {
                const prev = history[history.length - 1];
                void prev;
                next.splice(next.length - 1, 0, { role: "assistant", content: `ack ${turn - 1}` });
            }
            history = next;
            await postModel(rig, sid, history);
            await waitFor(() => rig.upstreamBodies.length >= turn, `turn ${turn} forward`);
            assert.ok(markedIndexes(rig.upstreamBodies[turn - 1]).length <= 3, `turn ${turn}: never more than 3 message marks`);
        }
        // The three earliest adopted marks freeze; later rolls add nothing.
        assert.deepEqual(markedIndexes(rig.upstreamBodies[4]), [0, 2, 4], "turn 5: earliest three marks frozen, no advance past cap");
    } finally {
        await rig.closeAll();
    }
});
