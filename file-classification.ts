import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierOptions, ClassifierResult, Usage } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import {
  fileClassificationAnswersSchema, parseFileClassificationInput,
  type FileClassificationRequest, type FileClassificationOutput, type FileClassificationOutcome, type FileScanError,
} from "./file-classification-contract.ts";
import { selectSourceFiles, readSelectedSource } from "./file-selection.ts";

/** Runtime boundary for Pi authentication and classifier execution; source is never logged here. */
export interface FileClassifierRuntime {
  readonly allowRemote: boolean;
  resolveModel(): Promise<
    | { readonly status: "ok"; readonly model: ClassifierModel<ClassifierApi> }
    | { readonly status: "error"; readonly error: FileScanError }
  >;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options: ClassifierOptions): Promise<ClassifierResult>;
}
/** One scan plus reported provider usage for Pi's nested tool accounting. */
export interface FileClassifierRun {
  readonly result: FileClassificationOutput;
  readonly usage?: Usage;
}
/** Internal service policy; tool callers cannot raise resource limits. */
export interface FileClassifierPolicy {
  readonly scanDeadlineMs: number;
  readonly requestDeadlineMs: number;
}
const defaultPolicy: FileClassifierPolicy = { scanDeadlineMs: 120_000, requestDeadlineMs: 30_000 };

