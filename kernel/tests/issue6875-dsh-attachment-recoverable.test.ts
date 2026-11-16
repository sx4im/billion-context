// #6875: DSH image messages (read_image / screenshots) are permanently
// BLOCKED and can never be compressed: ~160K tokens stuck.
//
// The tool results carry `{type:"image", attachment:{attachmentId,
// mediaType, bytes, ...}}` — a local-blob re-access handle into the DSH
// attachment library (content-addressed store, blobs verified present by
// the reporter: 504 attachments, missing=0). Two halves, same PR
// (maintainer triage 2026-11-16):
//   ① openaiToCore's case "tool" dropped every non-text part, so the
//      attachment never entered any CoreMessage and the classifier never
//      saw it — the codec half retains image parts on rawOpenaiContentParts.
//   ② extractMediaRefs did not enumerate the shape — the classifier half
//      recognizes attachmentId (legacy spelling `id`) as a ref-recoverable
//      handle, so hasUnrecoverableMediaPayload flips false and the #2607
//      stale-BLOCKED migration fires on the next compress.
// Trap (maintainer): ① without ② would newly pin currently-foldable
// messages (opaque part + no ref = UNRECOVERABLE) — both halves land
// together or not at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMediaRefs,
  hasRefRecoverableMediaPayload,
  collectFoldMediaRefs,
  MEDIA_REFS_MARKER,
} from "../src/media-refs.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { coreToOpenai, openaiToCore } from "../src/wire/openai.js";
import type { Config, CoreMessage } from "../src/types.js";

// Live shape from #6875 (DSH 0.2.2-rc.3): attachmentId is the blob key in
// the DSH attachment library (a sha256); bytes is the BYTE COUNT, not an
// inline payload (maintainer triage 2026-11-16) — the classifier must not
// depend on its content. The tool result's text part carries the same
// handle as text (sha256 + local store path).
const ATTACHMENT_ID =
  "6d0d1ca416fa10d7f2ab80db8bd12eeaf72f2c418a8171308ff7b658d45f9e66";
const DSH_PART = {
  type: "image",
  attachment: {
    attachmentId: ATTACHMENT_ID,
    mediaType: "image/png",
    bytes: 12345,
  },
};

function sidecarMsg(id: string, extra: object): CoreMessage {
  return Object.assign(
    { id, role: "user" as const, contentType: "text" as const, text: "" },
    extra,
  );
}

function textMsg(id: string, role: CoreMessage["role"], text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(): Config {
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
  };
}

test("extractMediaRefs recognizes the DSH attachment handle in rawOpenaiContentParts (#6875)", () => {
  assert.deepEqual(
    extractMediaRefs(sidecarMsg("a", { rawOpenaiContentParts: [DSH_PART] })),
    [ATTACHMENT_ID],
    "dsh read_image part — attachmentId is the re-access handle",
  );
  assert.deepEqual(
    extractMediaRefs(sidecarMsg("b", { rawOpenaiContent: DSH_PART })),
    [ATTACHMENT_ID],
    "same shape on the singular sidecar",
  );
});

test("extractMediaRefs accepts the legacy `id` spelling of the attachment key (#6875, #3398 stand-in)", () => {
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("c", {
        rawOpenaiContentParts: [
          { type: "image", attachment: { id: "att_1", data: "AAAA" } },
        ],
      }),
    ),
    ["att_1"],
  );
});

test("hasUnrecoverableMediaPayload is false for a DSH attachment message (#6875)", () => {
  const msg = sidecarMsg("img", { rawOpenaiContentParts: [DSH_PART] });
  assert.equal(hasRefRecoverableMediaPayload(msg), true);
  assert.equal(hasUnrecoverableMediaPayload(msg), false, "#6875 flip");
});

test("conservative pin preserved: an attachment without any id stays unrecoverable (#6875)", () => {
  const noId = sidecarMsg("x", {
    rawOpenaiContentParts: [
      { type: "image", attachment: { mediaType: "image/png", bytes: 12345 } },
    ],
  });
  assert.deepEqual(extractMediaRefs(noId), []);
  assert.equal(hasRefRecoverableMediaPayload(noId), false);
  assert.equal(hasUnrecoverableMediaPayload(noId), true, "conservative pin");
  const noAttachment = sidecarMsg("y", {
    rawOpenaiContentParts: [{ type: "image" }],
  });
  assert.deepEqual(extractMediaRefs(noAttachment), []);
  assert.equal(hasUnrecoverableMediaPayload(noAttachment), true);
});

test("a non-image part carrying an attachment is not treated as DSH media (#6875)", () => {
  const msg = sidecarMsg("z", {
    rawOpenaiContentParts: [
      { type: "text", attachment: { attachmentId: ATTACHMENT_ID } },
    ],
  });
  assert.deepEqual(extractMediaRefs(msg), []);
  // An unrecognized opaque shape keeps pinning (conservative default) —
  // only type:"image" + attachment id counts as a DSH handle.
  assert.equal(hasUnrecoverableMediaPayload(msg), true);
});

