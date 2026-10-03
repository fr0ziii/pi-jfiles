import assert from "node:assert/strict";
import { Clock, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { test } from "node:test";
import type { ClassifierResult, Usage } from "@earendil-works/pi-ai";
import type { FileClassificationInput } from "../src/file-classification-contract.ts";
import { createFileClassifier, type FileClassifierRun } from "../src/file-classification.ts";
import { createTestProject, hasValidCoverage, testClassifierModel, testClassifierResponse, testRequest, testRuntime } from "./test-fixtures.ts";

test("deduplicates exact paths and submits whole source without retries", async t => {
  const source = "SOURCE_ONLY_IN_CLASSIFIER: calculateProratedCharge()";
  const root = await createTestProject(t, { "src/example.ts": source, "src/other.ts": "other" });
  const request = testRequest(["src/example.ts", "src/other.ts", "src/example.ts"]);
  request.questions.layer = { type: "choice", instructions: "Which layer?",
    criteria: { domain: "Domain behavior", adapter: "Runtime dependency" } };
  request.questions.risk = { type: "score", instructions: "Rate isolation.", criteria: ["Coupled", "Mixed", "Isolated"] };
  let calls = 0;

  const runtime = testRuntime({ classify: async (_model, context, options) => {
    calls++;
    assert.equal(Object.keys(context.questions).length, 3);
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal);

    if (context.state.path === "src/example.ts") assert.equal(context.state.content, source);

    return testClassifierResponse(context);
  } });

  const runner = createFileClassifier();
  const scan = await Effect.runPromise(runner.run(root, request, runtime));
  assert.equal(calls, 2);
  assert.equal(scan.result.status, "complete");
  assert.equal(JSON.stringify(scan).includes(source), false);
  assert.ok(hasValidCoverage(scan.result));
  const first = scan.result.files[0];
  assert.ok(first?.status === "classified");
  assert.deepEqual(Object.keys(first.answers).sort(), ["layer", "relevant", "risk"]);
  assert.equal(first.digest.length, 64);
});

