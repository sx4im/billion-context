// #5950: a Zhipu GLM model behind an OpenAI-compatible `new-provider`
// proxy streams its acp_status tool call with NO id at all. The adapter
// absorbed the call with callId "" and the loop replayed that empty id
// into the server-side continuation: the round-2 re-request carried an
// assistant tool_calls entry AND its tool result with an empty
// tool_call_id. That malformed pair is exactly the context a model
// "repairs" by emitting a stray call in the next round — the phantom
// Read tool_call for a nonexistent hash-named path in #5950, which the
// client executor then failed with read_file_not_found. Both directions:
// an id-less call must settle with a stable minted id, and a present
// upstream id must be kept byte-exact (wire fidelity, #1039).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { createOpenaiAdapter, runCompressLoop } from "../src/loop/index.ts";
import type { CompressLoopAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function sse(obj: unknown): Buffer {
    return Buffer.from("data: " + JSON.stringify(obj) + "\n\n", "utf8");
}

function streamOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]!));
            else controller.close();
        },
    });
}

const adapter = (): CompressLoopAdapter =>
    createOpenaiAdapter({ model: "m", messages: [], stream: true });

async function collect(adapter: CompressLoopAdapter, chunks: Buffer[]) {
    const toolCalls: { name: string; args: string; callId: string }[] = [];
    for await (const ev of adapter.parseStream(streamOf(chunks), 1)) {
        if (ev.kind === "tool_call") {
            toolCalls.push({
                name: (ev as { name: string }).name,
                args: (ev as { arguments: string }).arguments,
                callId: (ev as { callId: string }).callId,
            });
        }
    }
    return { toolCalls };
}

function acpStatusStream(idField: unknown): Buffer[] {
    const toolCall: Record<string, unknown> = {
        index: 0,
        type: "function",
        function: { name: "acp_status", arguments: "{}" },
    };
    if (idField !== undefined) toolCall.id = idField;
    return [
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
    ];
}

test("#5950: an acp_status call streamed with no id settles with a minted non-empty callId", async () => {
    const out = await collect(adapter(), acpStatusStream(undefined));
    assert.equal(out.toolCalls.length, 1, "one proxy call settles");
    assert.equal(out.toolCalls[0]!.name, "acp_status");
    assert.ok(out.toolCalls[0]!.callId.length > 0, `settled callId must not be empty, got: ${JSON.stringify(out.toolCalls[0]!.callId)}`);
});

test("#5950: an explicit empty-string id is minted too", async () => {
    const out = await collect(adapter(), acpStatusStream(""));
    assert.equal(out.toolCalls.length, 1);
    assert.ok(out.toolCalls[0]!.callId.length > 0, `settled callId must not be empty, got: ${JSON.stringify(out.toolCalls[0]!.callId)}`);
});

test("#5950 both-direction: a present upstream id is kept byte-exact", async () => {
    const out = await collect(adapter(), acpStatusStream("call_abc123"));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.callId, "call_abc123", "a present id is never rewritten");
});

test("#5950: two id-less calls in one round get distinct ids", async () => {
    const chunks = [
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [
                        { index: 0, type: "function", function: { name: "acp_status", arguments: "{}" } },
                        { index: 1, type: "function", function: { name: "compress", arguments: "{}" } },
                    ],
                },
                finish_reason: "",
            }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
    ];
    const out = await collect(adapter(), chunks);
    assert.equal(out.toolCalls.length, 2);
    const [first, second] = out.toolCalls;
    assert.ok(first!.callId.length > 0 && second!.callId.length > 0, "both ids minted");
    assert.notEqual(first!.callId, second!.callId, "minted ids are distinct within the round");
});

// ---------- compress loop: the round-2 continuation body ----------

function makeCtx(id: string) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
        protocol: "openai" as const,
    };
}

function openaiSse(frames: Array<Record<string, unknown>>): string {
    return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

const ROUND1_NO_ID = openaiSse([
    { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "acp_status", arguments: "{}" } }] }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]);

const ROUND2_PROSE = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "status summarized" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

async function drainOpenai(first: string, retries: string[], id: string): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id);
        for await (const chunk of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            { model: "deepseek-chat", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "deepseek-chat", stream: true }),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

test("#5950 loop: the round-2 continuation replays the id-less acp_status call with a matching non-empty tool_call_id", async () => {
    const { fetchCalls, bodies } = await drainOpenai(ROUND1_NO_ID, [ROUND2_PROSE], "s5950-l1");
    assert.equal(fetchCalls, 1, "the proxy call continues server-side exactly once");
    assert.equal(bodies.length, 1, "one re-request body observed");
    const body = JSON.parse(bodies[0]!) as { messages: Array<Record<string, unknown>> };
    const asst = body.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(asst, `round-2 body must replay the acp_status call, got: ${bodies[0]!.slice(0, 500)}`);
    const tc = (asst!.tool_calls as Array<Record<string, unknown>>)[0]!;
    assert.equal((tc.function as Record<string, unknown>).name, "acp_status");
    assert.ok(typeof tc.id === "string" && tc.id.length > 0, `assistant tool_calls id must be non-empty, got: ${JSON.stringify(tc.id)}`);
    const toolMsg = body.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "round-2 body must carry the acp_status tool result");
    assert.equal(toolMsg!.tool_call_id, tc.id, "tool result pairs with the assistant call on the same id");
    assert.ok(!bodies[0]!.includes('"tool_call_id":""'), "no empty tool_call_id anywhere in the continuation");
});
