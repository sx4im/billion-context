// #6021: DSH image-offload placeholder text hijacks the last-user anchor.
// After three image offloads, the oldest messages' images are replaced by
// the placeholder "[image omitted to fit request image limits; ...]" and the
// rewritten rows re-enter as NEW messages (new ref + current ts). The
// placeholder is the only user-role message with text in the post-compress
// visible zone, so lastUserAnchor (#5109) pins it and the model answers a
// two-day-old screenshot as the current question. The fix classifies the
// placeholder as a one-shot carrier (oneshot/image-offload-placeholder):
// slot exclusion only, foldability unchanged — one family covering both
// offload markers (image-limits + text-only route, same emitter/slot),
// and the same wiring as #5752's
// dshImageHandlePath (whose live handle the placeholder replaces in the
// wire slot the next turn).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import {
    dshImageOffloadPlaceholderPath,
    durableMessageToolPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";

function mk(id: string, role: CoreMessage["role"], text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

// Production placeholder shape from the #6021 report (m03269): the marker
// opens the text and the reporter's own words follow the closing bracket —
// the classifier must match mid-string (includes), not just a leading "[".
const PLACEHOLDER =
    '[image omitted to fit request image limits; "image.png" (sha256:0e596a186ab8...). Normalized copy (read-only; may be resized or re-encoded): "C:\\Users\\reporter\\attachments\\v1\\objects\\0e\\0e596a18..." (1584x892px, image/png). ...]The unknown keys are probably gamepad keys and should not be counted';

describe("#6021 image-offload placeholder classifier", () => {
    test("dshImageOffloadPlaceholderPath: production shape, role negatives, near-misses", () => {
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u1", "user", PLACEHOLDER)),
            "oneshot/image-offload-placeholder",
            "production shape classifies, marker plus trailing reporter prose",
        );
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u2", "user", '[image omitted to fit request image limits; "a.png" (sha256:aa).]')),
            "oneshot/image-offload-placeholder",
            "bare placeholder still classifies",
        );
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u2b", "user", '[image omitted because this model accepts text only; attachment sha256:0e596a18].')),
            "oneshot/image-offload-placeholder",
            "text-only-route sibling shares the family (same emitter, same slot, maintainer triage #6021)",
        );
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u3", "assistant", PLACEHOLDER)),
            undefined,
            "assistant echo must never classify (#2766)",
        );
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u4", "user", 'Image "x.png" (sha256:aa); request preview 1600x900px.')),
            undefined,
            "the live handle is a different family, never a placeholder",
        );
        assert.equal(
            dshImageOffloadPlaceholderPath(mk("u5", "user", "we discussed image limits earlier")),
            undefined,
            "plain image talk is not a placeholder",
        );
        const tool = { id: "u6", role: "tool", contentType: "tool-result", text: PLACEHOLDER } as CoreMessage;
        assert.equal(
            dshImageOffloadPlaceholderPath(tool),
            undefined,
            "tool channel is not a carrier surface",
        );
    });
});

describe("#6021 end-to-end anchor geometry", () => {
    test("fold covering the placeholder tail keeps the live request visible (THE repro)", () => {
        // PAD2 clears config.compress.minCompressRange (5000 chars) on the
        // four foldable messages (mirrors the #5173 no-bloat pin).
        const PAD2 = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(30);
        const LIVE = "current live request: how thick is the base of this 3D keyboard model";
        const all: CoreMessage[] = [
            mk("q1", "user", `old question ${PAD2}`),
            mk("a1", "assistant", `old answer ${PAD2}`),
            mk("live", "user", LIVE),
            mk("ph1", "user", `${PLACEHOLDER} ${PAD2}`),
            mk("a2", "assistant", `working on the base thickness ${PAD2}`),
        ];
        const run = (msgs: CoreMessage[], startRef: string, endRef: string) => {
            const c = createCore();
            const st = createInitialState();
            st.messageRefs = assignRefs(msgs, { existing: st.messageRefs, nextIndex: 1 }).map;
            const config = withDurableProtection(
                defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }),
                durableMessageToolPaths.dsh!,
            );
            return c.applyCompression({
                ranges: [{ startRef, endRef, summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
                messages: msgs,
                state: st,
                config,
            });
        };

        // THE repro: the requested range spans the live request plus the
        // placeholder tail. Pre-fix the anchor was ph1 (m00004), so the
        // block swallowed the live request. Post-fix the anchor is live
        // (m00003), so NOTHING at or after it may fold; only the
        // pre-anchor content (q1, a1) becomes the block.
        {
            const res = run(all, "m00001", "m00004");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["a1", "q1"], "only pre-anchor content folds; the placeholder never takes the anchor from the live request");
            assert.ok(
                res.result.warnings.some((w) => w.startsWith("Excluded") && w.includes("Last-user anchor: m00003")),
                `receipt names the anchor ref, got: ${JSON.stringify(res.result.warnings)}`,
            );
        }

        // No-bloat pin: once a placeholder sits BEFORE the live request (the
        // normal steady state on the next turn), it folds like any other
        // history — classification removes slot eligibility only, never
        // foldability.
        {
            const msgs: CoreMessage[] = [
                mk("q1", "user", `old question ${PAD2}`),
                mk("a1", "assistant", `old answer ${PAD2}`),
                mk("ph1", "user", `${PLACEHOLDER} ${PAD2}`),
                mk("live", "user", LIVE),
            ];
            const res = run(msgs, "m00001", "m00003");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["a1", "ph1", "q1"].sort(), "a classified placeholder folds normally when it is ahead of the live request");
        }
    });
});