test("schema-shaped invalid requests fail before discovery or provider access", async () => {
  const runner = createFileClassifier();

  const runtime = testRuntime({
    resolveModel: async () => { throw new Error("Invalid input must not resolve the model"); },
    classify: async () => { throw new Error("Invalid input must not submit source"); },
  });

  // TypeScript checks the request shape, not portable paths, strict objects, keys, or byte limits.
  const extraPreview = { mode: "preview" as const, selection: { kind: "paths" as const, paths: ["a.ts"] }, questions: {} };
  const reservedKey = testRequest();
  const question = reservedKey.questions.relevant;

  assert.ok(question);
  reservedKey.questions = { constructor: question };

  const largeQuestions = testRequest();
  largeQuestions.questions.large = {
    type: "choice", instructions: "Classify",
    criteria: Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["label" + index, "x".repeat(1000)])),
  };

  const invalid: FileClassificationInput[] = [testRequest(["../outside.ts"]), extraPreview, reservedKey, largeQuestions];

  for (const input of invalid) {
    // A nonexistent root makes accidental discovery observable without filesystem fixtures.
    const scan = await Effect.runPromise(runner.run("/unused-invalid-request-root", input, runtime));

    assert.equal(scan.result.status, "failed");
    assert.equal(scan.result.error?.tag, "InvalidRequest");
    assert.equal(scan.result.summary.requests, 0);
    assert.equal(scan.result.summary.bytesSubmitted, 0);
    assert.deepEqual(scan.result.files, []);
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("classifier input and complete Effect result stay schema-derived", () => {
  const runner = createFileClassifier();
  const runtime = testRuntime();
  const preview = runner.run(".", { mode: "preview", selection: { kind: "paths", paths: ["a.ts"] } }, runtime);
  const classification = runner.run(".", testRequest(), runtime);
  const explicit = runner.run(".", { ...testRequest(), mode: "classify" }, runtime);
  const inferred: Effect.Effect<FileClassifierRun, never, never> = classification;
  const unparsed: unknown = JSON.parse("{}");

  assert.ok(Effect.isEffect(preview));
  assert.ok(Effect.isEffect(explicit));
  assert.equal(inferred, classification);

  // Effects are lazy: these intentionally rejected call sites are never executed.
  // @ts-expect-error Classification requires questions.
  runner.run(".", { selection: { kind: "paths", paths: ["a.ts"] } }, runtime);
  // @ts-expect-error Preview rejects questions.
  runner.run(".", { mode: "preview", selection: { kind: "paths", paths: ["a.ts"] }, questions: {} }, runtime);
  // @ts-expect-error Callers cannot pass unknown input without parsing it.
  runner.run(".", unparsed, runtime);
  // @ts-expect-error The runner does not accept additional library parse options.
  runner.run(".", testRequest(), runtime, undefined, {});
});

test("remote consent, unavailable models, and missing credentials fail before source submission", async t => {
  const root = await createTestProject(t, { "src/example.ts": "NEVER_UPLOAD" });
  const runner = createFileClassifier();

  const consent = await Effect.runPromise(runner.run(root, testRequest(), testRuntime({
    allowRemote: false, resolveModel: async () => { throw new Error("Must not resolve without consent"); },
  })));

  assert.equal(consent.result.error?.tag, "ConsentRequired");

  const unavailable = await Effect.runPromise(runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "error", error: { tag: "ModelUnavailable", message: "No model" } }),
  })));

  assert.equal(unavailable.result.error?.tag, "ModelUnavailable");

  const credentials = await Effect.runPromise(runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "error", error: { tag: "CredentialsRequired", message: "No credentials" } }),
  })));

  assert.equal(credentials.result.error?.tag, "CredentialsRequired");

  const fallback = await Effect.runPromise(runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "ok", model: { ...testClassifierModel, provider: "openrouter" } }),
  })));

  assert.equal(fallback.result.error?.tag, "ModelUnavailable");
  assert.match(consent.result.error?.message ?? "", /new Pi process.*--jev-files-allow-remote/u);
  assert.match(consent.result.error?.message ?? "", /\/reload cannot/u);

  for (const scan of [consent, unavailable, credentials, fallback]) {
    assert.equal(scan.result.summary.requests, 0);
    assert.equal(scan.result.summary.bytesSubmitted, 0);
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("honestly reports provider errors, throws, and invalid answers without error payloads", async t => {
  const root = await createTestProject(t, { "src/example.ts": "SECRET_SOURCE" });

  const mutations: ((response: ClassifierResult) => ClassifierResult)[] = [
    response => ({ ...response, stopReason: "error", errorMessage: "SECRET_SOURCE raw provider request" }),
    response => ({ ...response, answers: {} }),
    response => ({ ...response, answers: { relevant: { type: "bool", probability: 1.5 } } }),
    response => ({ ...response, answers: { relevant: { type: "bool", probability: Number.NaN } } }),
    response => ({ ...response, answers: { relevant: { type: "score", score: 1, confidence: 0.5 } } }),
    response => ({ ...response, answers: { ...response.answers, extra: { type: "bool", probability: 0.8 } } }),
    () => { throw new Error("SECRET_SOURCE thrown provider request"); },
  ];

  for (const mutate of mutations) {
    const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime({
      classify: async (_model, context) => mutate(testClassifierResponse(context)),
    })));

    assert.equal(scan.result.status, "partial");
    assert.equal(scan.result.summary.failed, 1);
    assert.equal(scan.result.summary.classified, 0);
    assert.equal(JSON.stringify(scan).includes("SECRET_SOURCE"), false);
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("provider aborts are explicit cancelled outcomes, not fabricated answers", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });

  const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime({
    classify: async (_model, context) => ({ ...testClassifierResponse(context), stopReason: "aborted" }),
  })));

  assert.equal(scan.result.status, "partial");
  assert.deepEqual(scan.result.files, [{ status: "failed", path: "src/example.ts", reason: "cancelled" }]);
  assert.ok(hasValidCoverage(scan.result));
});

