/**
 * billion-context#6709 — regression: a BLOCKED stranded partner vetoed the
 * WHOLE merge even when the exclusion ladder could complete it around the
 * offending block.
 *
 * Field shape (session-ad47cd30, 0.1.214): b312 (tier 2) covers 0..44600 and
 * 6,115 messages carry ref='BLOCKED' (13.7%). Merging b312..b315 failed with
 * "cannot satisfy turn integrity" and every retry re-failed the same way —
 * the merge dead-ended while the clean blocks in the range could still
 * distill. Root cause: the #5919 doomed-partner check ran BEFORE the #5789
 * exclusion ladder (rung 1), so one never-foldable stranded partner skipped
 * the entire merge instead of letting the ladder exclude its owning block
 * and complete around it.
 *
 * Pinned behaviors (post-fix):
 *   1. Merge spanning a poison block whose stranded partner is BLOCKED →
 *      the ladder excludes the poison block, the clean blocks distill, the
 *      poison block stays ACTIVE, the BLOCKED partner stays visible, and no
 *      existing coverage is dropped.
 *   2. Self-range of the poison block with a BLOCKED stranded partner →
 *      still the #5919 no-op skip (rung 2 must never extend the fold to a
 *      never-foldable partner, and rung 1 cannot complete that span).
 *   3. The #5919 suite stays green — a merge whose ONLY completion path
 *      runs through a BLOCKED partner still no-ops with exact guidance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState, coveredMessageIds } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

const isToolProtected = (t?: string) =>
  t === "mcp__bili__acp_rule" || t === "mcp__bili__compress";
const isCompressTool = (t?: string) =>
  t === "mcp__bili__compress" || t === "compress";

const config = defaultConfig(255000, {
  preserveRecentMessages: 0,
  preserveRecentTokens: 0,
  isToolProtected,
  isCompressTool,
} as never);

const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);
const LONG =
  "Synthetic historical content, safe for public reproduction. ".repeat(150);

function lostCoverage(before: Set<string>, state: CompressionState): string[] {
  const after = coveredMessageIds(state);
  return [...before].filter((id) => !after.has(id));
}

/** #5789 user-shape fixture, with the tail result l2 carrying ref BLOCKED:
 *  b4 covers reasoning+call while the result stays live AFTER the last block
 *  anchor — and its body is gone (DSH native compression removed it), so it
 *  can never fold. Refs: u0=m00001 a0=m00002 r1=m00003 k1=m00004 l1=m00005
 *  u1=m00006 a1=m00007 r2=m00008 k2=m00009 l2=BLOCKED t2=m00010
 *  new-user=m00011. */
