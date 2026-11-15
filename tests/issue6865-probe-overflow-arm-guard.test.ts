import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #6865: the #5974 "corrective second pass" probe inside
// preflightCompressIfNeeded writes a local estimate onto the session baseline
// WITHOUT an overflow-arm guard — demoting an ACTIVE overflow-arm tag to
// "estimate" BEFORE the #5880 fix's guarded post-rebuild anchor runs, so the
// session fit-forwards on a stale local estimate and sails past the upstream
// wall → 400 CONTEXT_WINDOW_EXCEEDED → re-arm → repeat (the #5880 livelock,
// re-opened on a different code path). The guard must hold the arm while the
// probe still writes for unarmed baselines.
//
// Pinned both directions (#3617), full-server, one boot, two sessions with
// the same history:
//   armed — a session preset with an overflow-arm baseline BELOW the probe's
//           rebuild measurement must keep the arm tag after a request that
//           folds and probes; the VALUE may net DOWN (the #252 compress
//           credit subtracts reclaimed tokens as the session genuinely
//           shrinks) but must never be RAISED to the probe estimate;
//   unarmed — a session preset with a plain usage baseline at the same value
//           must still take the probe estimate (value raised, source
//           "estimate"), i.e. the guard is overflow-arm-only.
//
// The fixture is #5974 case 5's: four 4.4K-tok plain runs (foldable pool
// 17.6K) over two hard-protected bash bulk pairs — the payload clears the
// 40K window after a handful of folds, so the walk exits early-fit with
// foldable mass left (compressedRanges > 0, rangesRemaining > 0) and the
// probe runs. The probe rebuild measures ~37K, above the 30K preset arm,
// so the unguarded write fires pre-fix.

const LIMIT = 40_000;
const ARMED_BASELINE = 30_000;
const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: this segment is a load-growth fixture whose every marker is derivable from its turn index.";

type Call = { summary: boolean; raw: string };
let CALLS: Call[] = [];

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockForwardingUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const isSummary = /TASK: The conversation segment below/.test(raw);
            CALLS.push({ summary: isSummary, raw });
            if (!isSummary) {
                if (raw.includes('"stream":true')) {
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.end(chatSse("forwarded answer", "stop"));
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: "chatcmpl-fwd", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "forwarded answer" }, finish_reason: "stop" }] }));
                }
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-sum", object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
        });
    });
}

async function bootE2E(): Promise<{ proxyPort: number; upstreamPort: number; cleanup: () => Promise<void> }> {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = mockForwardingUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: LIMIT } } } } as ProxyOptions["routes"],
        modelContextLimit: LIMIT,
        kernelConfig: defaultConfig(LIMIT, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            protectedTools: ["bash"],
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        cleanup: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function historyMessages(): Array<Record<string, unknown>> {
    const REPEAT = 2127;
    return [
        { role: "user", content: "OLD_WORK_A ".repeat(1600) },
        { role: "assistant", content: "ANSWER_A ".repeat(1600) },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
        { role: "tool", tool_call_id: "call_1", content: `BASH_RESULT_1_payload_`.repeat(REPEAT) },
        { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] },
        { role: "tool", tool_call_id: "call_2", content: `BASH_RESULT_2_payload_`.repeat(REPEAT) },
        { role: "user", content: "OLD_WORK_B ".repeat(1600) },
        { role: "assistant", content: "ANSWER_B ".repeat(1600) },
        { role: "user", content: "ok" },
        { role: "assistant", content: "done" },
    ];
}

test("#6865: the #5974 probe must not demote an active overflow-arm, but still writes for an unarmed baseline", async () => {
    CALLS = [];
    const p = await bootE2E();
    try {
        // Pre-arm one session exactly as armOverflowShrink would leave it
        // (ceiling 40K window, armed baseline 30K — below the ~37K probe
        // rebuild, i.e. the caliber-delta case), and give the other the
        // same value as a plain usage baseline. No origin stamped, so the
        // #1933 F2 demotion cannot zero either floor.
        const armed = getSession("issue6865-armed");
        armed.stats.lastInputTokens = ARMED_BASELINE;
        armed.stats.lastInputTokensSource = "overflow-arm";
        armed.stats.overflowArmTokens = LIMIT;
        const unarmed = getSession("issue6865-unarmed");
        unarmed.stats.lastInputTokens = ARMED_BASELINE;
        unarmed.stats.lastInputTokensSource = "usage";

        const post = (sessionId: string) => fetch(`http://127.0.0.1:${p.proxyPort}/bili/http://127.0.0.1:${p.upstreamPort}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model: "gpt-test", stream: true, messages: historyMessages() }),
        });

        const r1 = await post("issue6865-armed");
        const b1 = await r1.text();
        assert.equal(r1.status, 200, `the armed request must forward: HTTP ${r1.status} ${b1.slice(0, 240)}`);
        assert.ok(b1.includes("forwarded answer"), "the model reply must reach the client (armed)");
        // The probe ran (the walk folded: summaries exist) and the rebuild
        // measured above the 30K arm — pre-fix the write demoted the arm.
        assert.ok(CALLS.filter((c) => c.summary).length >= 1, "the walk must have summarized at least one range (armed)");
        const afterArmed = getSession("issue6865-armed");
        // #252: the fold nets its reclaimed tokens out of the baseline, so
        // the value legitimately drops as the session shrinks — the pin is
        // that no estimate write ever RAISES it, and the tag survives.
        assert.ok(afterArmed.stats.lastInputTokens <= ARMED_BASELINE, `the probe must never raise an armed baseline (got ${afterArmed.stats.lastInputTokens})`);
        assert.equal(afterArmed.stats.lastInputTokensSource, "overflow-arm", `the probe must not demote an active overflow-arm (got ${afterArmed.stats.lastInputTokensSource})`);

        const r2 = await post("issue6865-unarmed");
        const b2 = await r2.text();
        assert.equal(r2.status, 200, `the unarmed request must forward: HTTP ${r2.status} ${b2.slice(0, 240)}`);
        assert.ok(b2.includes("forwarded answer"), "the model reply must reach the client (unarmed)");
        const afterUnarmed = getSession("issue6865-unarmed");
        assert.ok(afterUnarmed.stats.lastInputTokens > ARMED_BASELINE, `an unarmed baseline must still take the probe estimate (got ${afterUnarmed.stats.lastInputTokens})`);
        assert.equal(afterUnarmed.stats.lastInputTokensSource, "estimate", `an unarmed baseline takes the probe estimate as before (got ${afterUnarmed.stats.lastInputTokensSource})`);

        assert.equal(CALLS.filter((c) => !c.summary).length, 2, `exactly two forwarded requests (got ${CALLS.filter((c) => !c.summary).length})`);
    } finally {
        await p.cleanup();
    }
});