test("rejects unknown choice labels, incomplete probabilities, and scores outside caller criteria", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const request = testRequest();
  request.questions.layer = { type: "choice", instructions: "Which layer?", criteria: { domain: "Domain", adapter: "Adapter" } };
  request.questions.risk = { type: "score", instructions: "Rate risk.", criteria: ["Low", "High"] };

  for (const answers of [
    { layer: { type: "choice", choice: "unknown", probabilities: { domain: 1, adapter: 0 }, confidence: 1 } },
    { layer: { type: "choice", choice: "domain", probabilities: { domain: 1 }, confidence: 1 } },
    { layer: { type: "choice", choice: "domain", probabilities: { domain: 1, adapter: 1 }, confidence: 1 } },
    { risk: { type: "score", score: 2, confidence: 1 } },
  ] satisfies Partial<ClassifierResult["answers"]>[]) {
    const scan = await Effect.runPromise(createFileClassifier().run(root, request, testRuntime({
      classify: async (_model, context) => {
        const response = testClassifierResponse(context);

        return { ...response, answers: { ...response.answers, ...answers } };
      },
    })));

    assert.equal(scan.result.files[0]?.status, "failed");
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("finite fractional scores remain valid within caller criteria", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const request = testRequest();
  request.questions.risk = { type: "score", instructions: "Rate risk.", criteria: ["Low", "High"] };

  const scan = await Effect.runPromise(createFileClassifier().run(root, request, testRuntime({
    classify: async (_model, context) => ({ ...testClassifierResponse(context),
      answers: { relevant: { type: "bool", probability: 0 }, risk: { type: "score", score: 0.5, confidence: 1 } } }),
  })));

  assert.equal(scan.result.summary.classified, 1);
  assert.ok(hasValidCoverage(scan.result));
});

test("skips estimated context overflow without truncating source or questions", async t => {
  const root = await createTestProject(t, { "src/example.ts": "x".repeat(63_000) });
  const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime()));
  assert.equal(scan.result.files[0]?.status, "skipped");
  assert.equal(scan.result.summary.requests, 0);
  assert.ok(hasValidCoverage(scan.result));
});

const reportedUsage: Usage = {
  input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 },
};

test("aggregates reported usage, including billed errors; unknown catalog pricing is not free", async t => {
  const root = await createTestProject(t, { "a.ts": "a", "b.ts": "b", "c.ts": "c" });

  const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(["a.ts", "b.ts", "c.ts"]), testRuntime({
    classify: async (_model, context) => {
      const response = testClassifierResponse(context);

      if (context.state.path === "c.ts") return response;

      const billed: ClassifierResult = { ...response, usage: reportedUsage };

      if (context.state.path === "b.ts") {
        billed.stopReason = "error";
        billed.errorMessage = "Billed error";
      }

      return billed;
    },
  })));

  assert.equal(scan.usage?.input, 20);
  assert.equal(scan.result.summary.usageReports, 2);
  assert.equal(scan.result.summary.usageAvailability, "partial");
  assert.equal(scan.result.summary.pricing, "unknown");
  assert.equal(scan.result.summary.usage.costUsd, null);
  assert.equal(scan.result.summary.usage.totalTokens, 24);
  assert.ok(hasValidCoverage(scan.result));
});

test("reported zero usage differs from missing or invalid usage, and catalog costs remain explicit", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });

  const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  for (const usage of [zero, undefined, { ...zero, input: -1 }, { ...zero, output: 0.5 },
    { ...zero, cacheRead: 0.5 }, { ...zero, cacheWrite: Number.NaN },
    { ...zero, cost: { ...zero.cost, total: Number.POSITIVE_INFINITY } }]) {
    const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime({
      classify: async (_model, context) => {
        const response = testClassifierResponse(context);

        if (usage) response.usage = usage;

        assert.equal(Object.hasOwn(response, "usage"), usage !== undefined);

        return response;
      },
    })));

    assert.equal(scan.result.status, "complete");
    assert.equal(scan.result.summary.usageReports, usage === zero ? 1 : 0);
    assert.equal(scan.result.summary.usageAvailability, usage === zero ? "complete" : "none");
    assert.equal(scan.result.summary.usage.costUsd, null);
    assert.equal(scan.usage !== undefined, usage === zero);
    assert.ok(hasValidCoverage(scan.result));
  }

  const priced = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "ok", model: { ...testClassifierModel,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }),
    classify: async (_model, context) => ({ ...testClassifierResponse(context), usage: reportedUsage }),
  })));

  assert.equal(priced.result.summary.pricing, "catalog");
  assert.equal(priced.result.summary.usage.costUsd, reportedUsage.cost.total);
  assert.ok(hasValidCoverage(priced.result));
});

