import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6730: the batch summary-length rejection told EVERY failure to "shorten
// or split each offending range's summary to fit its cap" — even when the
// failure was "Summary too short". Following that advice makes a too-short
// summary shorter, so every retry fails again until the circuit breaker
// fires. The remediation must match the failure direction: lengthen what is
// too short, shorten what is too long.

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
    compress: {
      minCompressRange: 0,
      maxSummaryLength: 0,
      minSummaryLength: 50,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function fourMsgState(): {
  state: ReturnType<typeof createInitialState>;
  messages: CoreMessage[];
} {
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

test("a too-short single-range summary is told to lengthen, never to shorten (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  // The issue shape verbatim: a 2-3 line summary (30 chars) below the
  // min-50 floor, rejected with "Summary too short".
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "x".repeat(30) }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  const error = result.result.errors[0]!;
  assert.match(error, /Batch rejected before folding any range/);
  assert.match(error, /Summary too short \(30 chars, min 50\)/);
  assert.match(
    error,
    /lengthen each offending range's summary to reach its minimum/,
  );
  assert.doesNotMatch(error, /shorten or split/);
  assert.doesNotMatch(error, /to fit its cap/);
});

test("a batch-total too-short rejection is told to lengthen, never to shorten (#6730)", () => {
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
  assert.equal(result.result.errors.length, 1);
  const error = result.result.errors[0]!;
  assert.match(
    error,
    /Batch summary too short \(40 chars across 2 ranges, min 50\)/,
  );
  assert.match(
    error,
    /lengthen each offending range's summary to reach its minimum/,
  );
  assert.doesNotMatch(error, /shorten or split/);
  assert.doesNotMatch(error, /to fit its cap/);
});

test("an empty summary is told to lengthen, never to shorten (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  const error = result.result.errors[0]!;
  assert.match(error, /Summary is empty/);
  assert.match(
    error,
    /lengthen each offending range's summary to reach its minimum/,
  );
  assert.doesNotMatch(error, /shorten or split/);
});

test("a mixed batch names both directions (#6730)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  // Range A exceeds the cap (too long); the combined total (40 + 5 = 45)
  // is below the floor (too short) — both directions fail at once.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "z".repeat(40) },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(5) },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 20,
        minSummaryLength: 50,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  const error = result.result.errors[0]!;
  assert.match(error, /Summary too long \(40 chars, max 20\)/);
  assert.match(
    error,
    /Batch summary too short \(45 chars across 2 ranges, min 50\)/,
  );
  assert.match(
    error,
    /lengthen summaries that are too short to reach their minimum/,
  );
  assert.match(error, /shorten or split summaries that are too long/);
});