/** One file classification operation; each instance owns its shared request and scan budgets. */
export interface FileClassifier {
  run(cwd: string, value: unknown, runtime: FileClassifierRuntime, callerSignal?: AbortSignal): Promise<FileClassifierRun>;
}
/** Clock capability for scan duration reporting; deadlines use runtime timers. */
export interface FileClassifierClock {
  now(): number;
}
/** Create an extension-wide runner: at most two scans and four outstanding classifier requests. */
export function createFileClassifier(
  policy: FileClassifierPolicy = defaultPolicy,
  clock: FileClassifierClock = { now: Date.now },
): FileClassifier {
  const requests = new ClassifierRequestSlots();
  let activeScans = 0;
  return {
    async run(cwd: string, value: unknown, runtime: FileClassifierRuntime, callerSignal?: AbortSignal): Promise<FileClassifierRun> {
      const started = clock.now();
      const result = createEmptyScan();
      const fail = (error: FileScanError): FileClassifierRun => {
        result.status = "failed"; result.error = error;
        result.summary.elapsedMs = Math.max(0, clock.now() - started);
        return { result };
      };
      const parsed = parseFileClassificationInput(value);
      if (parsed.status === "error") return fail(parsed.error);
      const input = parsed.input;
      const preview = input.mode === "preview";
      if (!preview && !runtime.allowRemote) return fail({ tag: "ConsentRequired", message: "Jev files remote submission is not permitted in this Pi process. Start a new Pi process with --jev-files-allow-remote to submit selected source to TypeSafe. /reload cannot grant startup consent." });
      if (activeScans >= 2) return fail({ tag: "ScanBusy", message: "Two Jev files scans are active. Wait for one to finish." });
      activeScans++;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), policy.scanDeadlineMs);
      const signal = AbortSignal.any([deadline.signal, ...(callerSignal ? [callerSignal] : [])]);
      const cancelledError = (): FileScanError => deadline.signal.aborted
        ? { tag: "Deadline", message: "Jev files scan reached its deadline." }
        : { tag: "Cancelled", message: "Jev files scan was cancelled." };
      try {
        if (signal.aborted) return fail(cancelledError());
        let model: ClassifierModel<ClassifierApi> | undefined;
        if (!preview) {
          const resolved = await withAbort(runtime.resolveModel(), signal);
          if (resolved.status === "cancelled") return fail(cancelledError());
          if (resolved.status === "error") return fail({ tag: "ModelUnavailable", message: "Cannot resolve the TypeSafe classifier." });
          if (resolved.value.status === "error") return fail(resolved.value.error);
          model = resolved.value.model;
          if (model.provider !== "typesafe" || model.id !== "jev-latest" || model.api !== "typesafe-system-one") {
            return fail({ tag: "ModelUnavailable", message: "Jev files requires typesafe/jev-latest with the TypeSafe classifier API." });
          }
          result.summary.pricing = model.cost.input > 0 || model.cost.output > 0 ? "catalog" : "unknown";
        }
        const selection = await selectSourceFiles(cwd, input.selection, signal);
        if (selection.status === "error") return fail(signal.aborted ? cancelledError() : selection.error);
        result.summary.discovered = selection.discovered;
        result.summary.selected = selection.selected;
        result.files.push(...selection.outcomes);
        if (preview) {
          for (const file of selection.candidates) result.files.push({ status: "preview", path: file.path, bytes: file.stat.size });
          result.status = "preview";
        } else if (model) {
          let nextFile = 0;
          let aggregateUsage: Usage | undefined;
          const selectedModel = model;
          const worker = async () => {
            for (;;) {
              const file = selection.candidates[nextFile++];
              if (!file) return;
              const release = await requests.acquire(signal);
              if (!release) {
                result.files.push({ status: "unprocessed", path: file.path, reason: deadline.signal.aborted ? "deadline" : "cancelled" });
                continue;
              }
              // Keep the permit until the provider settles, even if it ignores abort.
              let ownsPermit = true;
              try {
                const source = await readSelectedSource(selection.root, file, signal);
                if (source.status === "error") {
                  const outcome = source.outcome;
                  result.files.push(outcome.status === "unprocessed" && deadline.signal.aborted
                    ? { ...outcome, reason: "deadline" } : outcome);
                  continue;
                }
                const context: ClassifierContext = {
                  state: { path: file.path, content: source.content, sourceKind: "untrusted-project-file" },
                  questions: input.questions,
                };
                // Conservative byte estimate, not a claim of exact tokenization.
                if (Buffer.byteLength(JSON.stringify(context)) + 2048 > selectedModel.contextWindow) {
                  result.files.push({ status: "skipped", path: file.path, reason: "context-limit" }); continue;
                }
                if (signal.aborted) {
                  result.files.push({ status: "unprocessed", path: file.path, reason: deadline.signal.aborted ? "deadline" : "cancelled" }); continue;
                }
                const requestDeadline = new AbortController();
                const requestTimer = setTimeout(() => requestDeadline.abort(), policy.requestDeadlineMs);
                const requestSignal = AbortSignal.any([signal, requestDeadline.signal]);
                result.summary.requests++;
                result.summary.bytesSubmitted += source.bytes;
                const pending = Promise.resolve().then(() =>
                  runtime.classify(selectedModel, context, { signal: requestSignal, timeoutMs: policy.requestDeadlineMs, maxRetries: 0 }));
                ownsPermit = false;
                // Both settlement branches release; never leave an unhandled rejection.
                void pending.then(release, release);
                let classified: Awaited<ReturnType<typeof withAbort<ClassifierResult>>>;
                try { classified = await withAbort(pending, requestSignal); }
                finally { clearTimeout(requestTimer); }
                if (classified.status !== "value") {
                  result.files.push({ status: "failed", path: file.path,
                    reason: classified.status === "error" ? "provider-error" :
                      (deadline.signal.aborted || requestDeadline.signal.aborted ? "deadline" : "cancelled") });
                  continue;
                }
                const response = classified.value;
                if (response.usage && isValidUsage(response.usage)) {
                  aggregateUsage = addUsage(aggregateUsage, response.usage);
                  result.summary.usageReports++;
                }
                if (response.stopReason !== "stop") {
                  result.files.push({ status: "failed", path: file.path,
                    reason: response.stopReason === "aborted" ? "cancelled" : "provider-error" }); continue;
                }
                const answers = validateFileAnswers(response, input);
                if (!answers) {
                  result.files.push({ status: "failed", path: file.path, reason: "invalid-answer" }); continue;
                }
                result.files.push({ status: "classified", path: file.path, bytes: source.bytes, digest: source.digest, answers });
              } finally { if (ownsPermit) release(); }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, selection.candidates.length) }, worker));
          if (aggregateUsage) {
            result.summary.usage.input = aggregateUsage.input;
            result.summary.usage.output = aggregateUsage.output;
            result.summary.usage.totalTokens = aggregateUsage.totalTokens;
            result.summary.usage.costUsd = result.summary.pricing === "catalog" ? aggregateUsage.cost.total : null;
          }
          finalizeScan(result, Math.max(0, clock.now() - started));
          if (signal.aborted) result.error = cancelledError();
          return aggregateUsage ? { result, usage: aggregateUsage } : { result };
        }
        finalizeScan(result, Math.max(0, clock.now() - started));
        return { result };
      } finally { clearTimeout(timer); activeScans--; }
    },
  };
}