test("held permits become available only when cancelled provider promises settle", async t => {
  const paths = Array.from({ length: 5 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  const controller = new AbortController();
  const pending: { context: Parameters<typeof testClassifierResponse>[0]; resolve: (value: ClassifierResult) => void }[] = [];

  const runtime = testRuntime({ classify: async (_model, context) => new Promise<ClassifierResult>(resolve => {
    pending.push({ context, resolve });

    if (pending.length === 4) controller.abort();
  }) });

  const runner = createFileClassifier();
  const cancelled = await Effect.runPromise(runner.run(root, testRequest(paths), runtime, controller.signal));
  assert.equal(cancelled.result.error?.tag, "Cancelled");
  assert.equal(cancelled.result.summary.requests, 4);
  assert.ok(hasValidCoverage(cancelled.result));

  for (const request of pending) request.resolve(testClassifierResponse(request.context));
  const followup = await Effect.runPromise(runner.run(root, testRequest(paths), testRuntime()));
  assert.equal(followup.result.summary.classified, paths.length);
  assert.ok(hasValidCoverage(followup.result));
});

test("shares a four-request concurrency budget across concurrent scans", async t => {
  const paths = Array.from({ length: 12 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  const ready = Deferred.makeUnsafe<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;

  const runtime = testRuntime({
    classify: async (_model, context) => {
      active++; maximum = Math.max(maximum, active);

      if (active === 4) Effect.runSync(Deferred.succeed(ready, undefined));
      await release.promise;
      active--;

      return testClassifierResponse(context);
    },
  });

  const runner = createFileClassifier();

  const scans = Promise.all([
    Effect.runPromise(runner.run(root, testRequest(paths), runtime)),
    Effect.runPromise(runner.run(root, testRequest(paths), runtime)),
  ]);

  await Effect.runPromise(Deferred.await(ready));
  assert.equal(maximum, 4);
  release.resolve();

  for (const scan of await scans) {
    assert.equal(scan.result.summary.classified, 12);
    assert.ok(hasValidCoverage(scan.result));
  }

  assert.equal(active, 0);
  assert.equal(maximum, 4);
});

test("rejects a third active scan and accounts for all files on cancellation", async t => {
  const paths = Array.from({ length: 12 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const clock = yield* TestClock.make();
    const ready = yield* Deferred.make<void>();
    const admitted = yield* Deferred.make<void>();
    let resolved = 0;
    let started = 0;

    const runtime = testRuntime({
      resolveModel: async () => {
        resolved++;

        if (resolved === 2) Effect.runSync(Deferred.succeed(admitted, undefined));

        return { status: "ok", model: testClassifierModel };
      },
      classify: async () => {
        started++;

        if (started === 4) Effect.runSync(Deferred.succeed(ready, undefined));

        return new Promise<ClassifierResult>(() => {});
      },
    });

    const runner = createFileClassifier({ scanDeadlineMs: 1000, requestDeadlineMs: 1000 });
    const controller = new AbortController();

    const first = yield* runner.run(root, testRequest(paths), runtime, controller.signal).pipe(
      Effect.provideService(Clock.Clock, clock), Effect.forkChild,
    );

    const second = yield* runner.run(root, testRequest(paths), runtime, controller.signal).pipe(
      Effect.provideService(Clock.Clock, clock), Effect.forkChild,
    );

    yield* Deferred.await(admitted);
    const third = yield* runner.run(root, testRequest(paths), runtime);
    assert.equal(third.result.error?.tag, "ScanBusy");
    yield* Deferred.await(ready);
    controller.abort();

    for (const scan of [yield* Fiber.join(first), yield* Fiber.join(second)]) {
      assert.equal(scan.result.error?.tag, "Cancelled");
      assert.ok(hasValidCoverage(scan.result));
      assert.equal(scan.result.summary.classified, 0);
    }

    assert.equal(started, 4);

    // An ignored abort cannot free a permit and start more provider requests.
    const retained = yield* runner.run(root, testRequest(paths), runtime).pipe(
      Effect.provideService(Clock.Clock, clock), Effect.forkChild,
    );

    yield* clock.adjust(1000);
    const scan = yield* Fiber.join(retained);
    assert.equal(scan.result.error?.tag, "Deadline");
    assert.equal(scan.result.summary.requests, 0);
    assert.equal(started, 4);
    assert.ok(hasValidCoverage(scan.result));
  })));
});

test("request deadlines finish even if the provider ignores AbortSignal", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const clock = yield* TestClock.make();
    const ready = yield* Deferred.make<void>();
    let requestSignal: AbortSignal | undefined;

    const fiber = yield* createFileClassifier({ scanDeadlineMs: 1000, requestDeadlineMs: 20 }).run(
      root, testRequest(), testRuntime({
        classify: async (_model, _context, options) => {
          requestSignal = options.signal;
          Effect.runSync(Deferred.succeed(ready, undefined));

          return new Promise<ClassifierResult>(() => {});
        },
      }),
    ).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);

    yield* Deferred.await(ready);
    yield* clock.adjust(20);
    const scan = yield* Fiber.join(fiber);
    const file = scan.result.files[0];
    assert.ok(file && file.status === "failed");
    assert.equal(file.reason, "deadline");
    assert.equal(scan.result.summary.elapsedMs, 20);
    assert.equal(requestSignal?.aborted, true);
    assert.ok(hasValidCoverage(scan.result));
  })));
});

