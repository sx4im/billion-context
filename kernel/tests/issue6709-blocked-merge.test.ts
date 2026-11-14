/**
 * billion-context#6709 — regression: a merge whose turn-integrity conflict is
 * caused ONLY by BLOCKED partners must proceed instead of dead-ending.
 *
 * Shape (session-ad47cd30, 0.1.214): a giant tier-2 block b312 spans the
 * session; its turns are shredded — each turn's tool-call is BLOCKED (body
 * removed upstream by DSH native compression) and covered by b312, while its
 * result sits visible outside the merge span. The #5919 doomed check only
 * sees VISIBLE stranded partners, so the BLOCKED calls (covered by the
 * consumed block) are invisible to it: the exclusion ladder re-fails, the
 * extend rung refuses (>16 stranded partners), and the merge dies with the
 * "cannot satisfy turn integrity" fatal — forever, because a BLOCKED message
 * never ages into coverage. Old blocks can never distill; context sticks.
 *
 * Pinned behaviors (post-fix):
 *   1. BLOCKED-caused conflict, doomed set empty → the merge PROCEEDS: the
 *      consumed block distills, the BLOCKED members keep their coverage
 *      (transferred to the new block), and a warning names the count and the
 *      issue.
 *   2. Same shape with PLAIN (non-BLOCKED) calls → still refuses: the fix
 *      opens no floodgate for ordinary shredded turns.
 *   3. The #5919 pinned suite stays green — a VISIBLE stranded BLOCKED
 *      partner still no-ops (doomed non-empty), unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

const LONG = "Synthetic historical content, safe for public reproduction. ".repeat(
  120,
);
const SUMMARY = "Synthetic summary for this compression test. ".repeat(4);
const TURNS = 17;

const config = defaultConfig(
  255000,
  {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    isToolProtected: (t: string) =>
      t === "mcp__bili__acp_rule" || t === "mcp__bili__compress",
    isCompressTool: (t: string) =>
      t === "mcp__bili__compress" || t === "compress",
  } as never,
);

/**
 * Layout (refs assigned in order; BLOCKED ids keep the BLOCKED ref):
 *   u0 a0 | r1 k1 ... r17 k17 | far newuser | l1 ... l17
 * Turn i = {r_i, k_i, l_i} (call k_i, result l_i, toolCallId c<i>).
 * b312 (tier 2, active) covers every r_i + k_i + far. The merge range
 * b312..farRef spans exactly b312's coverage; the results l_i sit outside
 * the span, visible.
 */
function build(blockedCalls: boolean) {
  const core = createCore();
  const ids: string[] = ["u0", "a0"];
  for (let i = 1; i <= TURNS; i++) ids.push(`r${i}`, `k${i}`);
  ids.push("far", "newuser");
  for (let i = 1; i <= TURNS; i++) ids.push(`l${i}`);
  const messages: any[] = ids.map((id) => {
    if (id === "u0") return { id, role: "user", contentType: "text", text: LONG };
    if (id === "a0")
      return { id, role: "assistant", contentType: "text", text: "Previous work finished." };
    if (id.startsWith("r"))
      return { id, role: "assistant", contentType: "reasoning", text: LONG };
    if (id.startsWith("k")) {
      const i = id.slice(1);
      return {
        id,
        role: "assistant",
        contentType: "tool-call",
        toolName: "Read",
        toolCallId: `c${i}`,
        text: '{"path":"/tmp/a.txt"}',
      };
    }
    if (id.startsWith("l")) {
      const i = id.slice(1);
      return {
        id,
        role: "tool",
        contentType: "tool-result",
        toolName: "Read",
        toolCallId: `c${i}`,
        text: LONG,
      };
    }
    if (id === "far")
      return { id, role: "assistant", contentType: "text", text: "Far tail." };
    return { id, role: "user", contentType: "text", text: "Continue." };
  });
  const state = createInitialState();
  let n = 1;
  for (const m of messages) {
    const ref =
      blockedCalls && m.id.startsWith("k")
        ? "BLOCKED"
        : `m${String(n++).padStart(5, "0")}`;
    state.messageRefs.byRaw[m.id] = ref;
    if (ref !== "BLOCKED") state.messageRefs.byRef[ref] = m.id;
  }
  const seeded = core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: SUMMARY }],
  });
  const base = seeded.state.blocks[0]!;
  const giant: string[] = [];
  for (let i = 1; i <= TURNS; i++) giant.push(`r${i}`, `k${i}`);
  giant.push("far");
  seeded.state.blocks.push({
    ...base,
    blockId: "b312",
    runId: "r312",
    tier: 2,
    active: true,
    directMessageIds: [...giant],
    effectiveMessageIds: [...giant],
    compressedTokens: giant.length * 100,
    startRef: seeded.state.messageRefs.byRaw[giant[0]!]!,
    endRef: seeded.state.messageRefs.byRaw[giant[giant.length - 1]!]!,
  });
  seeded.state.nextBlockId = 100;
  seeded.state.nextRunId = 100;
  seeded.state.stats.compressionCount = 10;
  return {
    core,
    messages,
    state: seeded.state,
    farRef: state.messageRefs.byRaw["far"]!,
  };
}

function merge(core: any, messages: any[], state: any, farRef: string) {
  return core.applyCompression({
    messages,
    state,
    config,
    ranges: [{ startRef: "b312", endRef: farRef, summary: SUMMARY }],
  });
}

test("6709-1: BLOCKED-caused merge conflict proceeds instead of dead-ending", () => {
  const { core, messages, state, farRef } = build(true);
  const res = merge(core, messages, state, farRef);
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
  const merged = res.state.blocks.find((b: any) => b.blockId === "b100");
  assert.ok(merged, "the merged block b100 must be created");
  for (let i = 1; i <= TURNS; i++) {
    assert.ok(
      merged!.effectiveMessageIds.includes(`r${i}`),
      `b100 must cover r${i}`,
    );
    assert.ok(
      merged!.effectiveMessageIds.includes(`k${i}`),
      `b100 must cover BLOCKED k${i} (coverage transfers)`,
    );
  }
  assert.ok(merged!.effectiveMessageIds.includes("far"));
  assert.equal(res.state.blocks.find((b: any) => b.blockId === "b312")!.active, false);
  const note = res.result.warnings.find((w: string) => w.includes("6709"));
  assert.ok(
    note,
    `expected a #6709 warning, got: ${res.result.warnings.join(" | ")}`,
  );
  assert.ok(note!.includes("BLOCKED"));
});

test("6709-2: same shape with PLAIN calls still refuses (no floodgate)", () => {
  const { core, messages, state, farRef } = build(false);
  const res = merge(core, messages, state, farRef);
  assert.equal(res.result.blocksCreated, 0);
  assert.ok(
    !res.result.warnings.some((w: string) => w.includes("6709")),
    `the #6709 proceed path must not fire for plain calls, got: ${res.result.warnings.join(" | ")}`,
  );
});
