import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startFakeUpstream, type CapturedRequest } from "./wire-contract-fakes.ts";

// #6636: a non-conversational side call (TTS) that merely shares the OpenAI
// shape gets decorated like a conversation turn — bili's leading ACP system
// prompt plus <acp> tag prefixes on every message — and the speech-model
// upstream 400s with "messages[0] system role is not allowed for TTS
// model". The durable fix for known shapes is the classifier (audio-output
// requests ride the #388 verbatim side passthrough); this file pins the
// backstop for shapes the classifier does not know: the relay's
// undecorated-retry probe re-sends once with bili's own decoration removed
// and adopts the retry on success. The wire-contract fake is the upstream
// here: its WC-025 clause 400s exactly the production rejection, and the
// identical undecorated body returns 200 — the issue's control experiment,
// replayed end to end.
//
// Tag bytes use hex escapes per KDD #2 (no literal angle brackets in source).

const WINDOW = 20_000;

type ChatMsg = { role: string; content: string };

function proxyOptions(routes: Record<string, object>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: routes as ProxyOptions["routes"],
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
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

async function setup(): Promise<{ ctx: Ctx; fake: Awaited<ReturnType<typeof startFakeUpstream>>; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeUpstream("openai-chat");
    const proxy = await startServer(proxyOptions({ [fake.url]: { models: { "mimo-v2.5-tts": { context: WINDOW } } } }));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        ctx: {
            url: `http://127.0.0.1:${proxyPort}/bili/${fake.url}/v1/chat/completions`,
            headers: { "content-type": "application/json", "x-acp-session": "" },
        },
        fake,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await fake.close();
            await Promise.allSettled([once(proxy, "close")]);
        },
    };
}

const postTts = (ctx: Ctx, messages: ChatMsg[]) =>
    fetch(ctx.url, {
        method: "POST",
        headers: { ...ctx.headers },
        body: JSON.stringify({
            model: "mimo-v2.5-tts",
            messages,
            audio: { format: "mp3", voice: "mimo_default" },
            stream: false,
        }),
    });

function chatBody(req: CapturedRequest): Record<string, unknown> {
    return req.body as Record<string, unknown>;
}

function messagesOf(req: CapturedRequest): Array<{ role: string; content: string }> {
    return (chatBody(req).messages ?? []) as Array<{ role: string; content: string }>;
}

test("e2e #6636 a: TTS side call 400s on bili's injected system, probe re-sends undecorated and the turn succeeds", async () => {
    const { ctx, fake, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "i6636-a";
        const userText = "请用自然口语的方式朗读下面这句话";
        const asstText = "这条要念的话。";
        const r = await postTts(ctx, [
            { role: "user", content: userText },
            { role: "assistant", content: asstText },
        ]);
        assert.equal(r.status, 200, "the undecorated retry is accepted — the client never sees the poisoned 400");
        const reply = (await r.json()) as Record<string, unknown>;
        const choices = reply.choices as Array<{ message: { content: string } }>;
        assert.equal(choices[0]?.message.content, "ok", "the fake upstream's reply flows through");

        // The decorated first send, then the undecorated retry. (No #2645
        // prompt_cache_key A/B hop in between: no conversation header is
        // present, so no bili-owned key is stamped onto this shape.)
        assert.equal(fake.requests.length, 2, "decorated send + undecorated retry");
        const first = fake.requests[0]!;
        const firstMsgs = messagesOf(first);
        assert.equal(firstMsgs[0]?.role, "system", "the first send carries bili's injected ACP system prompt");
        assert.ok((firstMsgs[1]?.content ?? "").startsWith("\x3cacp "), "the first send carries bili's tag prefix on the user text");
        assert.ok((firstMsgs[1]?.content ?? "").includes(userText), "the tag prefixes the client's own text, it does not replace it");
        assert.ok(fake.violations.some((v) => v.startsWith("WC-025")), "the fake upstream rejected the decorated send per WC-025");

        const last = fake.requests[fake.requests.length - 1]!;
        const lastBody = chatBody(last);
        const lastMsgs = messagesOf(last);
        assert.equal(lastMsgs.length, 2, "the retry carries exactly the client's two messages");
        assert.deepEqual(lastMsgs[0], { role: "user", content: userText }, "user text byte-identical, tag prefix gone");
        assert.deepEqual(lastMsgs[1], { role: "assistant", content: asstText }, "assistant text byte-identical, tag prefix gone");
        assert.ok(!lastMsgs.some((m) => m.role === "system"), "no system message anywhere in the retry");
        assert.ok(!lastMsgs.some((m) => m.content.includes("\x3cacp ")), "no acp tag prefix anywhere in the retry");
        assert.deepEqual(lastBody.audio, { format: "mp3", voice: "mimo_default" }, "the audio output parameter survives the strip");
        assert.equal(lastBody.model, "mimo-v2.5-tts");
        assert.equal(lastBody.stream, false);
    } finally {
        await close();
    }
});

test("e2e #6636 b: a client-authored system message is never stripped — the original 400 stands", async () => {
    const { ctx, fake, close } = await setup();
    try {
        ctx.headers["x-acp-session"] = "i6636-b";
        const r = await postTts(ctx, [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
        ]);
        assert.equal(r.status, 400, "the client's own system message is the poison and bili must not remove client bytes to fix it");
        const err = (await r.json()) as Record<string, unknown>;
        assert.ok(JSON.stringify(err).includes("WC-025"), "the original WC-025 400 reaches the client verbatim");
        // Exactly one send: the strip probe bails (the leading system is
        // the client's), so there is no retry at all.
        assert.equal(fake.requests.length, 1, "no undecorated retry when the system message is client-authored");
        const lastMsgs = messagesOf(fake.requests[fake.requests.length - 1]!);
        assert.equal(lastMsgs[0]?.role, "system", "the single send still carries the client's system message");
        // Prepare hoists the client's system and re-injects it alongside
        // bili's prompt (client text first) — the probe must not touch it.
        assert.ok((lastMsgs[0]?.content ?? "").startsWith("You are a helpful assistant."), "the client's system text is intact at the head of the message");
        assert.ok((lastMsgs[0]?.content ?? "").includes("Compression Philosophy:"), "bili's prompt rides alongside it, merged — the probe correctly refuses surgery on a merged message");
    } finally {
        await close();
    }
});
