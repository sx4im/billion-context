import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractMediaRefs,
  hasRefRecoverableMediaPayload,
  MEDIA_REFS_MARKER,
} from "../src/media-refs.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import { assignRefs, BLOCKED_REF } from "../src/refs.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6875: DSH (DeepSeek Harness) read_image / screenshot tool results carry
// their image as an opaque part — verbatim shape from the issue body:
//   { "type": "image", "attachment": {
//       "attachmentId": "sha256:...", "mediaType": "image/png",
//       "bytes": 62368, "width": 896, "height": 651,
//       "name": "printwindow_flag0.png" } }
// `bytes` is a byte COUNT, not a payload: the blob lives in DSH's local
// content-addressed store (~/.dsh/attachments/v1/objects/<hash[0:2]>/<hash>)
// and is re-acquirable from the attachmentId alone (reporter audit: 504
// attachments, missing=0). The attachmentId is therefore a durable
// re-access handle in exactly the #5620 sense (bare id, cf. DeepSeek
// file_id) — the message must fold instead of pinning forever.
const DSH_ATTACHMENT_ID =
  "sha256:a08caa79e3f14a2b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a08caa79";
const DSH_ATTACHMENT_PART = {
  type: "image",
  attachment: {
    attachmentId: DSH_ATTACHMENT_ID,
    mediaType: "image/png",
    bytes: 62368,
    width: 896,
    height: 651,
    name: "printwindow_flag0.png",
  },
};

function textMsg(
  id: string,
  role: CoreMessage["role"],
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function sidecarMsg(id: string, extra: object): CoreMessage {
  return Object.assign(
    { id, role: "user" as const, contentType: "text" as const, text: "" },
    extra,
  );
}

/** The assignRefsNode protection predicate (compress.ts): unrecoverable
 *  media pins, everything else is judged by config. */
const isProtected = (m: CoreMessage): boolean =>
  hasUnrecoverableMediaPayload(m);

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

test("extractMediaRefs pulls the DSH attachmentId as a re-access handle (#6875)", () => {
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("a", { rawOpenaiContentParts: [DSH_ATTACHMENT_PART] }),
    ),
    [DSH_ATTACHMENT_ID],
    "openai plural — DSH attachment part",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("b", { rawOpenaiContent: DSH_ATTACHMENT_PART }),
    ),
    [DSH_ATTACHMENT_ID],
    "openai singular — lone DSH attachment part",
  );
  assert.deepEqual(
    extractMediaRefs(
      sidecarMsg("c", {
        rawOpenaiContentParts: [
          { type: "text", text: "screenshot" },
          DSH_ATTACHMENT_PART,
        ],
      }),
    ),
    [DSH_ATTACHMENT_ID],
    "mixed text + attachment parts — only the handle",
  );
});

test("a DSH attachment message is ref-recoverable, not unrecoverable (#6875)", () => {
  const dsh = sidecarMsg("d", {
    rawOpenaiContentParts: [DSH_ATTACHMENT_PART],
  });
  assert.equal(hasRefRecoverableMediaPayload(dsh), true);
  assert.equal(hasUnrecoverableMediaPayload(dsh), false, "#6875 flip");
});

test("an attachment with no usable id stays pinned — conservative (#6875)", () => {
  const noId = sidecarMsg("e", {
    rawOpenaiContentParts: [
      { type: "image", attachment: { mediaType: "image/png", bytes: 1234 } },
    ],
  });
  assert.equal(hasRefRecoverableMediaPayload(noId), false);
  assert.equal(hasUnrecoverableMediaPayload(noId), true, "conservative pin");
  const emptyId = sidecarMsg("f", {
    rawOpenaiContentParts: [
      {
        type: "image",
        attachment: { attachmentId: "", mediaType: "image/png" },
      },
    ],
  });
  assert.equal(hasRefRecoverableMediaPayload(emptyId), false);
  assert.equal(hasUnrecoverableMediaPayload(emptyId), true, "empty id pins");
});

test("a DSH image message gets a numeric ref, never BLOCKED (#6875)", () => {
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", { rawOpenaiContentParts: [DSH_ATTACHMENT_PART] }),
    textMsg("t", "assistant", "analyzing"),
  ];
  const result = assignRefs(messages, {
    existing: { byRaw: {}, byRef: {} },
    nextIndex: 1,
    isProtected,
  });
  assert.notEqual(result.map.byRaw["img"], BLOCKED_REF);
  assert.equal(result.map.byRaw["img"], "m00002");
});

test("a stale BLOCKED entry for a DSH message migrates once protection lifts (#6875)", () => {
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", { rawOpenaiContentParts: [DSH_ATTACHMENT_PART] }),
  ];
  // Pre-fix state: the message was pinned by the unenumerated shape and
  // its byRaw entry is BLOCKED (the reporter's "never unlocks" symptom).
  const result = assignRefs(messages, {
    existing: { byRaw: { img: BLOCKED_REF }, byRef: {} },
    nextIndex: 2,
    isProtected,
  });
  assert.deepEqual(result.migratedIds, ["img"]);
  assert.notEqual(result.map.byRaw["img"], BLOCKED_REF);
  assert.match(result.map.byRaw["img"]!, /^m\d+$/);
});