function buildBlockedTailFixture() {
  const core = createCore();
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: LONG },
    { id: "a0", role: "assistant", contentType: "text", text: "Previous work finished." },
    { id: "r1", role: "assistant", contentType: "reasoning", text: "Inspect the current state." },
    { id: "k1", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "c1", text: '{"path":"/tmp/a.txt"}' },
    { id: "l1", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "c1", text: LONG },
    { id: "u1", role: "user", contentType: "text", text: LONG },
    { id: "a1", role: "assistant", contentType: "text", text: "More prior context." },
    { id: "r2", role: "assistant", contentType: "reasoning", text: "Check the tail." },
    { id: "k2", role: "assistant", contentType: "tool-call", toolName: "Read", toolCallId: "c2", text: '{"path":"/tmp/b.txt"}' },
    // b4 below covers r2,k2 ONLY — its tail cut mid-tool-group; l2 stays live.
    { id: "l2", role: "tool", contentType: "tool-result", toolName: "Read", toolCallId: "c2", text: LONG },
    { id: "t2", role: "assistant", contentType: "text", text: "Tail turn done." },
    { id: "new-user", role: "user", contentType: "text", text: "Continue." },
  ];
  const state = createInitialState();
  let nextRef = 1;
  for (const m of messages) {
    const ref =
      m.id === "l2" ? "BLOCKED" : `m${String(nextRef++).padStart(5, "0")}`;
    state.messageRefs.byRaw[m.id] = ref;
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = m.id;
  }
  const seeded = core.applyCompression({
    messages,
    state,
    config,
    ranges: [
      {
        startRef: state.messageRefs.byRaw["u0"]!,
        endRef: state.messageRefs.byRaw["a0"]!,
        summary: SUMMARY,
      },
    ],
  });
  if (seeded.result.blocksCreated !== 1 || seeded.result.errors.length !== 0) {
    throw new Error(`fixture seed failed: ${JSON.stringify(seeded.result)}`);
  }
  const push = (blockId: string, runId: string, ids: string[], tier = 1) => {
    seeded.state.blocks.push({
      ...seeded.state.blocks[0]!,
      blockId,
      runId,
      tier,
      directMessageIds: [...ids],
      effectiveMessageIds: [...ids],
      compressedTokens: ids.length * 100,
      startRef: state.messageRefs.byRaw[ids[0]!]!,
      endRef: state.messageRefs.byRaw[ids[ids.length - 1]!]!,
    });
  };
  push("b2", "r2", ["r1", "k1", "l1"]);
  push("b3", "r3", ["u1", "a1"]);
  push("b4", "r4", ["r2", "k2"]);
  seeded.state.nextBlockId = 5;
  seeded.state.nextRunId = 5;
  seeded.state.stats.compressionCount = 4;
  return { core, messages, state: seeded.state };
}

test("6709-1: BLOCKED stranded partner must not veto the merge the ladder can complete", () => {
  const { core, messages, state } = buildBlockedTailFixture();
  const before = coveredMessageIds(state);
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b1", endRef: "b4", summary: SUMMARY }],
  });
  assert.equal(res.result.errors.length, 0, JSON.stringify(res.result.errors));
  assert.equal(res.result.blocksCreated, 1, JSON.stringify(res.result));
  assert.deepEqual(
    lostCoverage(before, res.state),
    [],
    "no existing coverage may be dropped",
  );
  const byId = new Map(res.state.blocks.map((b) => [b.blockId, b]));
  assert.equal(byId.get("b4")?.active, true, "poison block must stay active");
  for (const id of ["b1", "b2", "b3"]) {
    assert.equal(byId.get(id)?.active, false, `${id} must be consumed`);
  }
  const merged = res.state.blocks.find((b) => b.active && b.blockId !== "b4");
  assert.ok(merged, "a new merged block must exist");
  assert.equal(merged.tier, 2);
  assert.deepEqual(
    new Set(merged.effectiveMessageIds),
    new Set(["u0", "a0", "r1", "k1", "l1", "u1", "a1"]),
  );
  assert.ok(
    !merged.effectiveMessageIds.includes("l2"),
    "the BLOCKED partner must stay visible, never folded",
  );
  assert.ok(
    res.result.warnings.some((w) => w.includes("b4")),
    `exclusion warning must name b4: ${JSON.stringify(res.result.warnings)}`,
  );
  assert.ok(
    !res.result.warnings.some((w) => w.startsWith("Merge of b1")),
    `the whole-merge skip must not fire: ${JSON.stringify(res.result.warnings)}`,
  );
});

test("6709-2: poison-block self-range with a BLOCKED partner still no-ops, never extends to it", () => {
  const { core, messages, state } = buildBlockedTailFixture();
  const before = coveredMessageIds(state);
  const res = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b4", endRef: "b4", summary: SUMMARY }],
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 0);
  assert.equal(res.state.blocks.find((b) => b.blockId === "b4")!.active, true);
  assert.deepEqual(lostCoverage(before, res.state), []);
  const skip = res.result.warnings.find((w) =>
    w.startsWith("Merge of b4 skipped"),
  );
  assert.ok(
    skip,
    `expected the skip warning naming the blocked merge, got: ${JSON.stringify(res.result.warnings)}`,
  );
  assert.ok(skip!.includes("Do not retry this merge"));
  assert.ok(skip!.includes("BLOCKED"));
});
