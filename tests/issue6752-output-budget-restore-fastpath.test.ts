// #6752: the output-budget restore must survive a watermark-fastpath hit.
//
// A dsh plugin session whose client shrinks max_tokens to 1 gets its budget
// restored by restoreOutputBudget (handle.ts) — which mutates the parsed
// object and logs success. On a watermark HIT, prepareOpenai re-derived every
// scalar field from the raw wire text, so the restored value was discarded
// and max_tokens: 1 was forwarded upstream while the log claimed the restore
// happened. This test drives two full-resend turns through a real proxy, in
// both phases of the fastpath (A/B): phase A with the feature OFF (legacy
// baseline), phase B with it ON (turn 0 seeds, turn 1 hits). Both turns in
// both phases must forward the restored budget (the route-declared output
// ceiling, 32768). The residency read proves turn 1 of phase B really hit:
// on a hit only the tail window is pinned, so its lastMessages bytes are a
// fraction of phase A's full-history snapshot.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import {
  SessionStore,
  _setStoreForTest,
  _resetStoreForTest,
} from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { closeServers } from "./server-close-guard.ts";

const ENV = "BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK";

interface Capture {
  raw: string;
}

function makeUpstream(sink: Capture[]) {
  return http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      sink.push({ raw: data });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "model-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "answer" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4,
            total_tokens: 104,
          },
        }),
      );
    });
  });
}

const TOOL = {
  type: "function",
  function: {
    name: "lookup",
    description: "test tool",
    parameters: { type: "object", properties: {} },
  },
};
const SYS = { role: "system", content: "You are TestBuddy v2." };
// Long first user turn: the hit's tail window (ack 0 + beta) is a small
// fraction of the full 4-message history, so the residency ratio is robust.
const LONG_ALPHA = `alpha ${"x".repeat(4000)}`;

async function runClient(
  origin: string,
  upstreamUrl: string,
  sid: string,
): Promise<(number | null)[]> {
  const stamps: (number | null)[] = [];
  const turns: Array<{ messages: unknown[] }> = [
    { messages: [SYS, { role: "user", content: LONG_ALPHA }] },
    {
      messages: [
        SYS,
        { role: "user", content: LONG_ALPHA },
        { role: "assistant", content: "ack 0" },
        { role: "user", content: "beta" },
      ],
    },
  ];
  for (let i = 0; i < turns.length; i++) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-acp-session": sid,
      "x-bili-plugin": "dsh",
    };
    const prev = stamps[stamps.length - 1];
    if (prev !== null && prev !== undefined)
      headers["x-bili-pf-count"] = String(prev);
    const res = await fetch(
      `${origin}/bili/${upstreamUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "model-test",
          stream: false,
          max_tokens: 1,
          tools: [TOOL],
          ...turns[i],
        }),
      },
    );
    assert.equal(res.status, 200, `turn ${i}: proxy answers 200`);
    const s = res.headers.get("x-bili-pf-seq");
    stamps.push(s !== null && /^\d+$/.test(s) ? Number(s) : null);
    await res.arrayBuffer();
  }
  return stamps;
}

interface PhaseResult {
  turn0Max: unknown;
  turn1Max: unknown;
  lastMessagesBytes: number;
}

async function runPhase(flag: string, sid: string): Promise<PhaseResult> {
  process.env[ENV] = flag;
  _resetStoreForTest();
  _resetPluginStateForTest();
  _resetSessionsForTest();
  const root = mkdtempSync(path.join(os.tmpdir(), "pf6752-"));
  for (const k of [
    "HOME",
    "APPHOME",
    "HERMES_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ])
    process.env[k] = root;
  const store = new SessionStore({
    dir: path.join(root, "sessions"),
    enabled: false,
  });
  _setStoreForTest(store);
  const captured: Capture[] = [];
  const upstream = makeUpstream(captured);
  let proxy: ReturnType<typeof startServer> extends Promise<infer T>
    ? T
    : never;
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    proxy = await startServer({
      port: 0,
      host: "127.0.0.1",
      upstream: upstreamUrl,
      routes: {
        [upstreamUrl]: {
          models: { "model-test": { context: 64_000, output: 32_768 } },
        },
      },
      modelContextLimit: 200_000,
      kernelConfig: defaultConfig(200_000),
      compress: { injectTool: false, injectNudge: false },
      promptCache: { routing: "auto" },
      sessionHeader: "x-acp-session",
      log: true,
      debug: true,
      passthrough: false,
      autoUpdate: false,
      mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;

    // With the feature OFF no x-bili-pf-seq stamp is written at all, so
    // the stamp assertions only apply to the ON phase.
    const stamps = await runClient(origin, upstreamUrl, sid);
    assert.equal(captured.length, 2, "both turns reached upstream");
    if (flag === "1") {
      // Turn 0 seeds on the legacy path; turn 1 echoes the stamp and hits.
      assert.equal(stamps[0], 2, "turn 0 stamps the 2-message wire total");
      assert.equal(stamps[1], 4, "turn 1 stamps the 4-message wire total");
    }

    const turn0 = JSON.parse(captured[0].raw) as { max_tokens?: unknown };
    const turn1 = JSON.parse(captured[1].raw) as { max_tokens?: unknown };
    const mem = (await (await fetch(`${origin}/__bili/memory`)).json()) as {
      breakdown: { lastMessages: number };
    };
    assert.ok(mem.breakdown.lastMessages > 0, "session pinned a snapshot");

    store.cancelAll();
    await closeServers([proxy, upstream], sid);
    return {
      turn0Max: turn0.max_tokens,
      turn1Max: turn1.max_tokens,
      lastMessagesBytes: mem.breakdown.lastMessages,
    };
  } finally {
    // Close even on failure: a listening server keeps the runner alive.
    try {
      await closeServers([proxy!, upstream], sid);
    } catch {
      /* already closed */
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("#6752 output-budget restore survives a watermark-fastpath hit", async () => {
  const savedEnv = process.env[ENV];
  try {
    // Phase A: feature OFF — legacy baseline for both the budget and the
    // residency size.
    const a = await runPhase("0", "pf6752-a");
    assert.equal(
      a.turn0Max,
      32_768,
      "phase A turn 0 (legacy): restored budget forwarded",
    );
    assert.equal(
      a.turn1Max,
      32_768,
      "phase A turn 1 (legacy): restored budget forwarded",
    );
    // Phase B: feature ON — turn 0 seeds (legacy, no stamp yet), turn 1
    // echoes the stamp and hits the fastpath.
    const b = await runPhase("1", "pf6752-b");
    assert.equal(
      b.turn0Max,
      32_768,
      "phase B turn 0 (legacy seed): restored budget forwarded",
    );
    // Pre-fix this is 1: the fastpath re-derived max_tokens from the raw
    // wire text, discarding the restore that the log reports as done.
    assert.equal(
      b.turn1Max,
      32_768,
      "phase B turn 1 (fastpath hit): restored budget forwarded, not the client's 1",
    );
    // Hit proof: on a hit only the tail window is pinned, so phase B's
    // lastMessages bytes are a fraction of phase A's full-history snapshot.
    assert.ok(
      b.lastMessagesBytes < 0.8 * a.lastMessagesBytes,
      `turn 1 must have hit (phase B lastMessages ${b.lastMessagesBytes}B vs phase A ${a.lastMessagesBytes}B)`,
    );
  } finally {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  }
});