test("scan deadlines abort requests and account for queued files", async t => {
  const paths = Array.from({ length: 12 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const clock = yield* TestClock.make();
    const ready = yield* Deferred.make<void>();
    const pending: { signal: AbortSignal | undefined; context: Parameters<typeof testClassifierResponse>[0]; resolve: (response: ClassifierResult) => void }[] = [];

    const runtime = testRuntime({
      classify: async (_model, context, options) => new Promise<ClassifierResult>(resolve => {
        pending.push({ signal: options.signal, context, resolve });

        if (pending.length === 4) Effect.runSync(Deferred.succeed(ready, undefined));
      }),
    });

    const runner = createFileClassifier({ scanDeadlineMs: 20, requestDeadlineMs: 1000 });

    const fiber = yield* runner.run(root, testRequest(paths), runtime).pipe(
      Effect.provideService(Clock.Clock, clock), Effect.forkChild,
    );

    yield* Deferred.await(ready);
    yield* clock.adjust(20);
    const scan = yield* Fiber.join(fiber);
    assert.equal(scan.result.error?.tag, "Deadline");
    assert.equal(scan.result.summary.failed, 4);
    assert.equal(scan.result.summary.unprocessed, 8);
    assert.equal(scan.result.summary.elapsedMs, 20);
    assert.ok(pending.every(request => request.signal?.aborted));
    assert.ok(hasValidCoverage(scan.result));
    const snapshot = JSON.stringify(scan);

    for (const request of pending) request.resolve(testClassifierResponse(request.context));
    const followup = yield* runner.run(root, testRequest(paths), testRuntime()).pipe(Effect.provideService(Clock.Clock, clock));
    assert.equal(followup.result.summary.classified, paths.length);
    assert.equal(followup.result.summary.elapsedMs, 0);
    assert.equal(JSON.stringify(scan), snapshot);
  })));
});

