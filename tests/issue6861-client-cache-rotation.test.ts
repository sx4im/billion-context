import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

// #6861: Claude Code (-p) reading files one at a time through `bili claude`
// rotates its own ephemeral cache_control breakpoint onto the newest user
// message each request and drops it from the previous one. Bili used to
// mirror that rotation verbatim, so the un-marked message was rewritten
// mid-history on the next request and the byte prefix broke exactly there —
// while the #3023 client arm could not see it (its inbound fingerprints are
// computed over cache-control-stripped CoreMessages), leaving the seam
// unattributed. The fix pins harvested client marks with the same cumulative
// discipline as bili's own #1637 marks: a marked message STAYS marked until
// it folds away, capped by Anthropic's 4-breakpoint budget (WC-010).

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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l6861-model": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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

type Block = { type: string; text?: string; cache_control?: unknown; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
interface Msg {
    role: "user" | "assistant";
    content: string | Block[];
}

async function postModel(rig: Rig, sessionId: string, messages: Msg[], system?: unknown, tools?: unknown[]): Promise<Response> {
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.portHint()}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": sessionId },
        body: JSON.stringify({ model: "l6861-model", max_tokens: 8192, stream: true, ...(system !== undefined ? { system } : {}), messages, ...(tools ? { tools } : {}) }),
    });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pred(), `timeout waiting for ${what}`);
}

function fileText(n: number): string {
    return `--- notes/file${String(n).padStart(2, "0")}.md ---\n` + ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40)) + `\n[entry ${n} end]\n`;
}

