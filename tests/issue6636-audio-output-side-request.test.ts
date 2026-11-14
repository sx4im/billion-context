import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { isAudioOutputCall, isSideRequest } from "../src/server/side-request.ts";
import { validateOpenAiChatBody } from "./wire-contract-fakes.ts";

// #6636: a TTS sidecar (dsh plugin, Xiaomi MiMo mimo-v2.5-tts) sends a
// chat-completions request carrying the documented `audio` output
// parameter under the main session id. bili treated it as a conversation
// turn and injected its leading ACP system prompt plus tag prefixes on
// every message; upstream 400'd with "messages[0] system role is not
// allowed for TTS model", while the identical undecorated body returned
// 200 (wire capture + control experiment in the issue). The fix routes
// audio-output requests through the #388 verbatim side passthrough.
// This file pins the predicate (both directions), the WC-025 wire-contract
// tripwire (both directions), and the end-to-end forwarding: the TTS
// body goes out byte-identical, a real conversation on the same session
// still gets the decoration.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-6636-audio-output-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const TTS_BODY = {
    model: "mimo-v2.5-tts",
    audio: { format: "mp3", voice: "mimo_default" },
    stream: false,
    messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
    ],
};

test("isAudioOutputCall: the #6636 TTS shape, and only it", () => {
    assert.equal(isAudioOutputCall(TTS_BODY), true, "the reported TTS body is an audio-output call");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, audio: { format: "mp3" } }), false, "voice is required");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, audio: { voice: "mimo_default" } }), false, "format is required");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, audio: {} }), false, "an empty audio object is not an audio-output call");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, audio: "mp3" }), false, "a non-object audio field is not an audio-output call");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, audio: null }), false, "a null audio field is not an audio-output call");
    assert.equal(isAudioOutputCall({ model: "mimo-v2.5-tts", stream: false, messages: TTS_BODY.messages }), false, "no audio parameter, no audio-output call");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }] }), false, "a tool-carrying audio request is a voice-mode agent turn, not a side call");
    assert.equal(isAudioOutputCall(null), false, "null body");
    assert.equal(isAudioOutputCall({}), false, "empty body");
});

test("isAudioOutputCall: the predicate is self-contained for the restoreOutputBudget skip (#2500 parity)", () => {
    // handle.ts consults this predicate independently of the #546 guard, so the
    // no-tools veto lives IN the predicate — and the predicate must still claim
    // a budgeted TTS body, or the skip never fires for the shape that needs it.
    assert.equal(isAudioOutputCall({ ...TTS_BODY, max_tokens: 64000 }), true, "a budgeted TTS body still claims the skip");
    assert.equal(isAudioOutputCall({ ...TTS_BODY, max_tokens: 64000, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } }] }), false, "any tool entry vetoes the skip (#546)");
});

test("isSideRequest: the #6636 TTS body rides the side lane; a plain conversation does not", () => {
    assert.equal(isSideRequest(TTS_BODY, undefined), true);
    assert.equal(isSideRequest(TTS_BODY, "main"), false, "explicit main intent outranks the shape heuristic (#1699)");
    const plain = { model: "mimo-v2.5-tts", stream: false, messages: TTS_BODY.messages };
    assert.equal(isSideRequest(plain, undefined), false, "the same body without the audio parameter is an ordinary turn");
});

test("WC-025: the fake upstream 400s a decorated audio-output body and accepts the undecorated one", () => {
    const decorated = { ...TTS_BODY, messages: [{ role: "system", content: "acp tags" }, ...TTS_BODY.messages] };
    const violations = validateOpenAiChatBody(decorated);
    assert.equal(violations.length, 1, `expected exactly one WC-025 violation, got ${JSON.stringify(violations)}`);
    assert.match(violations[0], /WC-025/);
    // Control, both directions: the undecorated TTS body passes, and a
    // leading system message on a NON-audio request is a normal
    // conversation the validator must not flag.
    assert.deepEqual(validateOpenAiChatBody(TTS_BODY), [], "the undecorated TTS body is valid on the wire");
    assert.deepEqual(
        validateOpenAiChatBody({ model: "fake-a", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] }),
        [],
        "a leading system message is legal on a real conversation — only audio-output requests are constrained",
    );
    assert.deepEqual(
        validateOpenAiChatBody({ ...TTS_BODY, audio: { format: "mp3" }, messages: [{ role: "system", content: "s" }, ...TTS_BODY.messages] }),
        [],
        "an incomplete audio parameter does not trigger the audio-output constraint",
    );
});

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    mkdirSync(join(dir, "billion-context", "sessions"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "fake-a": { context: 400000 }, "mimo-v2.5-tts": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const dshSend = async (conversationId: string, body: Record<string, unknown>, agent?: string) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200, await response.text());
    };
    const status = async (conversationId: string) => (await (await fetch(`${origin}/__bili/plugin/status?conversationId=${conversationId}`)).json()) as { contextTokens: number | null; inputTokens: number };
    return { forwarded, dshSend, status, origin, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

test("the #6636 TTS side call goes out undecorated while a real conversation on the same session still gets the decoration", async () => {
    const h = await harness();
    try {
        const history = [
            { role: "user", content: "set up the workspace" },
            { role: "assistant", content: "done" },
        ];
        // 1. first a real main turn — no leading system in the sent body, so
        //    the control is whether bili injects one (it must: this is a
        //    conversation, and the ACP behavior for real turns is untouched).
        const mainBody = { model: "fake-a", max_completion_tokens: 8192, stream: false, messages: [...history, { role: "user", content: "now configure ci" }], tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }] };
        await h.dshSend("conv-tts", mainBody, "main");
        const mainForwarded = h.forwarded.at(-1) as { messages: { role: string; content: unknown }[] };
        assert.equal(mainForwarded.messages[0].role, "system", "a real main turn still gets the leading system prompt");
        assert.notDeepEqual(mainForwarded, mainBody, "the main turn is decorated, not verbatim");
        const session = resolveConversation("conv-tts").session!;
        assert.ok(session, "raw-key session exists");
        assert.equal(session.stats.requests, 1, "the main turn runs the full pipeline exactly once");
        const statusBefore = await h.status("conv-tts");

        // 2. the TTS side call on the same conversation — the exact #6636
        //    shape. It must go out byte-identical: no injected system, no
        //    tag prefixes on the messages, and no kernel-state impact.
        await h.dshSend("conv-tts", TTS_BODY);
        assert.deepEqual(h.forwarded.at(-1), TTS_BODY, "the TTS side call is forwarded verbatim (nothing injected)");
        assert.equal(session.stats.requests, 1, "the TTS side call must not count as a main request");
        const statusAfter = await h.status("conv-tts");
        assert.equal(statusAfter.inputTokens, statusBefore.inputTokens, "the TTS side call must not touch the usage baseline");
        assert.equal(statusAfter.contextTokens, statusBefore.contextTokens, "the TTS side call must not touch the context estimate");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes("mimo-v2.5-tts"), "the TTS model never lands in the kernel session");
    } finally {
        await h.close();
    }
});
