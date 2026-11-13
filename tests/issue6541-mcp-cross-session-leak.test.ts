// #6541: an external MCP client (ZCode) without a conversationId is arbitrated
// into an active DSH session, leaking that session's compression view. The fix
// has two halves and this suite pins the shim half: the MCP shim stamps every
// tool forward with `agent: "mcp"` (mirroring the `agent: "mcp"` its register
// call already sends), so the proxy can tell an MCP-forwarded id-less call
// from a plugin agent's call and refuse arbitration for the former. The proxy
// half (never arbitrate an MCP-forwarded id-less call) is pinned in
// tests/tool-ring.test.ts.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";

import { forwardTool as mcpForwardTool } from "../src/mcp.ts";

async function startCannedProxy(): Promise<{
    origin: string;
    bodies: Record<string, unknown>[];
    close(): Promise<void>;
}> {
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        if (req.url !== "/__bili/plugin/tool") { res.writeHead(404).end("nope"); return; }
        let raw = "";
        req.on("data", (d) => { raw += d; });
        req.on("end", () => {
            bodies.push(JSON.parse(raw) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: "ok" }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    let closed = false;
    return {
        origin: `http://127.0.0.1:${port}`,
        bodies,
        close: () => closed ? Promise.resolve() : (closed = true, new Promise<void>((r) => server.close(() => r()))),
    };
}

describe("#6541: the MCP shim stamps agent \"mcp\" on every tool forward", () => {
    let proxy: Awaited<ReturnType<typeof startCannedProxy>> | null = null;
    let prevEnv: string | undefined;

    beforeEach(async () => {
        proxy = await startCannedProxy();
        prevEnv = process.env.BILI_MCP_PROXY;
        process.env.BILI_MCP_PROXY = proxy.origin;
    });
    afterEach(async () => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
        if (proxy) await proxy.close();
    });

    it("id-less forward (the ZCode shape) carries agent mcp and no conversationId", async () => {
        assert.ok(proxy);
        const out = await mcpForwardTool("acp_status", {}, 3000);
        assert.equal(out.failed, false);
        assert.equal(proxy.bodies.length, 1);
        assert.equal(proxy.bodies[0]?.agent, "mcp");
        assert.equal(proxy.bodies[0]?.tool, "acp_status");
        assert.equal(proxy.bodies[0]?.conversationId, undefined, "no binding means no id is sent — the proxy must not invent an owner");
    });

    it("bound forward still carries agent mcp alongside the conversation id", async () => {
        assert.ok(proxy);
        const out = await mcpForwardTool("acp_status", {}, 3000, "conv-bound-6541");
        assert.equal(out.failed, false);
        assert.equal(proxy.bodies.length, 1);
        assert.equal(proxy.bodies[0]?.agent, "mcp");
        assert.equal(proxy.bodies[0]?.conversationId, "conv-bound-6541");
    });
});