test("applyCompression folds a DSH image message and records its handle (#6875)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    textMsg("u", "user", "the task"),
    sidecarMsg("img", { rawOpenaiContentParts: [DSH_ATTACHMENT_PART] }),
    textMsg("t", "assistant", "analyzing"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00003",
        summary: "folded work",
        topic: "t",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(
    result.result.errors.length,
    0,
    JSON.stringify(result.result.errors),
  );
  const block = result.state.blocks[0]!;
  assert.ok(block.summary.includes(MEDIA_REFS_MARKER));
  assert.ok(block.summary.includes(`- ${DSH_ATTACHMENT_ID}`));
  assert.ok(block.effectiveMessageIds.includes("img"), "DSH message folds");
});

// --- Codec segment (#6875, maintainer prescription): the attachment must
// reach CoreMessage at all — openaiToCore's tool branch used to reduce every
// tool result to text only, so the attachment was dropped before any
// classifier could see it. ---

import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";

const DSH_TOOL_RESULT = {
  role: "tool" as const,
  tool_call_id: "call_read_image_1",
  name: "read_image",
  content: [{ type: "text", text: "screenshot saved" }, DSH_ATTACHMENT_PART],
};

test("openaiToCore preserves a DSH attachment part on a tool result (#6875)", () => {
  const { msgs } = openaiToCore({
    model: "deepseek-chat",
    messages: [DSH_TOOL_RESULT],
  });
  assert.equal(msgs.length, 1);
  const core = msgs[0]!;
  assert.equal(core.role, "tool");
  assert.equal(core.contentType, "tool-result");
  assert.equal(core.toolCallId, "call_read_image_1");
  assert.equal(core.toolName, "read_image");
  // stringContent joins array parts with "\n" (pre-existing: the text is
  // also the canonical-id seed, so this is not ours to tidy here).
  assert.equal(core.text, "screenshot saved\n");
  assert.deepEqual(core.rawOpenaiContentParts, [DSH_ATTACHMENT_PART]);
});

test("a codec-produced DSH tool result is foldable end to end (#6875)", () => {
  const { msgs } = openaiToCore({
    model: "deepseek-chat",
    messages: [DSH_TOOL_RESULT],
  });
  const core = msgs[0]! as unknown as CoreMessage;
  assert.equal(hasUnrecoverableMediaPayload(core), false);
  assert.deepEqual(extractMediaRefs(core), [DSH_ATTACHMENT_ID]);
});

test("coreToOpenai round-trips a DSH tool result verbatim (#6875)", () => {
  const { msgs } = openaiToCore({
    model: "deepseek-chat",
    messages: [DSH_TOOL_RESULT],
  });
  const rebuilt = coreToOpenai(msgs);
  assert.deepEqual(rebuilt, [
    {
      role: "tool",
      tool_call_id: "call_read_image_1",
      content: [
        { type: "text", text: "screenshot saved\n" },
        DSH_ATTACHMENT_PART,
      ],
    },
  ]);
});

test("an image-only DSH tool result keeps its attachment, empty text (#6875)", () => {
  const { msgs } = openaiToCore({
    model: "deepseek-chat",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_2",
        name: "read_image",
        content: [DSH_ATTACHMENT_PART],
      },
    ],
  });
  const core = msgs[0]!;
  assert.equal(core.text, "");
  assert.deepEqual(core.rawOpenaiContentParts, [DSH_ATTACHMENT_PART]);
  const rebuilt = coreToOpenai(msgs);
  assert.deepEqual(rebuilt, [
    {
      role: "tool",
      tool_call_id: "call_2",
      content: [DSH_ATTACHMENT_PART],
    },
  ]);
});

test("non-attachment opaque tool parts keep the legacy text-only reduction (#6875)", () => {
  const { msgs } = openaiToCore({
    model: "deepseek-chat",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_3",
        name: "read_image",
        content: [
          { type: "text", text: "done" },
          { type: "mystery", blob: "zzz" },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_4",
        name: "read_image",
        content: [
          { type: "text", text: "done" },
          { type: "image", attachment: { mediaType: "image/png" } },
        ],
      },
    ],
  });
  assert.equal(msgs.length, 2);
  for (const core of msgs) {
    assert.equal(core.rawOpenaiContentParts, undefined);
    assert.equal(core.text, "done\n");
  }
  // Plain-text tool results keep the legacy string rebuild.
  assert.deepEqual(coreToOpenai(msgs), [
    { role: "tool", tool_call_id: "call_3", content: "done\n" },
    { role: "tool", tool_call_id: "call_4", content: "done\n" },
  ]);
});