test("a stale BLOCKED ref migrates to numeric once the DSH handle is recognized (#6875, #2607)", () => {
  const img = sidecarMsg("img", { rawOpenaiContentParts: [DSH_PART] });
  const pass1 = assignRefs([img], {
    existing: { byRaw: {}, byRef: {} },
    nextIndex: 1,
    // Pre-fix classifier: the unrecognized shape pinned the message.
    isProtected: () => true,
  });
  assert.equal(pass1.map.byRaw["img"], BLOCKED_REF);

  // Post-fix classifier on the reloaded message: protection lifts, the
  // existing #2607 migration mints the numeric ref — no manual index.db
  // rewrite is needed for already-BLOCKED history.
  const pass2 = assignRefs([img], {
    existing: pass1.map,
    nextIndex: pass1.nextIndex,
    isProtected: (m: CoreMessage) => hasUnrecoverableMediaPayload(m),
  });
  assert.equal(pass2.map.byRaw["img"], "m00001");
  assert.deepEqual(pass2.migratedIds, ["img"]);
});

test("applyCompression records the DSH attachmentId in the block summary (#6875, #5620 mechanics)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", { rawOpenaiContentParts: [DSH_PART] }),
    textMsg("t", "assistant", "analyzing"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00003", summary: "folded work", topic: "t" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.errors.length, 0, JSON.stringify(result.result.errors));
  const block = result.state.blocks[0]!;
  assert.ok(block.summary.includes(MEDIA_REFS_MARKER));
  assert.ok(block.summary.includes(`- ${ATTACHMENT_ID}`));
});

test("collectFoldMediaRefs carries the DSH handle forward from consumed blocks (#6875)", () => {
  const carriedBlock = {
    summary: `old\n\n${MEDIA_REFS_MARKER}\n- ${ATTACHMENT_ID}`,
  };
  assert.deepEqual(
    collectFoldMediaRefs([], [carriedBlock as never]),
    [ATTACHMENT_ID],
  );
});

// --- Codec half (#6875 ①, maintainer triage 2026-11-16): the tool
// result's image part must REACH the classifier. openaiToCore's case
// "tool" used to keep text only (stringContent), so the attachment never
// entered any CoreMessage and extractMediaRefs never saw it. ---

const DSH_TOOL_TEXT = `Image "image.png" (sha256:${ATTACHMENT_ID}); request preview 1657x811px.`;
// stringContent joins content parts with "\n" and maps non-text parts to
// "" — a [text, image] tool result therefore texts as text + trailing
// newline. Pre-existing behavior, untouched by this fix.
const DSH_TOOL_JOINED_TEXT = `${DSH_TOOL_TEXT}\n`;
const DSH_TOOL_MESSAGE = {
  role: "tool",
  tool_call_id: "call_read_image_1",
  name: "read_image",
  content: [{ type: "text", text: DSH_TOOL_TEXT }, DSH_PART],
};

test("openaiToCore retains a tool result's DSH image part on the plural sidecar (#6875 ①)", () => {
  const { msgs } = openaiToCore({ messages: [DSH_TOOL_MESSAGE] } as never);
  assert.equal(msgs.length, 1);
  const core = msgs[0]!;
  assert.equal(core.role, "tool");
  assert.equal(core.contentType, "tool-result");
  assert.equal(core.text, DSH_TOOL_JOINED_TEXT);
  assert.equal(core.toolCallId, "call_read_image_1");
  assert.deepEqual(
    (core as unknown as { rawOpenaiContentParts?: unknown }).rawOpenaiContentParts,
    [DSH_PART],
  );
  // And the classifier now sees it: recoverable, foldable.
  assert.deepEqual(extractMediaRefs(core), [ATTACHMENT_ID]);
  assert.equal(hasUnrecoverableMediaPayload(core), false);
});

test("coreToOpenai rebuilds a sidecarred tool result as text-only, byte-identical (#6875 ①, #3617)", () => {
  const withImage = coreToOpenai(
    openaiToCore({ messages: [DSH_TOOL_MESSAGE] } as never).msgs,
  );
  // The sidecar is classification-only: the rebuild emits text-only, exactly
  // as the pre-fix codec did for this message (the trailing newline is
  // stringContent's pre-existing join of [text, image], not this change).
  assert.deepEqual(withImage, [
    { role: "tool", tool_call_id: "call_read_image_1", content: DSH_TOOL_JOINED_TEXT },
  ]);
});

test("a text-only tool result is unchanged by the codec change (#6875 ①)", () => {
  const { msgs } = openaiToCore({
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read_image",
        content: [{ type: "text", text: "done" }],
      },
    ],
  } as never);
  assert.equal(msgs.length, 1);
  assert.equal(
    "rawOpenaiContentParts" in (msgs[0] as unknown as Record<string, unknown>),
    false,
  );
});

test("a non-image non-text part in a tool result is still dropped (#6875 ①)", () => {
  const { msgs } = openaiToCore({
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read_image",
        content: [{ type: "text", text: "done" }, { type: "mystery", blob: "zzz" }],
      },
    ],
  } as never);
  assert.equal(msgs.length, 1);
  assert.equal(
    "rawOpenaiContentParts" in (msgs[0] as unknown as Record<string, unknown>),
    false,
    "only image parts are retained; other opaque parts keep today's drop",
  );
});
