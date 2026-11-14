import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6730: the batch rejection's remediation contradicted its own verdict.
// A too-short summary ("Summary too short (NN chars, min 50)") was told to
// "shorten or split each offending range's summary to fit its cap" —
// following the advice made the summary shorter and even less compliant,
// so the model retried into a loop until the circuit breaker fired. The
// remediation must match the failure DIRECTION: too-short failures say
// "lengthen ... to at least the minimum" (no "shorten", no "cap"); too-long
// failures keep the old wording; a mixed batch gets both directions.

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function fourMsgState(): { state: ReturnType<typeof createInitialState>; messages: CoreMessage[] } {
  const state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { state, messages };
}

test("the issue shape: a single too-short summary is told to LENGTHEN, never to shorten (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "short summary", topic: "t" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  const error = result.result.errors[0]!;
  assert.match(error, /Batch rejected before folding any range/);
  assert.match(error, /Summary too short \(13 chars, min 50\)/);
  // The remediation must point the right way — and must not mention the cap,
  // which belongs to the too-long side only.
  assert.match(error, /lengthen each offending range's summary to at least the minimum/);
  assert.doesNotMatch(error, /shorten or split/);
  assert.doesNotMatch(error, /to fit its cap/);
  // The drop alternative is still offered.
  assert.match(error, /drop the offending range\(s\) and resend only the rest/);
});

test("a batch whose TOTAL is below the floor is told to lengthen, never to shorten (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(20) },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(20) },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  const error = result.result.errors[0]!;
  assert.match(error, /Batch summary too short \(40 chars across 2 ranges, min 50\)/);
  assert.match(error, /lengthen each offending range's summary to at least the minimum/);
  assert.doesNotMatch(error, /shorten or split/);
  assert.doesNotMatch(error, /to fit its cap/);
});

test("an EMPTY summary is told to lengthen, never to shorten (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60) },
      { startRef: "m00003", endRef: "m00004", summary: "" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  const error = result.result.errors[0]!;
  assert.match(error, /Summary is empty/);
  assert.match(error, /lengthen each offending range's summary to at least the minimum/);
  assert.doesNotMatch(error, /shorten or split/);
});

test("a too-long summary keeps the old shorten-or-split remediation (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(40), topic: "too long" },
      { startRef: "m00003", endRef: "m00004", summary: "ok", topic: "fine" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  const error = result.result.errors[0]!;
  assert.match(error, /Summary too long \(40 chars, max 20\)/);
  assert.match(error, /shorten or split each offending range's summary to fit its cap/);
  assert.doesNotMatch(error, /lengthen/);
});

test("a MIXED batch (one too-long, total too short) gets both directions (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "z".repeat(40), topic: "too long" },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(5), topic: "trivial" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  const error = result.result.errors[0]!;
  assert.match(error, /Summary too long \(40 chars, max 20\)/);
  assert.match(error, /Batch summary too short \(45 chars across 2 ranges, min 50\)/);
  assert.match(
    error,
    /lengthen each too-short summary to at least the minimum and shorten or split each too-long summary to fit its cap/,
  );
});
