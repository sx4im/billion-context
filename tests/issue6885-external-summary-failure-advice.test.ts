import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { createSession } from "../src/session.ts";
import type { RewriteCtx } from "../src/stream.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

const WIRE_RAW = "Historical source src/example.ts:27 E_TEST; do not deploy; still add tests. ".repeat(90);

function wireContext(settings: unknown): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    config.externalSummary = settings;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session = createSession(`issue6885-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: WIRE_RAW },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: finish tests without deployment." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}

function wireArgs(ctx: RewriteCtx): Record<string, unknown> {
    return { content: [{ startId: ctx.session.state.messageRefs.byRaw.history, endId: ctx.session.state.messageRefs.byRaw.history }] };
}

// #6885: the reported chain — a stalled upstream burns the whole time budget
// and every candidate times out. The receipt must name the budget knobs, not
// the summary-length cap that was never the cause. Regression inference
// (AGENTS.md §7.3): the advice names config knobs only — no numbers, refs or
// positions the model could anchor on and propagate — so the exact advice
// clause is pinned here at the receipt level.
test("a timed-out external summary receipt names the budget, not the cap (#6885)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-6885-receipt-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    const server = http.createServer((_req, _res) => {
        // Stall: never respond, so the candidate burns its target budget.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    const settings = {
        enabled: true,
        budget: { totalTimeoutMs: 300, targetTimeoutMs: 150, maxSummaryBytes: 10_000 },
        targets: [{ name: "primary", protocol: "responses", url: `${base}/primary`, model: "summary-primary", credentialRef: "secret:primary" }],
    };
    try {
        const ctx = wireContext(settings);
        const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
        assert.equal(result.outcome, "refused", result.text);
        assert.ok(result.text.startsWith("[Compression FAILED"), result.text);
        assert.ok(
            result.text.includes("the configured time budget ran out before any candidate could finish, so raise the external-summary budget (budget.totalTimeoutMs / budget.targetTimeoutMs) or put a faster target first."),
            `budget advice missing from receipt: ${result.text}`,
        );
        assert.ok(!result.text.includes("raise compress.maxSummaryLength"), `cap advice must not appear on a timeout failure: ${result.text}`);
        assert.ok(result.text.includes("attempts=[t0:timeout"), `attempts missing from receipt: ${result.text}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
});