test("cancellation interrupts model resolution without submitting source", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const controller = new AbortController();
  const resolving = Deferred.makeUnsafe<void>();
  const model = Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof testRuntime>["resolveModel"]>>>();
  const runner = createFileClassifier();

  const pending = Effect.runPromise(runner.run(root, testRequest(), testRuntime({
    resolveModel: () => {
      Effect.runSync(Deferred.succeed(resolving, undefined));

      return model.promise;
    },
  }), controller.signal));

  await Effect.runPromise(Deferred.await(resolving));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.result.error?.tag, "Cancelled");
  assert.equal(cancelled.result.summary.requests, 0);
  const followup = await Effect.runPromise(runner.run(root, testRequest(), testRuntime()));
  assert.equal(followup.result.summary.classified, 1);
  model.resolve({ status: "error", error: { tag: "ModelUnavailable", message: "Late synthetic result" } });
});

test("Effect interruption preserves cancellation and releases permits on late settlement", async t => {
  const paths = Array.from({ length: 5 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "synthetic"])));
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const ready = yield* Deferred.make<void>();
    const pending: { signal: AbortSignal | undefined; context: Parameters<typeof testClassifierResponse>[0]; completion: ReturnType<typeof Promise.withResolvers<ClassifierResult>> }[] = [];
    const runner = createFileClassifier();

    const fiber = yield* runner.run(root, testRequest(paths), testRuntime({
      classify: (_model, context, options) => {
        const completion = Promise.withResolvers<ClassifierResult>();
        pending.push({ signal: options.signal, context, completion });

        if (pending.length === 4) Effect.runSync(Deferred.succeed(ready, undefined));

        return completion.promise;
      },
    })).pipe(Effect.forkChild);

    yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
    assert.ok(Exit.hasInterrupts(yield* Fiber.await(fiber)));
    assert.ok(pending.every(request => request.signal?.aborted));

    // Preview proves that interruption returned scan admission without freeing provider capacity.
    const previews = yield* Effect.all([1, 2].map(() => runner.run(root, {
      mode: "preview", selection: { kind: "paths", paths },
    }, testRuntime())), { concurrency: 2 });

    assert.ok(previews.every(scan => scan.result.status === "preview"));

    for (const [index, request] of pending.entries()) {
      if (index % 2 === 0) request.completion.reject(new Error("SYNTHETIC_LATE_PROVIDER_FAILURE"));
      else request.completion.resolve(testClassifierResponse(request.context));
    }

    const followup = yield* runner.run(root, testRequest(paths), testRuntime());
    assert.equal(followup.result.summary.classified, paths.length);
    assert.ok(hasValidCoverage(followup.result));
  })));
});

test("non-submitted files release their permits for queued files", async t => {
  const binaryPaths = Array.from({ length: 12 }, (_, index) => "binary" + index + ".ts");

  const root = await createTestProject(t, {
    ...Object.fromEntries(binaryPaths.map(path => [path, Buffer.from([0])])),
    "src/example.ts": "synthetic",
  });

  const scan = await Effect.runPromise(createFileClassifier().run(
    root, testRequest([...binaryPaths, "src/example.ts"]), testRuntime(),
  ));

  assert.equal(scan.result.summary.skipped, binaryPaths.length);
  assert.equal(scan.result.summary.requests, 1);
  assert.equal(scan.result.summary.classified, 1);
  assert.ok(hasValidCoverage(scan.result));
});

test("scan duration uses the Effect clock", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });

  const scan = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const clock = yield* TestClock.make();
    yield* clock.setTime(100);

    return yield* createFileClassifier().run(root, testRequest(), testRuntime({
      classify: async (_model, context) => {
        await Effect.runPromise(clock.adjust(25));

        return testClassifierResponse(context);
      },
    })).pipe(Effect.provideService(Clock.Clock, clock));
  })));

  assert.equal(scan.result.summary.elapsedMs, 25);
  assert.equal(scan.result.status, "complete");
});

test("pre-aborted calls do not submit source or resolve credentials", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const signal = AbortSignal.abort();

  const scan = await Effect.runPromise(createFileClassifier().run(root, testRequest(), testRuntime({
    resolveModel: async () => { throw new Error("Already cancelled"); },
  }), signal));

  assert.equal(scan.result.error?.tag, "Cancelled");
  assert.equal(scan.result.summary.requests, 0);
});
