import assert from "node:assert/strict";
import { test } from "node:test";
import { describeExternalSummaryFailure, ExternalSummaryExecutor, externalSummaryFailureAdvice, type ExternalSummaryBatchResult, type SummaryBudget, type SummaryCandidate, type SummaryWork } from "../src/external-summary.ts";

const work: SummaryWork = { content: "Historical task evidence", instructions: "Preserve constraints and unfinished work", reference: "Read-only current task" };
const budget: SummaryBudget = { totalTimeoutMs: 2000, targetTimeoutMs: 500, maxSummaryBytes: 200 };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function successful(value = "Stored summary"): SummaryCandidate {
    return { summarize: async () => value };
}

test("external summary: first success stops the ordered chain and preserves bytes", async () => {
    let backup = 0;
    const source = { ...work };
    const result = await new ExternalSummaryExecutor(2).execute(source, [{ summarize: async (request) => {
        assert.deepEqual(request, source);
        assert.equal(Object.isFrozen(request), true);
        return "  Exact summary\n";
    } }, { summarize: async () => { backup++; return "unwanted"; } }], budget);
    assert.deepEqual(result, { status: "success", summary: "  Exact summary\n", targetIndex: 0, attempts: [{ targetIndex: 0, outcome: "success" }] });
    assert.equal(backup, 0);
    assert.deepEqual(source, work);
});

test("external summary: failed targets run once in order, without leaking provider errors", async () => {
    const order: number[] = [];
    const result = await new ExternalSummaryExecutor(2).execute(work, [
        { summarize: async () => { order.push(0); throw new Error("private-key private-url source-content"); } },
        { summarize: async () => { order.push(1); throw new Error("HTTP 401"); } },
        { summarize: async () => { order.push(2); return "backup"; } },
    ], budget);
    assert.deepEqual(order, [0, 1, 2]);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["error", "error", "success"]);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(result.status, "success");
});

test("external summary: exhaustion never invents a summary or main-model fallback", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => { throw new Error("failed"); } }], budget);
    assert.deepEqual(result, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "error" }] });
    assert.equal("summary" in result, false);
});

test("external summary: empty and oversized UTF-8 output fail over", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [successful(" \n"), successful("\u4e2d".repeat(70)), successful("valid")], budget);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["invalid_summary", "invalid_summary", "success"]);
    assert.equal(result.status, "success");
});

test("external summary: invalid plans dispatch no calls", async () => {
    const executor = new ExternalSummaryExecutor(1);
    let calls = 0;
    const target: SummaryCandidate = { summarize: async () => { calls++; return "summary"; } };
    for (const bad of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
        assert.equal((await executor.execute(work, [target], { ...budget, totalTimeoutMs: bad })).status, "failed");
        assert.equal((await executor.execute(work, [target], { ...budget, targetTimeoutMs: bad })).status, "failed");
    }
    for (const [request, targets, limits] of [
        [{ ...work, content: " " }, [target], budget],
        [{ ...work, instructions: " " }, [target], budget],
        [work, [], budget],
        [work, [target], { ...budget, maxSummaryBytes: 0 }],
    ] as const) {
        assert.deepEqual(await executor.execute(request, targets, limits), { status: "failed", reason: "invalid_plan", attempts: [] });
    }
    assert.equal(calls, 0);
    for (const bad of [0, -1, 0.5, Infinity, NaN]) assert.throws(() => new ExternalSummaryExecutor(bad), TypeError);
});

test("external summary: a pre-aborted caller never dispatches", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => { calls++; return "summary"; } }], budget, controller.signal);
    assert.deepEqual(result, { status: "cancelled", attempts: [] });
    assert.equal(calls, 0);
});

test("external summary: cancellation aborts the active target without starting backup", async () => {
    const controller = new AbortController();
    let backup = 0;
    let seen: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => {
        seen = signal;
        controller.abort();
        throw new Error("cancelled");
    } }, { summarize: async () => { backup++; return "backup"; } }], budget, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(seen?.aborted, true);
    assert.equal(backup, 0);
});

test("external summary: a target timeout aborts transport and tries the next candidate", async () => {
    let first: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => {
        first = signal;
        return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } }, successful("backup")], { ...budget, targetTimeoutMs: 15 });
    assert.equal(first?.aborted, true);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["timeout", "success"]);
    assert.equal(result.status, "success");
});

