// #6752: output-budget restore is lost on watermark-fastpath HIT turns.
//
// The dsh plugin lane re-sends the full history every turn. With the
// full-resend watermark fastpath enabled, a verified HIT rebuilds `parsed`
// from the RAW bodyText spans inside prepareOpenai — but handle.ts already
// ran restoreOutputBudget on `parsed` before prepare, so the rebuilt object
// carries the client's starved max_tokens (1) while the log reports the
// restore (1 -> 32768). The upstream then truncates every reply at 1 token.
//
// Regression: two turns through a real proxy (fastpath forced on). Turn 1
// (unseeded miss) must forward the restored budget; turn 2 (verified HIT,
// prefix unchanged, stamp echoed like the dsh native interceptor) must
// forward it too. The captured "fastpath HIT" log line proves turn 2
// actually took the hit path — without it the test would pass vacuously
// through the legacy path.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
import { setLogCapture } from "../src/logger.ts";
import { closeServers } from "./server-close-guard.ts";

process.env.BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK = "1";

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "test tool",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

function makeUpstream(sink: string[]) {
  return http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      sink.push(data);
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

// Same hermetic msgid stand-in as the #5418 golden: FNV-1a of the element bytes.
function idOf(el: unknown): string {
  const s = JSON.stringify(el);
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `eid-${h.toString(16)}`;
}

test("#6752: restored output budget survives a watermark-fastpath HIT turn", async () => {
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

  const captured: string[] = [];
  const upstream = makeUpstream(captured);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const uaddr = upstream.address();
  assert(uaddr && typeof uaddr === "object");
  const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;

  const proxy = await startServer({
    port: 0,
    host: "127.0.0.1",
    upstream: upstreamUrl,
    routes: {
      [upstreamUrl]: {
        models: { "model-test": { context: 200_000, output: 32768 } },
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

  const logs: Array<{ level: string; msg: string }> = [];
  setLogCapture((level, msg) => logs.push({ level, msg }));
  try {
    const sid = "pf6752-session";
    const sys = { role: "system", content: "You are TestBuddy." };
    const u1 = { role: "user", content: "hello" };
    const a1 = { role: "assistant", content: "ack" };
    const u2 = { role: "user", content: "again" };

    // Turn 1: unseeded miss — restore must fire on the legacy path.
    const turn1 = {
      model: "model-test",
      stream: false,
      max_tokens: 1,
      messages: [sys, u1],
      tools: [TOOL],
    };
    let res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acp-session": sid,
        "x-bili-plugin": "dsh",
      },
      body: JSON.stringify(turn1),
    });
    assert.equal(res.status, 200, "turn 1: proxy answers 200");
    await res.arrayBuffer();
    const stamp = res.headers.get("x-bili-pf-seq");
    assert.ok(
      stamp !== null && /^\d+$/.test(stamp),
      `turn 1 stamps a watermark seq, got ${stamp}`,
    );

    // Turn 2: same prefix + one new message, stamp echoed like the dsh
    // native interceptor — the fastpath must HIT.
    const msgs2 = [sys, u1, a1, u2];
    const ids2 = msgs2.map(idOf);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-acp-session": sid,
      "x-bili-plugin": "dsh",
      "x-bili-pf-count": stamp,
    };
    if (ids2.length >= Number(stamp)) {
      headers["x-bili-pf-tail-ids"] = ids2
        .slice(Number(stamp) - 1)
        .map(encodeURIComponent)
        .join(",");
    }
    const turn2 = {
      model: "model-test",
      stream: false,
      max_tokens: 1,
      messages: msgs2,
      tools: [TOOL],
    };
    res = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(turn2),
    });
    assert.equal(res.status, 200, "turn 2: proxy answers 200");
    await res.arrayBuffer();

    assert.equal(
      captured.length,
      2,
      `expected 2 upstream bodies, got ${captured.length}`,
    );
    const body1 = JSON.parse(captured[0]) as Record<string, unknown>;
    const body2 = JSON.parse(captured[1]) as Record<string, unknown>;
    // Control: the miss/legacy path restores the starved budget.
    assert.equal(
      body1.max_tokens,
      32768,
      `turn 1 (miss) must forward the restored budget, got ${body1.max_tokens}`,
    );
    // Regression: the HIT path must forward the restored budget too —
    // unfixed code forwards the client's starved max_tokens: 1.
    assert.equal(
      body2.max_tokens,
      32768,
      `turn 2 (HIT) must forward the restored budget, got ${body2.max_tokens}`,
    );

    // Prove turn 2 actually took the hit path (else this passes vacuously).
    assert.ok(
      logs.some((e) => e.msg.includes("fastpath HIT")),
      `expected a "fastpath HIT" log line for turn 2; fastpath lines: ${logs
        .filter((e) => e.msg.includes("fastpath"))
        .map((e) => e.msg)
        .join(" | ")}`,
    );
  } finally {
    setLogCapture(null);
    await closeServers([proxy, upstream], "pf6752");
  }
});
