// #6632: on claude-fable-5-2, every fold that rewrites the history prefix
// makes the NEXT request fail with 400 "Invalid `signature` in `thinking`
// block" — Fable binds each signed thinking block to the exact prefix it was
// created on, and the invalid block stays in the client history, so the
// session bricks permanently. The 400 itself names the remedy: set
// `thinking.block_binding.prefix_mismatch_behavior` to `drop_block` (which
// requires `thinking-binding-controls-2026-08-01` in `anthropic-beta`).
//
// The fix is proactive, not learn-on-failure: on a thinking-binding model,
// whenever extended thinking is on, the outbound request carries
// block_binding=drop_block (inert upstream when no prefix mismatch exists)
// and the matching beta header — so already-poisoned sessions recover on the
// very next request, and a fold created mid-request rides into the round-2
// re-request through the prepared body. Opus 5.5 and every non-Fable model
// are untouched (Opus does not enforce the binding).
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import {
    THINKING_BINDING_BETA,
    applyThinkingBinding,
    isThinkingBindingModel,
} from "../src/server/thinking-posture.ts";
import { addThinkingBindingBeta } from "../src/server/headers.ts";

// ---------------------------------------------------------------------------
// Unit: model matcher + body/header mutation
// ---------------------------------------------------------------------------

test("#6632: isThinkingBindingModel matches the Fable family only", () => {
    assert.equal(isThinkingBindingModel("claude-fable-5-2"), true);
    assert.equal(isThinkingBindingModel("claude-fable-5-2[1m]"), true);
    assert.equal(isThinkingBindingModel("CLAUDE-FABLE-5-2"), true);
    assert.equal(isThinkingBindingModel("claude-opus-5-5"), false);
    assert.equal(isThinkingBindingModel("claude-sonnet-5"), false);
    assert.equal(isThinkingBindingModel("claude-haiku-5"), false);
    assert.equal(isThinkingBindingModel(undefined), false);
    assert.equal(isThinkingBindingModel(""), false);
});

test("#6632: applyThinkingBinding sets drop_block on a thinking-enabled Fable request", () => {
    const body: Record<string, unknown> = {
        model: "claude-fable-5-2",
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [],
    };
    assert.equal(applyThinkingBinding(body, "claude-fable-5-2"), true);
    assert.deepEqual(
        (body.thinking as Record<string, unknown>).block_binding,
        { prefix_mismatch_behavior: "drop_block" },
    );
    // A client-set block_binding is never clobbered.
    const clientSet: Record<string, unknown> = {
        model: "claude-fable-5-2",
        thinking: { type: "enabled", budget_tokens: 1024, block_binding: { prefix_mismatch_behavior: "keep_block" } },
        messages: [],
    };
    assert.equal(applyThinkingBinding(clientSet, "claude-fable-5-2"), false);
    assert.deepEqual(
        (clientSet.thinking as Record<string, unknown>).block_binding,
        { prefix_mismatch_behavior: "keep_block" },
    );
});

test("#6632: applyThinkingBinding stays off outside the gate", () => {
    // Opus does not enforce the binding.
    const opus: Record<string, unknown> = {
        model: "claude-opus-5-5",
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [],
    };
    assert.equal(applyThinkingBinding(opus, "claude-opus-5-5"), false);
    assert.equal((opus.thinking as Record<string, unknown>).block_binding, undefined);
    // No thinking param at all: do not invent one.
    const noThinking: Record<string, unknown> = { model: "claude-fable-5-2", messages: [] };
    assert.equal(applyThinkingBinding(noThinking, "claude-fable-5-2"), false);
    assert.equal(noThinking.thinking, undefined);
    // Explicitly disabled thinking: nothing to bind.
    const disabled: Record<string, unknown> = {
        model: "claude-fable-5-2",
        thinking: { type: "disabled" },
        messages: [],
    };
    assert.equal(applyThinkingBinding(disabled, "claude-fable-5-2"), false);
    assert.equal((disabled.thinking as Record<string, unknown>).block_binding, undefined);
});

