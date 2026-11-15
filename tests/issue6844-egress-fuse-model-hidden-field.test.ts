import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

// #6844: the measured-body egress fuse (0.1.214) sums messages + tools[] +
// system + `other`, and `other` catches every top-level body field not named
// one of those three. DSH 0.2.2-rc.x's default-on session-log plugin
// contributes a top-level `dsh_session_log` field (model-hidden provider
// metadata, maxBytes 8 MiB, documented as staying "outside model input"),
// which landed in `other`: in the reported incident `other` was 88% of the
// measured body while the model-visible buckets used 28% of budget, and an
// ordinary request was refused locally with HTTP 413 over payload the model
// never receives. DSH host fields (the `dsh_` namespace) must not be metered.
const t = (s: string): number => defaultCountTokens(s);

function incidentBody(): Record<string, unknown> {
    return {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hello model" }],
        system: "you are helpful",
        tools: [{ name: "search", description: "find things fast" }],
        // Model-hidden DSH provider metadata: must not be metered.
        dsh_session_log: "L".repeat(40_000),
        dsh_plugin_packages: "P".repeat(15_000),
        // A future DSH plugin field in the same host namespace.
        dsh_future_telemetry: "T".repeat(8_000),
        // Ordinary non-DSH top-level fields still count in `other`.
        metadata: { note: "structural note" },
        thinking: "enabled",
    };
}

test("model-hidden DSH top-level fields are not metered", () => {
    const body = incidentBody();
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("hello model"));
    assert.equal(bd.system, t("you are helpful"));
    assert.equal(bd.tools, t("search") + t("find things fast"));
    assert.equal(bd.other, t("deepseek-flash") + t("structural note") + t("enabled"));
    assert.equal(bd.total, bd.messages + bd.system + bd.tools + bd.other);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("a body of only model-hidden DSH fields measures zero", () => {
    const body = { dsh_session_log: "L".repeat(40_000), dsh_plugin_packages: "P".repeat(15_000) };
    assert.equal(estimateRawBodyTokens(body), 0);
    assert.deepEqual(estimateRawBodyBreakdown(body), { total: 0, messages: 0, tools: 0, system: 0, other: 0 });
});

test("the DSH exclusion is top-level only: a nested dsh key inside messages still counts", () => {
    const body = { messages: [{ role: "user", content: "hi", dsh_session_log: "nested" }] };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("hi") + t("nested"));
    assert.equal(bd.total, bd.messages);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("non-DSH top-level fields still count in other", () => {
    const body = { messages: [{ role: "user", content: "hi" }], custom_field: "custom payload" };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.other, t("custom payload"));
    assert.equal(bd.total, estimateRawBodyTokens(body));
});