test("external summary: total deadline prevents spending the remaining chain", async () => {
    let backup = 0;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) }, { summarize: async () => { backup++; return "backup"; } }], { ...budget, totalTimeoutMs: 15 });
    assert.equal(result.status, "deadline");
    assert.equal(backup, 0);
});

test("external summary: aggregate concurrency bounds distinct operations", async () => {
    const executor = new ExternalSummaryExecutor(2);
    const entered = deferred<void>();
    const leave = deferred<string>();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const target: SummaryCandidate = { summarize: async () => {
        calls++; active++; maximum = Math.max(maximum, active);
        if (calls === 2) entered.resolve();
        try { return await leave.promise; } finally { active--; }
    } };
    const jobs = Array.from({ length: 5 }, () => executor.execute(work, [target], budget));
    await entered.promise;
    assert.equal(calls, 2);
    leave.resolve("summary");
    assert.ok((await Promise.all(jobs)).every((item) => item.status === "success"));
    assert.equal(maximum, 2);
    assert.equal(calls, 5);
});

test("external summary: queued work can hit its total deadline without dispatching", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget);
    await entered.promise;
    let calls = 0;
    const queued = await executor.execute(work, [{ summarize: async () => { calls++; return "queued"; } }], { ...budget, totalTimeoutMs: 15 });
    assert.deepEqual(queued, { status: "deadline", attempts: [] });
    assert.equal(calls, 0);
    leave.resolve("holder");
    assert.equal((await holder).status, "success");
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: a cancelled queue entry cannot block the next operation", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget);
    await entered.promise;
    const controller = new AbortController();
    const cancelled = executor.execute(work, [successful()], budget, controller.signal);
    const next = executor.execute(work, [successful("next")], budget);
    controller.abort();
    assert.deepEqual(await cancelled, { status: "cancelled", attempts: [] });
    leave.resolve("holder");
    assert.equal((await holder).status, "success");
    assert.equal((await next).status, "success");
});

test("external summary: late non-cooperative results cannot succeed or exceed capacity", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const leave = deferred<string>();
    let backup = 0;
    const result = await executor.execute(work, [{ summarize: async () => leave.promise }, { summarize: async () => { backup++; return "backup"; } }], { ...budget, totalTimeoutMs: 35, targetTimeoutMs: 10 });
    assert.equal(result.status, "deadline");
    assert.equal(backup, 0);
    leave.resolve("late result must not commit");
    await leave.promise;
    assert.equal(result.status, "deadline");
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: late rejections are observed and release capacity", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const leave = deferred<string>();
    const result = await executor.execute(work, [{ summarize: async () => leave.promise }], { ...budget, targetTimeoutMs: 10 });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("unreachable");
    assert.equal(result.reason, "exhausted");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].targetIndex, 0);
    assert.equal(result.attempts[0].outcome, "timeout");
    // #4833: the timeout names its source and budget instead of staying opaque.
    assert.match(result.attempts[0].detail ?? "", /^target-timeout 10ms \(elapsed \d+ms\)$/);
    leave.reject(new Error("late private provider error"));
    await leave.promise.catch(() => undefined);
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: elapsed total deadlines reject success even before the timer can fire", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return "too late";
    } }], { ...budget, totalTimeoutMs: 5 });
    assert.equal(result.status, "deadline");
    assert.equal("summary" in result, false);
});

test("external summary: elapsed target deadlines fail over before a delayed timer fires", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return "too late";
    } }, successful("backup")], { ...budget, targetTimeoutMs: 5 });
    assert.equal(result.status, "success");
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["timeout", "success"]);
});

test("external summary: a caller cannot mutate the budget of an in-flight operation", async () => {
    const mutableBudget = { ...budget };
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        mutableBudget.maxSummaryBytes = 1;
        return "summary";
    } }], mutableBudget);
    assert.equal(result.status, "success");
});

test("external summary: queued time does not spend the per-target dispatch budget", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const controller = new AbortController();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget, controller.signal);
    await entered.promise;
    const queued = executor.execute(work, [successful("queued")], { ...budget, targetTimeoutMs: 100 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    controller.abort();
    assert.equal((await holder).status, "cancelled");
    leave.resolve("holder");
    assert.equal((await queued).status, "success");
});

