export interface SummaryWork {
    readonly content: string;
    readonly instructions: string;
    readonly reference?: string;
    readonly minSummaryChars?: number;
    readonly maxSummaryChars?: number;
}

export interface SummaryCandidate {
    summarize(work: Readonly<SummaryWork>, signal: AbortSignal): Promise<string>;
}

export interface SummaryBudget {
    readonly totalTimeoutMs: number;
    readonly targetTimeoutMs: number;
    readonly maxSummaryBytes: number;
}

/** #4833: provenance of an abort raised by the executor itself. A candidate
 *  receives ONLY the executor's per-attempt signal, so a bare `signal.aborted`
 *  cannot tell "our per-target budget expired" from "the whole batch hit its
 *  total deadline" from "the caller's request was torn down" — all three used
 *  to surface as client-abort in the HTTP layer's warn line. The marker rides
 *  `signal.reason` from the aborting controller down to the fetch site. */
type SummaryAbortSource = "target-timeout" | "batch-deadline" | "cancelled";

export class SummaryAbortError extends Error {
    readonly source: SummaryAbortSource;
    constructor(source: SummaryAbortSource) {
        super(`external summary aborted (${source})`);
        this.name = "SummaryAbortError";
        this.source = source;
    }
}

/** Read the executor's abort provenance off a signal. Undefined when the signal
 *  was never aborted or was aborted without our marker (foreign signals keep
 *  the legacy transport classification). */
export function summaryAbortSource(signal: AbortSignal): SummaryAbortSource | undefined {
    const reason: unknown = signal.reason;
    return reason instanceof SummaryAbortError ? reason.source : undefined;
}

/** #4833: human-readable WHY for a timed-out attempt — the source, the budget
 *  it hit, and how much wall-clock the range had burned. Pure numbers and fixed
 *  words; never echoes payload. */
function timeoutDetail(source: SummaryAbortSource, budgetMs: number, elapsedMs: number): string {
    return `${source} ${budgetMs}ms (elapsed ${Math.round(elapsedMs)}ms)`;
}

/** [#6885] Classify a candidate rejection into a fixed, safe label — the
 *  executor used to drop every rejection reason (`() => ({ kind: "error" })`),
 *  so a synchronously-thrown guard (context budget) or a parse failure after
 *  a successful fetch left only a bare `error` in `attempts` and zero warn
 *  lines: undiagnosable from the log without reading the bundle. The label
 *  must NEVER echo the raw message: rejections can carry provider internals
 *  (keys, URLs, payload — see the "without leaking provider errors" test),
 *  so only these exact project-owned fixed strings map to a label and
 *  everything else stays a bare `error`. */
const KNOWN_SUMMARY_ERROR_DETAILS: Readonly<Record<string, string>> = {
    "External summary input exceeds the target context budget": "input exceeds target context budget",
    "External summary response is empty": "empty response",
    "External summary response exceeds its byte budget": "response exceeds byte budget",
    "External summary response did not complete": "incomplete response",
    "External summary response contains an invalid frame": "invalid response frame",
    "External summary response contains no summary": "no summary in response",
    "Summary attempt cancelled before dispatch": "cancelled before dispatch",
};

export function summaryErrorDetail(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : undefined;
    return message === undefined ? undefined : KNOWN_SUMMARY_ERROR_DETAILS[message];
}

/** [#2657] Per-batch pool-size request for the shared queue. The pool grows
 *  to the LARGEST request among in-flight work and returns to its base size
 *  once that work settles — one batch never permanently resizes the pool for
 *  everyone else, so chains with different values can coexist safely. */
interface SummaryPoolOptions {
    readonly concurrency?: number;
}

interface SummaryAttempt {
    readonly targetIndex: number;
    readonly outcome: "success" | "error" | "timeout" | "invalid_summary" | "cancelled" | "skipped";
    /** #3635: WHY an invalid_summary reply was rejected wholesale — before, a
     *  discarded over-cap summary left only this bare outcome as a trace. */
    readonly detail?: string;
}

type ExternalSummaryResult =
    | { status: "success"; summary: string; targetIndex: number; attempts: SummaryAttempt[] }
    | { status: "failed"; reason: "invalid_plan" | "exhausted"; attempts: SummaryAttempt[] }
    | { status: "cancelled" | "deadline"; attempts: SummaryAttempt[] };

