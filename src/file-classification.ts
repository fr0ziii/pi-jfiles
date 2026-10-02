import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierOptions, ClassifierResult, Usage } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { Clock, Effect, Option, Semaphore } from "effect";
import {
  fileClassificationAnswersSchema, parseFileClassificationInput,
  type FileClassificationInput, type FileClassificationRequest, type FileClassificationOutput, type FileClassificationOutcome, type FileScanError,
} from "./file-classification-contract.ts";
import { selectSourceFiles, readSelectedSource, type SourceSelection } from "./file-selection.ts";

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
  /** Runtime validation rejects invalid paths, questions, and additional properties before I/O. */
  run(cwd: string, value: FileClassificationInput, runtime: FileClassifierRuntime, callerSignal?: AbortSignal): Effect.Effect<FileClassifierRun>;
}

/** Create an extension-wide runner: at most two scans and four outstanding classifier requests. */
export function createFileClassifier(policy: FileClassifierPolicy = defaultPolicy): FileClassifier {
  const requests = Semaphore.makeUnsafe(4);
  const scans = Semaphore.makeUnsafe(2);

  return {
    run: Effect.fn("FileClassifier.run")(function*(cwd: string, value: FileClassificationInput, runtime: FileClassifierRuntime, callerSignal?: AbortSignal) {
      const startedNanos = yield* Clock.monotonicTimeNanos;
      const result = createEmptyScan();

      const fail = (error: FileScanError) => Effect.gen(function*() {
        result.status = "failed"; result.error = error;
        result.summary.elapsedMs = Math.max(0, Number(((yield* Clock.monotonicTimeNanos) - startedNanos) / 1_000_000n));

        return { result };
      });

      const parsed = parseFileClassificationInput(value);

      if (parsed.status === "error") return yield* fail(parsed.error);
      const input = parsed.input;

      if (input.mode !== "preview" && !runtime.allowRemote) return yield* fail({
        tag: "ConsentRequired", message: "Jev files remote submission is not permitted in this Pi process. Start a new Pi process with --jev-files-allow-remote to submit selected source to TypeSafe. /reload cannot grant startup consent.",
      });

      const admitted = yield* scans.withPermitsIfAvailable(1)(Effect.gen(function*() {
        if (callerSignal?.aborted) return yield* fail({ tag: "Cancelled", message: "Jev files scan was cancelled." });
        let selection: SourceSelection | undefined;
        let aggregateUsage: Usage | undefined;
        let scanError: FileScanError | undefined;

        const stop = (error: FileScanError) => Effect.suspend(() => {
          scanError = error;

          return Effect.fail(error);
        });

        const deadline = Effect.sleep(policy.scanDeadlineMs).pipe(Effect.andThen(
          stop({ tag: "Deadline", message: "Jev files scan reached its deadline." }),
        ));

        const cancellation = callerSignal
          ? Effect.callback<never, FileScanError>(resume => {
              const abort = () => resume(stop({ tag: "Cancelled", message: "Jev files scan was cancelled." }));
              callerSignal.addEventListener("abort", abort, { once: true });

              if (callerSignal.aborted) abort();

              return Effect.sync(() => callerSignal.removeEventListener("abort", abort));
            })
          : Effect.never;

        const operation = Effect.gen(function*() {
          let model: ClassifierModel<ClassifierApi> | undefined;

          if (input.mode !== "preview") {
            const resolved = yield* Effect.tryPromise({
              try: () => runtime.resolveModel(),
              catch: (): FileScanError => ({ tag: "ModelUnavailable", message: "Cannot resolve the TypeSafe classifier." }),
            });

            if (resolved.status === "error") return yield* Effect.fail(resolved.error);
            model = resolved.model;

            if (model.provider !== "typesafe" || model.id !== "jev-latest" || model.api !== "typesafe-system-one") {
              return yield* Effect.fail<FileScanError>({ tag: "ModelUnavailable", message: "Jev files requires typesafe/jev-latest with the TypeSafe classifier API." });
            }

            result.summary.pricing = model.cost.input > 0 || model.cost.output > 0 ? "catalog" : "unknown";
          }

          const selected = yield* selectSourceFiles(cwd, input.selection);
          selection = selected;
          result.summary.discovered = selected.discovered;
          result.summary.selected = selected.selected;
          result.files.push(...selected.outcomes);

          if (input.mode === "preview") {
            for (const file of selected.candidates) result.files.push({ status: "preview", path: file.path, bytes: file.stat.size });
            result.status = "preview";
          } else if (model) {
            const selectedModel = model;
            yield* Effect.forEach(selected.candidates, file => {
              let submitted = false;
              let recorded = false;

              const classifyFile = Effect.uninterruptibleMask(restore => Effect.gen(function*() {
                yield* restore(requests.take(1));
                let handedToProvider = false;

                return yield* restore(Effect.gen(function*() {
                  const source = yield* readSelectedSource(selected.root, file);

                  const context: ClassifierContext = {
                    state: { path: file.path, content: source.content, sourceKind: "untrusted-project-file" },
                    questions: input.questions,
                  };

                  // Conservative byte estimate, not a claim of exact tokenization.
                  if (Buffer.byteLength(JSON.stringify(context)) + 2048 > selectedModel.contextWindow) {
                    return yield* Effect.fail<FileClassificationOutcome>({ status: "skipped", path: file.path, reason: "context-limit" });
                  }

                  const response = yield* Effect.callback<ClassifierResult, FileClassificationOutcome>((resume, signal) => {
                    result.summary.requests++;
                    result.summary.bytesSubmitted += source.bytes;
                    submitted = true;
                    handedToProvider = true;

                    const pending = Promise.resolve().then(() => runtime.classify(selectedModel, context, {
                      signal, timeoutMs: policy.requestDeadlineMs, maxRetries: 0,
                    }));

                      // Ownership crosses the callback boundary: interruption aborts the signal,
                      // but only native Promise settlement releases the shared request permit.
                      void pending.then(
                        response => { Effect.runSync(requests.release(1)); resume(Effect.succeed(response)); },
                        () => {
                          Effect.runSync(requests.release(1));
                          resume(Effect.fail({ status: "failed", path: file.path, reason: "provider-error" }));
                        },
                      );
                    }).pipe(Effect.timeoutOrElse({
                      duration: policy.requestDeadlineMs,
                      orElse: () => Effect.fail<FileClassificationOutcome>({ status: "failed", path: file.path, reason: "deadline" }),
                    }));

                    if (response.usage && isValidUsage(response.usage)) {
                      aggregateUsage = addUsage(aggregateUsage, response.usage);
                      result.summary.usageReports++;
                    }

                    if (response.stopReason !== "stop") return yield* Effect.fail<FileClassificationOutcome>({
                      status: "failed", path: file.path, reason: response.stopReason === "aborted" ? "cancelled" : "provider-error",
                    });
                    const answers = validateFileAnswers(response, input);

                    if (!answers) return yield* Effect.fail<FileClassificationOutcome>({ status: "failed", path: file.path, reason: "invalid-answer" });

                    return { status: "classified", path: file.path, bytes: source.bytes, digest: source.digest, answers } as const;
                  })).pipe(Effect.ensuring(Effect.suspend(() => handedToProvider ? Effect.void : requests.release(1))));
              }));

              return classifyFile.pipe(
                Effect.match({
                  onFailure: outcome => { result.files.push(outcome); recorded = true; },
                  onSuccess: outcome => { result.files.push(outcome); recorded = true; },
                }),
                Effect.onInterrupt(() => Effect.sync(() => {
                  if (submitted && !recorded) result.files.push({
                    status: "failed", path: file.path, reason: scanError?.tag === "Deadline" ? "deadline" : "cancelled",
                  });
                })),
              );
            }, { concurrency: 4, discard: true });
          }
        });

        const error = yield* Effect.raceFirst(operation, Effect.raceFirst(deadline, cancellation)).pipe(
          Effect.match({ onFailure: error => error, onSuccess: () => undefined }),
        );

        if (error && !selection) return yield* fail(error);

        if (error && selection) {
          result.error = error;
          const recorded = new Set(result.files.map(file => file.path));

          for (const file of selection.candidates) {
            if (!recorded.has(file.path)) result.files.push({
              status: "unprocessed", path: file.path, reason: error.tag === "Deadline" ? "deadline" : "cancelled",
            });
          }
        }

        if (aggregateUsage) {
          result.summary.usage.input = aggregateUsage.input;
          result.summary.usage.output = aggregateUsage.output;
          result.summary.usage.totalTokens = aggregateUsage.totalTokens;
          result.summary.usage.costUsd = result.summary.pricing === "catalog" ? aggregateUsage.cost.total : null;
        }

        finalizeScan(result, Math.max(0, Number(((yield* Clock.monotonicTimeNanos) - startedNanos) / 1_000_000n)));

        return aggregateUsage ? { result, usage: aggregateUsage } : { result };
      }));

      return Option.isSome(admitted) ? admitted.value
        : yield* fail({ tag: "ScanBusy", message: "Two Jev files scans are active. Wait for one to finish." });
    }),
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
