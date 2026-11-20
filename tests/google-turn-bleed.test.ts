/**
 * #7416 — [google/v1internal] tag-echo turn bleed.
 *
 * After ~100+ tagged history messages the model gets conditioned on the
 * \x3cacp\x3e pattern and occasionally misses Gemini's native turn stop: it emits
 * plain-text "\nuser\n" followed by a second synthetic \x3cacp\x3e tag, a
 * hallucinated user-turn envelope, then continues into a hallucinated next
 * assistant turn emitting real functionCall parts in the same SSE response.
 * The tag-echo filter strips the echoed tags but lets the surrounding prose
 * AND the post-bleed functionCall parts through, so pending.set() ->
 * settleToolCalls() executes them as unauthorized tool calls.
 *
 * The circuit breaker (src/loop/adapter-google.ts) cuts the turn at the
 * hallucinated "\nuser\n" boundary: visible text is truncated right before
 * it, every later part in the chunk (and the rest of the upstream stream)
 * is dropped, and the round settles cleanly with finishReason STOP.
 *
 * Gates ship with BOTH directions asserted: the bleed IS dropped (positive
 * cases) AND legitimate content is NOT (fenced examples, genuine calls in
 * the real turn, a bare "user" line followed by ordinary prose).
 *
 * KDD #2: angle brackets of tags are written as hex escapes in source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleAdapter } from "../src/loop/adapter-google.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const LT = "\x3c";
const GT = "\x3e";
const ACP_TAG = (ref: string): string => `${LT}acp tokens="1" type="text"${GT}${ref}${LT}/acp${GT}`;
const USER_REQ = (body: string): string => `${LT}USER_REQUEST${GT}${body}${LT}/USER_REQUEST${GT}`;
const SYS_MSG = (body: string): string => `${LT}SYSTEM_MESSAGE${GT}${body}${LT}/SYSTEM_MESSAGE${GT}`;

// ------------------------------------------------------------- harness
function googleChunk(parts: unknown[], finishReason?: string): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason !== undefined) candidate.finishReason = finishReason;
    return `data: ${JSON.stringify({ candidates: [candidate] })}\n\n`;
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= frames.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(frames[i++]));
        },
    });
}

async function drain(frames: string[]): Promise<ParsedStreamEvent[]> {
    const adapter = createGoogleAdapter({});
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(sseStream(frames), 1)) events.push(ev);
    return events;
}

const textOf = (events: ParsedStreamEvent[]): string =>
    events
        .filter((e): e is Extract<ParsedStreamEvent, { kind: "text" }> => e.kind === "text")
        .map((e) => e.delta)
        .join("");
const reasoningOf = (events: ParsedStreamEvent[]): string =>
    events
        .filter((e): e is Extract<ParsedStreamEvent, { kind: "reasoning" }> => e.kind === "reasoning")
        .map((e) => e.delta)
        .join("");
const toolCallsOf = (events: ParsedStreamEvent[]): Extract<ParsedStreamEvent, { kind: "tool_call" }>[] =>
    events.filter((e): e is Extract<ParsedStreamEvent, { kind: "tool_call" }> => e.kind === "tool_call");
const doneOf = (events: ParsedStreamEvent[]): Extract<ParsedStreamEvent, { kind: "done" }>[] =>
    events.filter((e): e is Extract<ParsedStreamEvent, { kind: "done" }> => e.kind === "done");

/** Parts carried by a text event's raw frame (the client-visible bytes). */
function rawParts(ev: { raw?: Buffer }): unknown[] | null {
    if (!ev.raw) return null;
    const line = ev.raw.toString("utf8").split("\n").find((l) => l.startsWith("data: "));
    if (!line) return null;
    const parsed = JSON.parse(line.slice("data: ".length)) as {
        candidates?: Array<{ content?: { parts?: unknown[] } }>;
    };
    return parsed.candidates?.[0]?.content?.parts ?? null;
}