test("#6632: addThinkingBindingBeta appends the beta once, preserving existing values", () => {
    const fresh: Record<string, string> = {};
    addThinkingBindingBeta(fresh);
    assert.equal(fresh["anthropic-beta"], THINKING_BINDING_BETA);
    addThinkingBindingBeta(fresh);
    assert.equal(fresh["anthropic-beta"], THINKING_BINDING_BETA, "no duplicate on repeat");
    const withOther: Record<string, string> = { "anthropic-beta": "context-1m-2026-02-01" };
    addThinkingBindingBeta(withOther);
    assert.equal(withOther["anthropic-beta"], `context-1m-2026-02-01, ${THINKING_BINDING_BETA}`);
    // Case-insensitive key: append to the client's own key, don't mint a second one.
    const capped: Record<string, string> = { "Anthropic-Beta": "context-1m-2026-02-01" };
    addThinkingBindingBeta(capped);
    assert.equal(capped["Anthropic-Beta"], `context-1m-2026-02-01, ${THINKING_BINDING_BETA}`);
    assert.equal(capped["anthropic-beta"], undefined);
});

// ---------------------------------------------------------------------------
// End-to-end: scripted Fable session through the real proxy + fake upstream.
// Request 1 folds the early turns (compress round-trip); request 2 is the
// very next turn on the same session — the exact step that 400'd in the
// report. Both the forwarded body AND the forwarded beta header are asserted.
// ---------------------------------------------------------------------------

const anthropicSse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Enough distinct mass per message that the folded range clears the kernel's
// 5000-char minCompressRange floor (#402) and the compress actually commits.
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

type TurnMsg = { role: string; content: Array<Record<string, unknown>> };
// Seven single-block turns (u,a,u,a,u,a,user-trigger) → refs m00001..m00007.
// The compress folds m00001..m00002 — OUTSIDE the kernel's last-5 protected
// zone — so it commits. Turn 2's assistant message carries a SIGNED thinking
// block (created before the fold, bound to the pre-fold prefix): it survives
// the fold and is exactly the block Fable rejects without drop_block.
const buildTurns = (): TurnMsg[] => {
    const out: TurnMsg[] = [];
    for (let i = 1; i <= 3; i++) {
        out.push({ role: "user", content: [{ type: "text", text: `user turn ${i}: examine subsystem ${i} and report every failure mode you can find in the current implementation. ` + FILLER(i, 8) }] });
        if (i === 2) {
            out.push({
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Turn 2 analysis: the subsystem's failure modes center on state recovery.", signature: "sig-turn2" },
                    { type: "text", text: `assistant ${i}: subsystem ${i} shows three notable failure modes centered on state recovery under load. ` + FILLER(100 + i, 8) },
                ],
            });
        } else {
            out.push({ role: "assistant", content: [{ type: "text", text: `assistant ${i}: subsystem ${i} shows three notable failure modes centered on state recovery under load. ` + FILLER(100 + i, 8) }] });
        }
    }
    out.push({ role: "user", content: [{ type: "text", text: `trigger: now patch the refresh-token rotation so a revoked token cannot mint a fresh one. ` + FILLER(900, 1.0) }] });
    return out;
};

function compressSse(startId: string, endId: string): string {
    const args = JSON.stringify({ startId, endId, topic: "fold", summary: "Folded the early subsystem-analysis turns; state-recovery failure modes and their remediation notes are retained in this summary." });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c_6632", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");
}

const TEXT_SSE = [
    anthropicSse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", usage: { input_tokens: 20 } } }),
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
    anthropicSse("message_stop", { type: "message_stop" }),
].join("");

interface Captured {
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    close(): Promise<void>;
}

async function startHarness(models: Record<string, { context: number }>): Promise<Harness> {
    const captured: Captured[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
            const sse = call === 0 ? compressSse("m00001", "m00002") : TEXT_SSE;
            call += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

const postMessages = async (h: Harness, sessionId: string, body: Record<string, unknown>): Promise<number> => {
    const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify(body),
    });
    await resp.text();
    return resp.status;
};

const thinkingBindingOf = (raw: string): unknown => {
    const sent = JSON.parse(raw) as Record<string, unknown>;
    const thinking = sent.thinking as Record<string, unknown> | undefined;
    return thinking?.block_binding;
};

const betaOf = (headers: Record<string, string | string[] | undefined>): string => {
    const v = headers["anthropic-beta"];
    return Array.isArray(v) ? v.join(",") : String(v ?? "");
};