function readTurn(n: number): Msg[] {
    return [
        { role: "assistant", content: [{ type: "text", text: `I'll read notes/file${String(n).padStart(2, "0")}.md now.` }, { type: "tool_use", id: `toolu_read_${n}`, name: "Read", input: { file_path: `/repo/notes/file${String(n).padStart(2, "0")}.md` } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_read_${n}`, content: fileText(n) }] },
    ];
}

function markLastUser(messages: Msg[]): Msg[] {
    // Claude Code style: ephemeral breakpoint on the newest user message.
    const out = messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content }));
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]!.role === "user") {
            const c = out[i]!.content;
            if (Array.isArray(c)) {
                const last = c[c.length - 1]!;
                (last as Block).cache_control = { type: "ephemeral" };
            } else {
                out[i]!.content = [{ type: "text", text: c as string, cache_control: { type: "ephemeral" } }];
            }
            break;
        }
    }
    return out;
}

function stripClientMarks(messages: Msg[]): Msg[] {
    return messages.map((m) => ({
        ...m,
        content: Array.isArray(m.content)
            ? m.content.map((b) => {
                const { cache_control: _cc, ...rest } = b as Block;
                return rest as Block;
            })
            : m.content,
    }));
}

interface AnthropicBody {
    system?: { type: string; text?: string; cache_control?: unknown }[];
    tools?: { name?: string; cache_control?: unknown }[];
    messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown }[] }[];
}

function markedMessageIndices(body: AnthropicBody): number[] {
    const out: number[] = [];
    body.messages.forEach((m, i) => {
        if (Array.isArray(m.content) && m.content.some((b) => b.cache_control)) out.push(i);
    });
    return out;
}

function totalBreakpoints(body: AnthropicBody): number {
    const sys = Array.isArray(body.system) ? body.system.filter((b) => b.cache_control).length : 0;
    const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t.cache_control).length : 0;
    return sys + tools + markedMessageIndices(body).length;
}

function claudeSystem(): unknown {
    return [
        { type: "text", text: "You are Claude Code, an agent." },
        { type: "text", text: "REPO_CONVENTIONS: follow them.", cache_control: { type: "ephemeral" } },
    ];
}

test("#6861: rotating client cache_control — the dropped breakpoint is pinned, the shared prefix stays byte-identical", async () => {
    const rig = await startRig();
    try {
        const system = claudeSystem();
        let h1: Msg[] = [{ role: "user", content: "Please read the notes one at a time, then write a summary." }];
        for (let n = 1; n <= 5; n++) h1 = [...h1, ...readTurn(n)];
        h1 = markLastUser(h1);
        await postModel(rig, "sess-6861-pin", h1, system);
        await waitFor(() => rig.upstreamBodies.length >= 1, "turn 1 forward");

        // Client rotates its breakpoint onto the new last message (old one dropped).
        let h2: Msg[] = [...stripClientMarks(h1), ...readTurn(6)];
        h2 = markLastUser(h2);
        await postModel(rig, "sess-6861-pin", h2, system);
        await waitFor(() => rig.upstreamBodies.length >= 2, "turn 2 forward");

        const b1 = JSON.parse(rig.upstreamBodies[0]) as AnthropicBody;
        const b2 = JSON.parse(rig.upstreamBodies[1]) as AnthropicBody;
        assert.deepEqual(b2.system, b1.system, "system byte-stable across turns");
        for (let i = 0; i < b1.messages.length; i++) {
            assert.deepEqual(b2.messages[i], b1.messages[i], `shared message ${i} byte-stable across turns (prefix-cache contract)`);
        }
        // The previous turn's breakpoint survives on its message (pinned) and
        // the client's current breakpoint lands on the new last message.
        assert.deepEqual(markedMessageIndices(b2), [10, 12], "old breakpoint pinned + new breakpoint on the tail");
        assert.ok(totalBreakpoints(b2) <= 4, "WC-010 4-breakpoint budget holds");
    } finally {
        await rig.closeAll();
    }
});

test("#6861: cumulative client marks still pass through with both breakpoints", async () => {
    const rig = await startRig();
    try {
        const system = claudeSystem();
        let h1: Msg[] = [{ role: "user", content: "Please read the notes one at a time, then write a summary." }];
        for (let n = 1; n <= 5; n++) h1 = [...h1, ...readTurn(n)];
        h1 = markLastUser(h1);
        await postModel(rig, "sess-6861-cumulative", h1, system);
        await waitFor(() => rig.upstreamBodies.length >= 1, "turn 1 forward");

        // Client KEEPS the old breakpoint and adds a new one on the new last message.
        let h2: Msg[] = [...h1, ...readTurn(6)];
        h2 = markLastUser(h2);
        await postModel(rig, "sess-6861-cumulative", h2, system);
        await waitFor(() => rig.upstreamBodies.length >= 2, "turn 2 forward");

        const b1 = JSON.parse(rig.upstreamBodies[0]) as AnthropicBody;
        const b2 = JSON.parse(rig.upstreamBodies[1]) as AnthropicBody;
        for (let i = 0; i < b1.messages.length; i++) {
            assert.deepEqual(b2.messages[i], b1.messages[i], `shared message ${i} byte-stable across turns`);
        }
        assert.deepEqual(markedMessageIndices(b2), [10, 12], "both client breakpoints present");
    } finally {
        await rig.closeAll();
    }
});

test("#6861: pin cap — system + tools marks reserve budget, the set freezes instead of dropping an old breakpoint", async () => {
    const rig = await startRig();
    try {
        const system = claudeSystem();
        const tools = [
            { name: "Read", description: "read a file", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } },
            { name: "Write", description: "write a file", input_schema: { type: "object", properties: {} } },
        ];
        // Reserved: 1 system + 1 tools = 2, so at most 2 message pins fit.
        const sid = "sess-6861-cap";
        let history: Msg[] = [{ role: "user", content: "Please read the notes one at a time, then write a summary." }];
        const bodies: AnthropicBody[] = [];
        for (let turn = 1; turn <= 6; turn++) {
            history = turn === 1 ? [...history, ...readTurn(1)] : [...stripClientMarks(history), ...readTurn(turn)];
            history = markLastUser(history);
            await postModel(rig, sid, history, system, tools);
            await waitFor(() => rig.upstreamBodies.length >= turn, `turn ${turn} forward`);
            const body = JSON.parse(rig.upstreamBodies[turn - 1]) as AnthropicBody;
            bodies.push(body);
            assert.ok(totalBreakpoints(body) <= 4, `turn ${turn}: WC-010 budget holds (got ${totalBreakpoints(body)})`);
        }
        // Earliest pins survive every later turn; the set froze at the cap
        // instead of dropping one (which would rewrite that message mid-history).
        const marks6 = markedMessageIndices(bodies[5]!);
        assert.deepEqual(marks6, [2, 4], "turn 6 keeps exactly the two earliest pinned message breakpoints");
        for (let turn = 2; turn <= 6; turn++) {
            const prev = bodies[turn - 2]!;
            const cur = bodies[turn - 1]!;
            for (let i = 0; i < prev.messages.length; i++) {
                assert.deepEqual(cur.messages[i], prev.messages[i], `turn ${turn}: shared message ${i} byte-stable vs turn ${turn - 1}`);
            }
        }
    } finally {
        await rig.closeAll();
    }
});