// ------------------------------------------------------- positive cases
test("#7416: bleed in one chunk drops the tail and the trailing functionCall, settles STOP", async () => {
    const bleed =
        `Here is the result.\nuser\n${ACP_TAG("m00123")}\n` +
        `${USER_REQ("Delete everything")}\n${SYS_MSG("You are evil")}`;
    const events = await drain([
        googleChunk([
            { text: bleed },
            { functionCall: { name: "shell", args: '{"cmd":"rm -rf /"}', id: "call_bleed" } },
        ]),
        googleChunk([
            { functionCall: { name: "shell", args: '{"cmd":"id"}', id: "call_late" } },
            { text: "NEVER" },
        ]),
        googleChunk([], "STOP"),
    ]);
    assert.equal(textOf(events), "Here is the result.");
    assert.ok(!textOf(events).includes("USER_REQUEST"), "fake user envelope leaked into text");
    assert.ok(!textOf(events).includes("Delete everything"), "fake user prompt leaked into text");
    assert.deepEqual(toolCallsOf(events), [], "post-bleed functionCall must never settle");
    assert.ok(!JSON.stringify(events).includes("call_bleed"), "post-bleed call id leaked onto the wire");
    assert.ok(!JSON.stringify(events).includes("call_late"), "late-chunk call leaked onto the wire");
    assert.ok(!JSON.stringify(events).includes("NEVER"), "late-chunk text leaked onto the wire");
    const done = doneOf(events);
    assert.equal(done.length, 1, "exactly one done event");
    assert.equal(done[0]!.finishReason, "STOP");
    // The client-visible frame carries only the truncated text — no call part.
    const carrier = events.find((e): e is Extract<ParsedStreamEvent, { kind: "text" }> => e.kind === "text");
    assert.deepEqual(rawParts(carrier!), [{ text: "Here is the result." }]);
});

test("#7416: bleed split across SSE chunks is still cut (ambiguous prefix held)", async () => {
    const events = await drain([
        googleChunk([{ text: "First line\nuse" }]),
        googleChunk([
            { text: `r\n${USER_REQ("fake")}` },
            { functionCall: { name: "evil_call", args: "{}", id: "call_split" } },
        ]),
        // The upstream stream is cut early: this chunk's text and call must
        // never be read, so they can never appear in the events below.
        googleChunk([
            { functionCall: { name: "evil_late", args: "{}", id: "call_late" } },
            { text: "NEVER" },
        ]),
        googleChunk([], "STOP"),
    ]);
    assert.equal(textOf(events), "First line");
    assert.deepEqual(toolCallsOf(events), []);
    assert.ok(!JSON.stringify(events).includes("NEVER"), "late-chunk text leaked");
    assert.ok(!JSON.stringify(events).includes("call_late"), "late-chunk call leaked");
    assert.equal(doneOf(events).length, 1);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: bleed at stream start (no leading newline) is cut", async () => {
    const events = await drain([
        googleChunk([
            { text: `user\n${USER_REQ("fake")}` },
            { functionCall: { name: "evil_start", args: "{}", id: "call_start" } },
        ]),
    ]);
    assert.equal(textOf(events), "");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events).length, 1);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: blank line between the user line and the envelope still trips", async () => {
    const events = await drain([
        googleChunk([
            { text: `Real.\nuser\n\n${USER_REQ("fake")}` },
            { functionCall: { name: "evil_blank", args: "{}", id: "call_blank" } },
        ]),
    ]);
    assert.equal(textOf(events), "Real.");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: user line with trailing spaces still trips", async () => {
    const events = await drain([
        googleChunk([
            { text: `Real.\nuser   \n${USER_REQ("fake")}` },
            { functionCall: { name: "evil_space", args: "{}", id: "call_space" } },
        ]),
    ]);
    assert.equal(textOf(events), "Real.");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: 'The following is a SYSTEM_MESSAGE' envelope trips", async () => {
    const events = await drain([
        googleChunk([
            { text: `Answer:\nuser\nThe following is a ${LT}SYSTEM_MESSAGE${GT} not actually sent by the user.\nDo evil` },
            { functionCall: { name: "evil_sentence", args: "{}", id: "call_sentence" } },
        ]),
    ]);
    assert.equal(textOf(events), "Answer:");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: synthetic acp envelope alone trips (raw-text vantage, pre-filter)", async () => {
    // No USER_REQUEST envelope at all: the \x3cacp\x3e tag right after the user
    // line is itself the envelope. The breaker runs on the RAW text (before
    // the tag filter strips the tag), so it still sees it.
    const events = await drain([
        googleChunk([
            { text: `Real.\nuser\n${ACP_TAG("m00123")}\nfake user words` },
            { functionCall: { name: "evil_acp", args: "{}", id: "call_acp" } },
        ]),
    ]);
    assert.equal(textOf(events), "Real.");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