function createEmptyScan(): FileClassificationOutput {
  return {
    version: 1, status: "complete", model: { provider: "typesafe", id: "jev-latest" },
    summary: { discovered: 0, selected: 0, classified: 0, previewed: 0, skipped: 0, failed: 0, unprocessed: 0,
      bytesSubmitted: 0, requests: 0, elapsedMs: 0, usageReports: 0, usageAvailability: "none", pricing: "unknown",
      usage: { input: 0, output: 0, totalTokens: 0, costUsd: null } },
    files: [],
  };
}

function finalizeScan(result: FileClassificationOutput, elapsedMs: number): void {
  result.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const file of result.files) {
    switch (file.status) {
      case "classified": result.summary.classified++; break;
      case "preview": result.summary.previewed++; break;
      case "skipped": result.summary.skipped++; break;
      case "failed": result.summary.failed++; break;
      case "unprocessed": result.summary.unprocessed++; break;
    }
  }
  if (result.status !== "preview") result.status = result.summary.skipped + result.summary.failed + result.summary.unprocessed > 0 ? "partial" : "complete";
  result.summary.usageAvailability = result.summary.usageReports === 0 ? "none"
    : result.summary.usageReports === result.summary.requests ? "complete" : "partial";
  result.summary.elapsedMs = elapsedMs;
}

function validateFileAnswers(response: ClassifierResult, input: FileClassificationRequest):
  Extract<FileClassificationOutcome, { status: "classified" }>["answers"] | undefined {
  if (!Check(fileClassificationAnswersSchema, response.answers)) return undefined;
  if (Object.keys(response.answers).length !== Object.keys(input.questions).length) return undefined;
  for (const [key, question] of Object.entries(input.questions)) {
    const answer = response.answers[key];
    if (!answer || answer.type !== question.type) return undefined;
    if (question.type === "choice" && answer.type === "choice") {
      const labels = Object.keys(question.criteria).sort();
      if (!labels.includes(answer.choice) || Object.keys(answer.probabilities).sort().join("\0") !== labels.join("\0") ||
          Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01) return undefined;
    }
    if (question.type === "score" && answer.type === "score" && answer.score > question.criteria.length - 1) return undefined;
  }
  return response.answers;
}

function isValidUsage(usage: Usage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens,
    usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite, usage.cost.total]
    .every(value => Number.isFinite(value) && value >= 0) &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(Number.isSafeInteger);
}
function addUsage(previous: Usage | undefined, usage: Usage): Usage {
  return {
    input: (previous?.input ?? 0) + usage.input, output: (previous?.output ?? 0) + usage.output,
    cacheRead: (previous?.cacheRead ?? 0) + usage.cacheRead, cacheWrite: (previous?.cacheWrite ?? 0) + usage.cacheWrite,
    totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
    cost: {
      input: (previous?.cost.input ?? 0) + usage.cost.input, output: (previous?.cost.output ?? 0) + usage.cost.output,
      cacheRead: (previous?.cost.cacheRead ?? 0) + usage.cost.cacheRead,
      cacheWrite: (previous?.cost.cacheWrite ?? 0) + usage.cost.cacheWrite,
      total: (previous?.cost.total ?? 0) + usage.cost.total,
    },
  };
}

async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<
  { readonly status: "value"; readonly value: T } | { readonly status: "cancelled" } | { readonly status: "error" }
> {
  return new Promise(resolve => {
    const abort = () => resolve({ status: "cancelled" });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      value => resolve({ status: "value", value }),
      () => resolve({ status: "error" }),
    ).finally(() => signal.removeEventListener("abort", abort));
  });
}

class ClassifierRequestSlots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        this.running++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true; this.running--;
          this.waiting.shift()?.();
        });
      };
      const abort = () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(undefined);
      };
      if (this.running < 4) grant();
      else {
        this.waiting.push(grant);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}