// #6885: a candidate rejection keeps its cause as a fixed label — never the
// raw message, so provider internals (keys, URLs, payload) cannot leak into
// the attempts list the way the "without leaking provider errors" test pins.
test("external summary: classified candidate rejections keep their cause", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const guard = await executor.execute(work, [{ summarize: async () => { throw new Error("External summary input exceeds the target context budget"); } }], budget);
    assert.equal(guard.status, "failed");
    assert.deepEqual(guard.attempts, [{ targetIndex: 0, outcome: "error", detail: "input exceeds target context budget" }]);
    const parse = await executor.execute(work, [{ summarize: async () => { throw new Error("External summary response contains no summary"); } }], budget);
    assert.deepEqual(parse.attempts, [{ targetIndex: 0, outcome: "error", detail: "no summary in response" }]);
});

test("external summary: unclassified candidate rejections stay bare", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => { throw new Error("private-key private-url source-content"); } }], budget);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.attempts, [{ targetIndex: 0, outcome: "error" }]);
    assert.equal(JSON.stringify(result).includes("private"), false);
});

// #6885: the reported chain shape — serial 25s/50s-style budgets where the
// third candidate never gets a request out. The batch must record every
// candidate: the two timeouts plus the starved tail, not a silent omission.
test("external summary: a chain that outruns its total budget records the starved tail", async () => {
    // Cooperative like a real fetch: the in-flight call settles (rejects) on
    // abort, so the pool permit frees and the next candidate can start — a
    // non-cooperative call would hold the permit past the deadline instead
    // (see "late non-cooperative results cannot succeed or exceed capacity").
    const slow: SummaryCandidate = { summarize: (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        setTimeout(() => _resolve("too slow"), 1000);
    }) };
    // Budgets are deliberately shaped so the outcome is load-independent:
    // t0 gets its full 200ms target (300ms total leaves a 100ms margin, far
    // above the ~40ms timer slippage this box shows under parallel load), t1
    // times out either way, and t2's iteration can only begin at or after
    // the 300ms deadline — so it is skipped, never raced with its own timer.
    // (A 50/60ms shape flaked: a 50ms timer slipping ~40ms under load let t1
    // start after the deadline, and a 50/120ms shape let t2's own timer win.)
    const batch = await new ExternalSummaryExecutor(1).executeBatch([work], [slow, slow, slow], { totalTimeoutMs: 300, targetTimeoutMs: 200, maxSummaryBytes: 200 });
    assert.equal(batch.status, "deadline");
    const result = batch.results[0];
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["timeout", "timeout", "skipped"]);
    assert.match(result.attempts[0].detail ?? "", /^target-timeout 200ms \(elapsed \d+ms\)$/);
    assert.deepEqual(result.attempts[2], { targetIndex: 2, outcome: "skipped", detail: "total budget exhausted before dispatch" });
    assert.ok(describeExternalSummaryFailure(batch).includes("t2:skipped (total budget exhausted before dispatch)"));
});

// #6885: the compress receipt must name the real cause — the cap knob only
// when a summary was actually rejected for length, the budget when time ran
// out, the attempt detail when candidates errored.
test("external summary: failure advice names the real cause", () => {
    const invalidSummary: ExternalSummaryBatchResult = { status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "response 70000 bytes exceeds byte cap 65536" }] }] };
    assert.equal(externalSummaryFailureAdvice(invalidSummary), "summaries longer than the configured cap are rejected whole, so raise compress.maxSummaryLength or request less via per-range summaryMaxChars.");
    const deadline: ExternalSummaryBatchResult = { status: "deadline", results: [{ status: "deadline", attempts: [
        { targetIndex: 0, outcome: "timeout", detail: "target-timeout 25000ms (elapsed 25015ms)" },
        { targetIndex: 1, outcome: "timeout", detail: "batch-deadline 50000ms (elapsed 50005ms)" },
        { targetIndex: 2, outcome: "skipped", detail: "total budget exhausted before dispatch" },
    ] }] };
    assert.equal(externalSummaryFailureAdvice(deadline), "the configured time budget ran out before any candidate could finish, so raise the external-summary budget (budget.totalTimeoutMs / budget.targetTimeoutMs) or put a faster target first.");
    const errored: ExternalSummaryBatchResult = { status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "error", detail: "input exceeds target context budget" }] }] };
    assert.equal(externalSummaryFailureAdvice(errored), "the candidates errored before producing a summary — see the per-candidate detail in the attempts list and fix the reported cause.");
    const invalidPlan: ExternalSummaryBatchResult = { status: "failed", reason: "invalid_plan", results: [] };
    assert.equal(externalSummaryFailureAdvice(invalidPlan), "summaries longer than the configured cap are rejected whole, so raise compress.maxSummaryLength or request less via per-range summaryMaxChars.");
});