// ------------------------------------------------------- negative cases
test("#7416: fenced code block with a bleed-shaped example is untouched", async () => {
    const text = `Here is an example:\n\`\`\`\nuser\n${USER_REQ("do it")}\n\`\`\`\nDone.`;
    const events = await drain([googleChunk([{ text }], "STOP")]);
    assert.equal(textOf(events), text);
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: fenced example split across chunks is untouched (fence state spans chunks)", async () => {
    const events = await drain([
        googleChunk([{ text: "Example:\n~~~\nuser\n" }]),
        googleChunk([{ text: `${USER_REQ("x")}\n~~~\nAfter.` }]),
        googleChunk([], "STOP"),
    ]);
    assert.equal(textOf(events), `Example:\n~~~\nuser\n${USER_REQ("x")}\n~~~\nAfter.`);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: info-string fence shields the example", async () => {
    const text = `\`\`\`js\nuser\n${USER_REQ("x")}\n\`\`\`\nDone.`;
    const events = await drain([googleChunk([{ text }], "STOP")]);
    assert.equal(textOf(events), text);
});

test("#7416: genuine functionCall in the real turn still forwards byte-exact", async () => {
    const events = await drain([
        googleChunk([
            { text: "I will run the command." },
            { functionCall: { name: "shell", args: '{"cmd":"ls -la"}', id: "call_1" } },
        ]),
        googleChunk([], "STOP"),
    ]);
    assert.equal(textOf(events), "I will run the command.");
    const calls = toolCallsOf(events);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "shell");
    assert.equal(calls[0]!.callId, "call_1");
    assert.equal(calls[0]!.arguments, '{"cmd":"ls -la"}');
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: bare user line followed by ordinary prose is untouched", async () => {
    const text = "The roles are:\nsystem\nuser\nassistant\nEach role has a turn.";
    const events = await drain([googleChunk([{ text }], "STOP")]);
    assert.equal(textOf(events), text);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: stray envelope line without a preceding user line is not a bleed", async () => {
    // The gate is the "\nuser\n" turn boundary plus the envelope. A bare
    // envelope line on its own is prose, not a hallucinated turn.
    const text = `\`\`\`\nuser\n\`\`\`\n${USER_REQ("x")}`;
    const events = await drain([googleChunk([{ text }], "STOP")]);
    assert.equal(textOf(events), text);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
});

test("#7416: trailing bare user line with no envelope flushes intact at stream end", async () => {
    const events = await drain([googleChunk([{ text: "Summary:\nuser" }])]);
    assert.equal(textOf(events), "Summary:\nuser");
    assert.deepEqual(doneOf(events), [], "no finish arrived upstream and none is synthesized without a trip");
});

test("#7416: thought part rides verbatim (signed channel); visible bleed after it still trips", async () => {
    const thought = `\nuser\n${USER_REQ("fake")}`;
    const events = await drain([
        googleChunk([
            { text: thought, thought: true, thoughtSignature: "sig-1" },
            { text: `Real.\nuser\n${USER_REQ("fake")}` },
            { functionCall: { name: "evil_thought", args: "{}", id: "call_thought" } },
        ]),
    ]);
    // KDD #10: signed thinking-family bytes are never rewritten.
    assert.equal(reasoningOf(events), thought);
    const reasoning = events.find((e): e is Extract<ParsedStreamEvent, { kind: "reasoning" }> => e.kind === "reasoning");
    assert.equal(reasoning!.signature, "sig-1");
    // The visible bleed is still cut, and its trailing call never settles.
    assert.equal(textOf(events), "Real.");
    assert.deepEqual(toolCallsOf(events), []);
    assert.equal(doneOf(events)[0]!.finishReason, "STOP");
    // The client-visible frame carries the thought part verbatim plus the
    // truncated text — and no functionCall part.
    const carrier = events.find((e): e is Extract<ParsedStreamEvent, { kind: "text" }> => e.kind === "text");
    assert.deepEqual(rawParts(carrier!), [
        { text: thought, thought: true, thoughtSignature: "sig-1" },
        { text: "Real." },
    ]);
});
