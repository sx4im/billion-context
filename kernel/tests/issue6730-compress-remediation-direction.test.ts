import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6730: the batch-rejection remediation contradicted the validation it
// reported. A batch rejected because a summary was TOO SHORT told the model
// to "shorten or split each offending range's summary to fit its cap" —
// following that advice only made the summary shorter, so every retry failed
// again until the circuit breaker fired. The remediation must match the
// validation direction: too-short failures ask for a LONGER summary, too-long
// failures ask for a shorter one, and a mixed batch names both.

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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function stateWith(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("a too-short summary is told to lengthen, never to shorten (#6730)", () => {
  const core = createCore();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];

  // The reporter's exact shape: one range, a 2–3 line summary below the
  // 50-char floor. The old text answered "Summary too short" with
  // "shorten or split ... to fit its cap" — following it only failed again.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "short summary",
        topic: "too short",
      },
    ],
    messages,
    state: stateWith(messages),
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 0,
        minSummaryLength: 50,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /Batch rejected before folding any range/,
  );
  assert.match(
    result.result.errors[0]!,
    /range m00001\.\.m00002: Summary too short \(13 chars, min 50\)/,
  );
  assert.match(result.result.errors[0]!, /lengthen/);
  assert.doesNotMatch(result.result.errors[0]!, /shorten or split/);
  assert.doesNotMatch(result.result.errors[0]!, /to fit its cap/);
});

test("a too-long summary still keeps the shorten-or-split advice (#6730)", () => {
  const core = createCore();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "x".repeat(40),
        topic: "too long",
      },
      { startRef: "m00003", endRef: "m00004", summary: "ok", topic: "fine" },
    ],
    messages,
    state: stateWith(messages),
    config: config({
      compress: {
        minCompressRange: 0,
        maxSummaryLength: 20,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /range m00001\.\.m00002: Summary too long \(40 chars, max 20\)/,
  );
  assert.match(result.result.errors[0]!, /shorten or split/);
  assert.doesNotMatch(result.result.errors[0]!, /lengthen/);
});

test("a mixed batch names both directions (#6730)", () => {
  const core = createCore();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];

  // Range A is too long (40 chars, max 20); the combined total (40 + 5 = 45)
  // is below the batch floor of 50, so the batch also fails too-short. The
  // remediation must aim each direction at the side that actually failed.
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "x".repeat(40),
        topic: "too long",
      },
      {
        startRef: "m00003",
        endRef: "m00004",
        summary: "x".repeat(5),
        topic: "trivial",
      },
    ],
    messages,
    state: stateWith(messages),
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
  assert.match(
    result.result.errors[0]!,
    /Summary too long \(40 chars, max 20\)/,
  );
  assert.match(
    result.result.errors[0]!,
    /Batch summary too short \(45 chars across 2 ranges, min 50\)/,
  );
  assert.match(result.result.errors[0]!, /lengthen/);
  assert.match(result.result.errors[0]!, /shorten or split/);
});