export type ExternalSummaryBatchResult =
    | { status: "finished" | "cancelled" | "deadline"; results: ExternalSummaryResult[] }
    | { status: "failed"; reason: "invalid_plan"; results: [] };

type AttemptResult = { kind: "value"; value: string } | { kind: "error"; detail?: string } | { kind: "aborted" };
type Release = () => void;
interface Waiter {
    signal: AbortSignal;
    resolve: (release: Release | undefined) => void;
    abort: () => void;
}

function positiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

/** #3635: name WHY a candidate reply failed the length/shape gate. Mirrors the
 *  validator's check order below so the stated reason always matches the cause
 *  that rejected the reply. Pure numbers + fixed words — never echoes payload. */
function invalidSummaryDetail(value: unknown, limits: SummaryBudget, request: Readonly<SummaryWork>): string {
    if (typeof value !== "string" || !value.trim()) return "empty or non-string response";
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > limits.maxSummaryBytes) return `response ${bytes} bytes exceeds byte cap ${limits.maxSummaryBytes}`;
    const chars = value.trim().length;
    const floor = request.minSummaryChars ?? 1;
    if (chars < floor) return `summary ${chars} chars below floor ${floor}`;
    return `summary ${chars} chars exceeds cap ${request.maxSummaryChars}`;
}

/** #1775/#3635: the length-budget clause every external-summarizer prompt
 *  carries — rendered up front with the EXACT cap the validator enforces, so
 *  the first attempt fits instead of paying full latency for a wholesale-
 *  discarded overshoot. Omitted below the minimum-summary floor (the kernel
 *  minimum-summary gate rejects such output anyway, so the instruction would
 *  be counterproductive) and when the cap is unbounded (<= 0 / Infinity). */
export function summaryLengthBudgetClause(budget: number | undefined, minChars: number): string {
    if (budget === undefined || !Number.isFinite(budget) || budget <= 0 || budget < minChars) return "";
    return `\n\nLENGTH BUDGET: Your ENTIRE response must be AT MOST ${budget} characters total — longer output is rejected by the pipeline. Be dense: compact bullets, no filler or repetition.`;
}

/** Describe why an external-summary batch yielded no usable summary (#2484):
 *  the batch stop reason plus each candidate attempt's outcome, so an operator
 *  can tell timeout / error / cancelled / invalid-plan apart instead of seeing
 *  one opaque "failed or exceeded their budget" line. #3635: invalid_summary
 *  attempts carry their rejection reason in parentheses. */
export function describeExternalSummaryFailure(batch: ExternalSummaryBatchResult): string {
    if (batch.status === "failed") return `batch=failed reason=${batch.reason}`;
    // #2678: multi-range batches report the FIRST failing range, not slot 0 —
    // slot 0 may have succeeded while a later range is what stopped the batch.
    // Single-range callers see identical output (find falls back to results[0]).
    const result = batch.results.find((entry) => entry.status !== "success") ?? batch.results[0];
    if (!result) return `batch=${batch.status} (no result)`;
    const parts = [`batch=${batch.status}`, `result=${result.status}`];
    if (result.status === "failed") parts.push(`reason=${result.reason}`);
    parts.push(`attempts=[${result.attempts.map((a) => `t${a.targetIndex}:${a.outcome}${a.detail ? ` (${a.detail})` : ""}`).join(",")}]`);
    return parts.join(" ");
}

/** [#6885] The advice clause of the compress failure receipt, branched by the
 *  actual cause. The old text blamed `compress.maxSummaryLength` for EVERY
 *  failure — timeouts, instant guard errors and parse failures alike — even
 *  though the cap was never set and never the cause. The cap knob is named
 *  only when a summary was actually rejected for length; a run-out budget
 *  names the budget knobs; anything else points at the per-candidate detail.
 *  MODEL-FACING TEXT: these strings ride the compress tool result, so they
 *  name config knobs only — no numbers, refs or positions the model could
 *  anchor on and propagate (see AGENTS.md §7.3). */