test("#6632: Fable request after a fold carries drop_block + the beta header", async () => {
    const h = await startHarness({ "claude-fable-5-2": { context: 1_000_000 } });
    try {
        const base = {
            model: "claude-fable-5-2",
            max_tokens: 4096,
            thinking: { type: "enabled", budget_tokens: 1024 },
            stream: true,
            system: "You are a coding agent.",
        };
        // Request 1: the model compresses mid-turn; the fold commits.
        assert.equal(await postMessages(h, "issue6632-fable", { ...base, messages: buildTurns() }), 200);
        assert.ok(h.captured.length >= 2, `expected a round-2 re-request, got ${h.captured.length} upstream bodies`);
        assert.ok(h.captured[1]!.body.includes("tokens saved"), "compress committed — the post-fold view actually reached upstream");
        // The gate is on the request, not the fold: even the pre-fold forward
        // already carries the binding opt-in, so a fold created mid-request
        // rides into the round-2 re-request through the prepared body.
        assert.deepEqual(thinkingBindingOf(h.captured[0]!.body), { prefix_mismatch_behavior: "drop_block" });
        assert.ok(betaOf(h.captured[0]!.headers).includes(THINKING_BINDING_BETA), "beta header on the initial forward");
        assert.deepEqual(thinkingBindingOf(h.captured[1]!.body), { prefix_mismatch_behavior: "drop_block" });
        assert.ok(betaOf(h.captured[1]!.headers).includes(THINKING_BINDING_BETA), "beta header on the round-2 re-request");

        // Request 2: the very next turn on the same session — the exact step
        // that 400'd in the report. Its history still carries the signed
        // thinking block from before the fold.
        const history = [
            ...buildTurns(),
            { role: "assistant", content: [{ type: "text", text: "Done after compress" }] },
            { role: "user", content: [{ type: "text", text: "Continue the work." }] },
        ];
        assert.equal(await postMessages(h, "issue6632-fable", { ...base, messages: history }), 200);
        assert.ok(h.captured.length >= 3, `expected request 2 to reach upstream, got ${h.captured.length} upstream bodies`);
        const second = h.captured[2]!;
        assert.deepEqual(thinkingBindingOf(second.body), { prefix_mismatch_behavior: "drop_block" }, "post-fold request carries drop_block");
        assert.ok(betaOf(second.headers).includes(THINKING_BINDING_BETA), "post-fold request carries the beta header");
        // The fold is still in effect on this request: the fold summary rides
        // it, and the folded turn's assistant text is gone from the prefix —
        // exactly the rewrite that breaks Fable's thinking-block binding.
        assert.ok(second.body.includes("Folded the early subsystem-analysis turns"), "the fold summary rides the post-fold request");
        assert.ok(!second.body.includes("assistant 1: subsystem 1"), "the folded turn's assistant text is gone from the prefix");
        // The pre-fold signed thinking block survives into the outbound
        // history (the fix must not strip it — KDD #10).
        const sent = JSON.parse(second.body) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
        const thinkingBlocks = sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "thinking"));
        assert.equal(thinkingBlocks.length, 1, "the signed thinking block is still in the outbound history");
        assert.equal(thinkingBlocks[0]!.signature, "sig-turn2", "its signature is verbatim");
    } finally {
        await h.close();
    }
});

test("#6632 control: Opus carries neither drop_block nor the beta header", async () => {
    const h = await startHarness({ "claude-opus-5-5": { context: 1_000_000 } });
    try {
        const base = {
            model: "claude-opus-5-5",
            max_tokens: 4096,
            thinking: { type: "enabled", budget_tokens: 1024 },
            stream: true,
            system: "You are a coding agent.",
        };
        assert.equal(await postMessages(h, "issue6632-opus", { ...base, messages: buildTurns() }), 200);
        assert.ok(h.captured.length >= 1, "opus request reached upstream");
        for (const [i, c] of h.captured.entries()) {
            assert.equal(thinkingBindingOf(c.body), undefined, `opus upstream call ${i} must not carry block_binding`);
            assert.ok(!betaOf(c.headers).includes(THINKING_BINDING_BETA), `opus upstream call ${i} must not carry the binding beta`);
        }
    } finally {
        await h.close();
    }
});
