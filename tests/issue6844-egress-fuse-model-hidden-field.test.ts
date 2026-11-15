import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

// #6844: the measured-body egress fuse sums messages + tools[] + system +
// `other`, where `other` catches every top-level field not named one of those
// three. DSH (DeepSeek Harness) contributes top-level `dsh_*` fields —
// `dsh_session_log` (diagnostics, maxBytes 8 MiB) and `dsh_plugin_packages` —
// documented as staying outside model input. In the reported incident `other`
// was 88% of the measured body while the model-visible buckets used 28% of
// the input budget, so an ordinary request was refused locally with HTTP 413
// over payload the model never receives. The `dsh_` namespace is the host's
// own marker for model-hidden provider metadata: the walks must skip the
// whole subtree rooted at a top-level `dsh_*` key, in BOTH the breakdown and
// the flat token walk, so the `total == estimateRawBodyTokens` invariant
// still holds exactly.
const t = (s: string): number => defaultCountTokens(s);

const VISIBLE = {
    messages: [{ role: "user", content: [{ type: "text", text: "hello model" }] }],
    tools: [{ name: "search", description: "find things fast" }],
    system: "system prompt text",
};

test("top-level dsh_* fields are excluded from the measured body", () => {
    const log = "L".repeat(4096);
    const packages = "P".repeat(512);
    const body = { ...VISIBLE, dsh_session_log: log, dsh_plugin_packages: packages };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("text") + t("hello model"));
    assert.equal(bd.tools, t("search") + t("find things fast"));
    assert.equal(bd.system, t("system prompt text"));
    assert.equal(bd.other, 0);
    assert.equal(bd.total, bd.messages + bd.tools + bd.system);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("the dsh_ namespace rule covers fields the reporter has not named yet", () => {
    const body = { ...VISIBLE, dsh_future_plugin: "F".repeat(1024) };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.other, 0);
    assert.equal(bd.total, bd.messages + bd.tools + bd.system);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("unrelated top-level other fields still count, and dsh_ keys nested in messages still count", () => {
    const body = {
        ...VISIBLE,
        metadata: { note: "structural note" },
        messages: [{ role: "user", content: [{ type: "text", text: "hello model" }], dsh_session_log: "nested log" }],
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.other, t("structural note"));
    assert.equal(bd.messages, t("user") + t("text") + t("hello model") + t("nested log"));
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.other);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});