export function externalSummaryFailureAdvice(batch: ExternalSummaryBatchResult): string {
    const capAdvice = "summaries longer than the configured cap are rejected whole, so raise compress.maxSummaryLength or request less via per-range summaryMaxChars.";
    if (batch.status === "failed") return capAdvice;
    const result = batch.results.find((entry) => entry.status !== "success") ?? batch.results[0];
    if (!result) return capAdvice;
    if (result.attempts.some((attempt) => attempt.outcome === "invalid_summary")) return capAdvice;
    if (batch.status === "deadline" || result.status === "deadline" || result.attempts.some((attempt) => attempt.outcome === "timeout")) {
        return "the configured time budget ran out before any candidate could finish, so raise the external-summary budget (budget.totalTimeoutMs / budget.targetTimeoutMs) or put a faster target first.";
    }
    return "the candidates errored before producing a summary — see the per-candidate detail in the attempts list and fix the reported cause.";
}

function validBudget(budget: SummaryBudget): boolean {
    return positiveInteger(budget.totalTimeoutMs) && budget.totalTimeoutMs <= 2_147_483_647
        && positiveInteger(budget.targetTimeoutMs) && budget.targetTimeoutMs <= 2_147_483_647
        && positiveInteger(budget.maxSummaryBytes);
}

function awaitAttempt(operation: Promise<AttemptResult>, signal: AbortSignal): Promise<AttemptResult> {
    return new Promise((resolve) => {
        const abort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void operation.then((result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
        });
    });
}

/** Internal execution boundary only: adapters resolve wire/auth; callers own fold commits. */
export class ExternalSummaryExecutor {
    private active = 0;
    private readonly waiting: Waiter[] = [];
    private readonly baseConcurrency: number;
    private readonly scopedConcurrency = new Map<number, number>();

    constructor(concurrency: number) {
        if (!positiveInteger(concurrency)) throw new TypeError("Summary concurrency must be a positive integer");
        this.baseConcurrency = concurrency;
    }

    async execute(work: SummaryWork, candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, options?: SummaryPoolOptions): Promise<ExternalSummaryResult> {
        const endScope = this.beginScope(options);
        try {
            return await this.executeUntil(work, candidates, budget, signal);
        } finally {
            endScope();
        }
    }

    async executeBatch(work: readonly SummaryWork[], candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, options?: SummaryPoolOptions): Promise<ExternalSummaryBatchResult> {
        const endScope = this.beginScope(options);
        try {
            return await this.executeBatchInner(work, candidates, budget, signal);
        } finally {
            endScope();
        }
    }

