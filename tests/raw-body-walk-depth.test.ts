import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";

// #6038: client-controlled request bodies may nest far beyond safe recursion
// depth; the raw-body token walks must survive them without changing any
// accounting (key inheritance, NON_TEXT_BODY_KEYS exclusion, top-level
// bucketing, total invariant).
const DEPTH = 20_000;
const t = (s: string): number => defaultCountTokens(s);

function deepObjectBody(): { body: Record<string, unknown>; counted: number } {
    const leaves: string[] = [];
    let node: Record<string, unknown> = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) },
        caption: "deep payload",
    };
    leaves.push("image", "base64", "image/png", "deep payload");
    for (let i = 0; i < DEPTH; i++) {
        leaves.push("wrapper");
        node = { kind: "wrapper", index: i, child: node };
    }
    leaves.push("user", "block");
    const body = { messages: [{ role: "user", content: [{ kind: "block", payload: node }] }] };
    return { body, counted: leaves.reduce((sum, s) => sum + t(s), 0) };
}

test("raw-body token estimate survives deeply nested object chains", () => {
    const { body, counted } = deepObjectBody();
    assert.equal(estimateRawBodyTokens(body), counted);
});

test("raw-body breakdown survives deep nesting and keeps the total invariant", () => {
    const { body, counted } = deepObjectBody();
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, counted);
    assert.equal(bd.tools, 0);
    assert.equal(bd.system, 0);
    assert.equal(bd.other, 0);
    assert.equal(bd.total, counted);
    assert.equal(bd.total, estimateRawBodyTokens(body));
});

test("raw-body walks keep key inheritance through deep array chains", () => {
    let inner: unknown = { url: "data:text/plain;base64,QUJD", text: "tail leaf" };
    for (let i = 0; i < DEPTH; i++) inner = [inner];
    const body = { messages: [inner] };
    assert.equal(estimateRawBodyTokens(body), t("tail leaf"));
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("tail leaf"));
    assert.equal(bd.total, t("tail leaf"));
});

test("shallow plumbing: exclusion set, key inheritance and bucket split stay intact", () => {
    const media = "QUJDREVGRw==";
    const body = {
        system: "system prompt text",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "hello message" },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: media } },
                ],
            },
        ],
        tools: [{ name: "search", description: "find things fast" }],
        image_url: "data:image/png;base64," + media,
        metadata: { note: "structural note" },
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("text") + t("hello message") + t("image") + t("base64") + t("image/png"));
    assert.equal(bd.system, t("system prompt text"));
    assert.equal(bd.tools, t("search") + t("find things fast"));
    assert.equal(bd.other, t("structural note"));
    assert.equal(bd.total, bd.messages + bd.system + bd.tools + bd.other);
    assert.equal(estimateRawBodyTokens(body), bd.total);
});

test("non-object top-level bodies land whole in the other bucket", () => {
    const bd = estimateRawBodyBreakdown("plain string body");
    assert.deepEqual(bd, { total: t("plain string body"), messages: 0, tools: 0, system: 0, other: t("plain string body") });
    assert.equal(estimateRawBodyTokens("plain string body"), t("plain string body"));
});

// #6828: the conversation/system top-level keys differ by wire — the
// breakdown's messages/system buckets must hold the model-visible content
// on every protocol, so `messages + tools + system` is the billable
// subtotal the doom gates judge; `other` is then exactly the
// model-invisible remainder. `total` still equals estimateRawBodyTokens.
test("raw-body breakdown buckets the conversation/system keys per protocol (#6828)", () => {
    const responses = {
        model: "deepseek-flash",
        input: [{ type: "message", role: "user", content: "hello response" }],
        instructions: "be helpful",
        tools: [{ type: "function", name: "search" }],
        metadata: { note: "structural note" },
    };
    const bdR = estimateRawBodyBreakdown(responses, "responses");
    assert.equal(bdR.messages, t("message") + t("user") + t("hello response"));
    assert.equal(bdR.system, t("be helpful"));
    assert.equal(bdR.tools, t("function") + t("search"));
    assert.equal(bdR.other, t("deepseek-flash") + t("structural note"));
    assert.equal(bdR.total, estimateRawBodyTokens(responses));

    const google = {
        model: "deepseek-flash",
        contents: [{ role: "user", parts: [{ text: "hello google" }] }],
        systemInstruction: { parts: [{ text: "be helpful" }] },
        tools: [{ functionDeclarations: [{ name: "search" }] }],
        generationConfig: { temperature: 0.5 },
    };
    const bdG = estimateRawBodyBreakdown(google, "google");
    assert.equal(bdG.messages, t("user") + t("hello google"));
    assert.equal(bdG.system, t("be helpful"));
    assert.equal(bdG.tools, t("search"));
    assert.equal(bdG.other, t("deepseek-flash"));
    assert.equal(bdG.total, estimateRawBodyTokens(google));

    // Explicit openai protocol matches the legacy default bucketing.
    const openai = {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "hello openai" }],
        system: "be helpful",
        tools: [{ type: "function", name: "search" }],
        metadata: { note: "structural note" },
    };
    assert.deepEqual(estimateRawBodyBreakdown(openai, "openai"), estimateRawBodyBreakdown(openai));
});

test("raw-body breakdown: a giant model-invisible field lands in other while the billable subtotal fits (#6828)", () => {
    // Incident shape: messages ~126K, tools ~76K, system ~10K, other ~1.6M
    // — the raw total reads ~1.8M against a 1M window while the billable
    // content is ~213K. The fuse must judge the subtotal, not the total.
    const body = {
        model: "deepseek-flash",
        messages: [{ role: "user", content: "数".repeat(126_000) }],
        tools: [{ type: "function", function: { name: "f", description: "d".repeat(305_900) } }],
        system: "中".repeat(10_600),
        metadata: { snapshot: "a".repeat(1_602_302 * 4) },
    };
    const bd = estimateRawBodyBreakdown(body, "openai");
    assert.ok(bd.messages > 125_000 && bd.messages < 127_000, `messages bucket holds the conversation (got ${bd.messages})`);
    assert.ok(bd.tools > 76_000 && bd.tools < 77_000, `tools bucket holds the schemas (got ${bd.tools})`);
    assert.ok(bd.system > 10_000 && bd.system < 11_000, `system bucket holds the prompt (got ${bd.system})`);
    assert.ok(bd.other > 1_600_000, `other holds the invisible snapshot (got ${bd.other})`);
    const visible = bd.messages + bd.tools + bd.system;
    assert.ok(visible < 1_000_000, `billable subtotal fits the floored fuse bar (got ${visible})`);
    assert.ok(bd.total > 1_000_000, `raw total still exceeds it (got ${bd.total})`);
    assert.equal(bd.total, bd.messages + bd.tools + bd.system + bd.other);
    assert.equal(bd.total, estimateRawBodyTokens(body));
});