    private async executeBatchInner(work: readonly SummaryWork[], candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal): Promise<ExternalSummaryBatchResult> {
        const results: ExternalSummaryResult[] = [];
        if (signal?.aborted) return { status: "cancelled", results };
        const limits = { ...budget };
        if (!validBudget(limits) || work.length === 0 || candidates.length === 0
            || candidates.some((target) => typeof target.summarize !== "function")) {
            return { status: "failed", reason: "invalid_plan", results: [] };
        }
        const deadline = performance.now() + limits.totalTimeoutMs;
        const requests = work.map((request) => Object.freeze({ ...request }));
        const targets = [...candidates];
        // #2667: workers pull indices from a shared counter so one batch runs up
        // to `concurrency` ranges in flight instead of strictly serial — the pool
        // now bounds a batch as well as cross-session calls. Results stay
        // index-aligned with `work`: the reported list is the DENSE PREFIX of
        // settled ranges (downstream zips entries with their work slot), and an
        // early stop (caller abort / any range hitting the shared deadline)
        // leaves unstarted ranges unreported rather than fabricated.
        const completed = new Map<number, ExternalSummaryResult>();
        let itemDeadline = false;
        const stop = new AbortController();
        const onAbort = (): void => stop.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const nextIndex = { value: 0 };
        const worker = async (): Promise<void> => {
            for (;;) {
                if (stop.signal.aborted) return;
                const index = nextIndex.value++;
                if (index >= requests.length) return;
                const result = await this.executeUntil(requests[index], targets, limits, signal, deadline);
                completed.set(index, result);
                if (result.status === "deadline") itemDeadline = true;
                if (result.status === "cancelled" || result.status === "deadline") {
                    stop.abort();
                    return;
                }
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(this.effectiveConcurrency(), requests.length) }, () => worker()));
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
        let prefix = 0;
        while (prefix < requests.length && completed.has(prefix)) prefix += 1;
        const settled: ExternalSummaryResult[] = [];
        for (let index = 0; index < prefix; index++) {
            const value = completed.get(index);
            if (value !== undefined) settled.push(value);
        }
        if (signal?.aborted) return { status: "cancelled", results: settled };
        if (itemDeadline || performance.now() >= deadline) return { status: "deadline", results: settled };
        return { status: "finished", results: settled };
    }

    private async executeUntil(work: SummaryWork, candidates: readonly SummaryCandidate[], budget: SummaryBudget, signal?: AbortSignal, sharedDeadline?: number): Promise<ExternalSummaryResult> {
        const attempts: SummaryAttempt[] = [];
        if (signal?.aborted) return { status: "cancelled", attempts };
        const limits = { ...budget };
        if (!validBudget(limits) || !work.content.trim() || !work.instructions.trim()
            || candidates.length === 0 || candidates.some((target) => typeof target.summarize !== "function")) {
            return { status: "failed", reason: "invalid_plan", attempts };
        }
        const targets = [...candidates];
        const request = Object.freeze({ ...work });
        const startedAt = performance.now();
        const overall = new AbortController();
        // #4833: every internal abort carries its provenance so the candidate's
        // warn line names the real source instead of guessing client-abort.
        const cancel = (source: Exclude<SummaryAbortSource, "target-timeout">): void => { if (!overall.signal.aborted) overall.abort(new SummaryAbortError(source)); };
        const onCallerAbort = (): void => cancel("cancelled");
        signal?.addEventListener("abort", onCallerAbort, { once: true });
        if (signal?.aborted) cancel("cancelled");
        const deadline = Math.min(performance.now() + limits.totalTimeoutMs, sharedDeadline ?? Infinity);
        const totalTimer = setTimeout(() => cancel("batch-deadline"), Math.max(0, deadline - performance.now()));
        const stopped = (): ExternalSummaryResult => {
            if (signal?.aborted) return { status: "cancelled", attempts };
            // [#6885] A deadline exit after at least one attempt means the
            // remaining candidates never got a request out — record them as
            // skipped instead of silently dropping them, so the failure line
            // names the starved tail. When NOTHING dispatched the list stays
            // empty: preflight treats a deadline with zero attempts as pool
            // congestion (#2657 × #2678), and that detection must keep working.
            if (attempts.length > 0) {
                for (let index = attempts.length; index < targets.length; index++) {
                    attempts.push({ targetIndex: index, outcome: "skipped", detail: "total budget exhausted before dispatch" });
                }
            }
            return { status: "deadline", attempts };
        };
        try {
            for (const [targetIndex, target] of targets.entries()) {
                const release = await this.acquire(overall.signal);
                if (performance.now() >= deadline) cancel("batch-deadline");
                if (!release || overall.signal.aborted) {
                    release?.();
                    return stopped();
                }
                const attempt = new AbortController();
                // Propagate the overall abort WITH its reason so the candidate
                // sees which budget (or whose cancellation) killed this attempt.
                const propagateOverall = (): void => { attempt.abort(overall.signal.reason); };
                overall.signal.addEventListener("abort", propagateOverall, { once: true });
                if (overall.signal.aborted) propagateOverall();
                // [#6885] The per-attempt timer must never outlive the batch:
                // without the clamp an attempt started on the last seconds of
                // the total budget carries the full target timeout, so a
                // late-dispatching fetch is killed mid-flight as batch-deadline
                // instead of failing fast on its own (shortened) target budget.
                const attemptTimeoutMs = Math.min(limits.targetTimeoutMs, Math.max(0, deadline - performance.now()));
                const targetDeadline = performance.now() + attemptTimeoutMs;
                const expireTarget = (): void => { attempt.abort(new SummaryAbortError("target-timeout")); };
                const timer = setTimeout(expireTarget, attemptTimeoutMs);
                // Retain the permit until the actual call settles, even if it ignores cancellation.
                const operation: Promise<AttemptResult> = Promise.resolve().then(() => {
                    if (performance.now() >= deadline) cancel("batch-deadline");
                    if (performance.now() >= targetDeadline) expireTarget();
                    if (attempt.signal.aborted) throw new Error("Summary attempt cancelled before dispatch");
                    return target.summarize(request, attempt.signal);
                }).then<AttemptResult, AttemptResult>((value) => ({ kind: "value", value }), (error) => ({ kind: "error", detail: summaryErrorDetail(error) })).finally(release);
                let result: AttemptResult;
                try {
                    result = await awaitAttempt(operation, attempt.signal);
                } finally {
                    clearTimeout(timer);
                    overall.signal.removeEventListener("abort", propagateOverall);
                }
                if (performance.now() >= deadline) cancel("batch-deadline");
                if (overall.signal.aborted) {
                    if (signal?.aborted) attempts.push({ targetIndex, outcome: "cancelled", detail: "caller abort" });
                    else attempts.push({ targetIndex, outcome: "timeout", detail: timeoutDetail(summaryAbortSource(overall.signal) ?? "batch-deadline", limits.totalTimeoutMs, performance.now() - startedAt) });
                    return stopped();
                }
                if (performance.now() >= targetDeadline) expireTarget();
                if (result.kind === "aborted" || attempt.signal.aborted) {
                    attempts.push({ targetIndex, outcome: "timeout", detail: timeoutDetail(summaryAbortSource(attempt.signal) ?? "target-timeout", attemptTimeoutMs, performance.now() - startedAt) });
                } else if (result.kind === "error") {
                    attempts.push({ targetIndex, outcome: "error", ...(result.detail !== undefined ? { detail: result.detail } : {}) });
                } else if (typeof result.value !== "string" || !result.value.trim()
                    || Buffer.byteLength(result.value, "utf8") > limits.maxSummaryBytes
                    || result.value.trim().length < (request.minSummaryChars ?? 1)
                    || ((request.maxSummaryChars ?? 0) > 0 && result.value.trim().length > request.maxSummaryChars!)) {
                    attempts.push({ targetIndex, outcome: "invalid_summary", detail: invalidSummaryDetail(result.value, limits, request) });
                } else {
                    attempts.push({ targetIndex, outcome: "success" });
                    return { status: "success", summary: result.value, targetIndex, attempts };
                }
            }
            return { status: "failed", reason: "exhausted", attempts };
        } finally {
            clearTimeout(totalTimer);
            signal?.removeEventListener("abort", onCallerAbort);
        }
    }

    /** [#2657] Register one batch's pool-size demand for its lifetime; the
     *  returned release restores the previous sizing. No-op when the batch
     *  requests no size (the base pool applies). */
    private beginScope(options?: SummaryPoolOptions): () => void {
        const requested = options?.concurrency;
        if (requested === undefined) return () => {};
        if (!positiveInteger(requested)) throw new TypeError("Summary concurrency must be a positive integer");
        const live = this.scopedConcurrency.get(requested) ?? 0;
        if (live === 0) {
            this.scopedConcurrency.set(requested, 1);
            this.drain();
        } else {
            this.scopedConcurrency.set(requested, live + 1);
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.scopedConcurrency.get(requested) ?? 1) - 1;
            if (remaining > 0) this.scopedConcurrency.set(requested, remaining);
            else this.scopedConcurrency.delete(requested);
        };
    }

    private effectiveConcurrency(): number {
        let cap = this.baseConcurrency;
        for (const requested of this.scopedConcurrency.keys()) if (requested > cap) cap = requested;
        return cap;
    }

    private acquire(signal: AbortSignal): Promise<Release | undefined> {
        if (signal.aborted) return Promise.resolve(undefined);
        return new Promise((resolve) => {
            const waiter: Waiter = {
                signal, resolve,
                abort: () => {
                    const index = this.waiting.indexOf(waiter);
                    if (index >= 0) this.waiting.splice(index, 1);
                    signal.removeEventListener("abort", waiter.abort);
                    resolve(undefined);
                    this.drain();
                },
            };
            this.waiting.push(waiter);
            signal.addEventListener("abort", waiter.abort, { once: true });
            this.drain();
        });
    }

    private drain(): void {
        while (this.active < this.effectiveConcurrency() && this.waiting.length > 0) {
            const waiter = this.waiting.shift();
            if (!waiter) break;
            waiter.signal.removeEventListener("abort", waiter.abort);
            if (waiter.signal.aborted) {
                waiter.resolve(undefined);
                continue;
            }
            this.active++;
            let released = false;
            waiter.resolve(() => {
                if (released) return;
                released = true;
                this.active--;
                this.drain();
            });
        }
    }
}
