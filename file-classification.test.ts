import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ClassifierResult, Usage } from "@earendil-works/pi-ai";
import { createFileClassifier } from "./file-classification.ts";
import { createTestProject, hasValidCoverage, testClassifierModel, testClassifierResponse, testRequest, testRuntime } from "./test-fixtures.ts";

test("classifies three dynamic questions per whole file in one request and supports path follow-up", async t => {
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
  const scan = await runner.run(root, request, runtime);
  assert.equal(calls, 2);
  assert.equal(scan.result.status, "complete");
  assert.equal(JSON.stringify(scan).includes(source), false);
  assert.ok(hasValidCoverage(scan.result));
  const first = scan.result.files[0];
  assert.ok(first?.status === "classified");
  assert.deepEqual(Object.keys(first.answers).sort(), ["layer", "relevant", "risk"]);
  assert.equal(first.digest.length, 64);
  const followup = await runner.run(root, testRequest([first.path]), testRuntime());
  assert.equal(followup.result.summary.classified, 1);
});

test("remote consent, unavailable models, and missing credentials fail before source submission", async t => {
  const root = await createTestProject(t, { "src/example.ts": "NEVER_UPLOAD" });
  const runner = createFileClassifier();
  const consent = await runner.run(root, testRequest(), testRuntime({
    allowRemote: false, resolveModel: async () => { throw new Error("Must not resolve without consent"); },
  }));
  assert.equal(consent.result.error?.tag, "ConsentRequired");
  const unavailable = await runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "error", error: { tag: "ModelUnavailable", message: "No model" } }),
  }));
  assert.equal(unavailable.result.error?.tag, "ModelUnavailable");
  const credentials = await runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "error", error: { tag: "CredentialsRequired", message: "No credentials" } }),
  }));
  assert.equal(credentials.result.error?.tag, "CredentialsRequired");
  const fallback = await runner.run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "ok", model: { ...testClassifierModel, provider: "openrouter" } }),
  }));
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
    const scan = await createFileClassifier().run(root, testRequest(), testRuntime({
      classify: async (_model, context) => mutate(testClassifierResponse(context)),
    }));
    assert.equal(scan.result.status, "partial");
    assert.equal(scan.result.summary.failed, 1);
    assert.equal(scan.result.summary.classified, 0);
    assert.equal(JSON.stringify(scan).includes("SECRET_SOURCE"), false);
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("provider aborts are explicit cancelled outcomes, not fabricated answers", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const scan = await createFileClassifier().run(root, testRequest(), testRuntime({
    classify: async (_model, context) => ({ ...testClassifierResponse(context), stopReason: "aborted" }),
  }));
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
    const scan = await createFileClassifier().run(root, request, testRuntime({
      classify: async (_model, context) => {
        const response = testClassifierResponse(context);
        return { ...response, answers: { ...response.answers, ...answers } };
      },
    }));
    assert.equal(scan.result.files[0]?.status, "failed");
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("finite fractional scores remain valid within caller criteria", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const request = testRequest();
  request.questions.risk = { type: "score", instructions: "Rate risk.", criteria: ["Low", "High"] };
  const scan = await createFileClassifier().run(root, request, testRuntime({
    classify: async (_model, context) => ({ ...testClassifierResponse(context),
      answers: { relevant: { type: "bool", probability: 0 }, risk: { type: "score", score: 0.5, confidence: 1 } } }),
  }));
  assert.equal(scan.result.summary.classified, 1);
  assert.ok(hasValidCoverage(scan.result));
});

test("skips estimated context overflow without truncating source or questions", async t => {
  const root = await createTestProject(t, { "src/example.ts": "x".repeat(63_000) });
  const scan = await createFileClassifier().run(root, testRequest(), testRuntime());
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
  const scan = await createFileClassifier().run(root, testRequest(["a.ts", "b.ts", "c.ts"]), testRuntime({
    classify: async (_model, context) => {
      const response = testClassifierResponse(context);
      if (context.state.path === "c.ts") return response;
      return { ...response, usage: reportedUsage,
        ...(context.state.path === "b.ts" ? { stopReason: "error", errorMessage: "Billed error" } : {}) };
    },
  }));
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
    const scan = await createFileClassifier().run(root, testRequest(), testRuntime({
      classify: async (_model, context) => ({ ...testClassifierResponse(context), ...(usage ? { usage } : {}) }),
    }));
    assert.equal(scan.result.status, "complete");
    assert.equal(scan.result.summary.usageReports, usage === zero ? 1 : 0);
    assert.equal(scan.result.summary.usageAvailability, usage === zero ? "complete" : "none");
    assert.equal(scan.result.summary.usage.costUsd, null);
    assert.equal(scan.usage !== undefined, usage === zero);
    assert.ok(hasValidCoverage(scan.result));
  }
  const priced = await createFileClassifier().run(root, testRequest(), testRuntime({
    resolveModel: async () => ({ status: "ok", model: { ...testClassifierModel,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }),
    classify: async (_model, context) => ({ ...testClassifierResponse(context), usage: reportedUsage }),
  }));
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
  const cancelled = await runner.run(root, testRequest(paths), runtime, controller.signal);
  assert.equal(cancelled.result.error?.tag, "Cancelled");
  assert.equal(cancelled.result.summary.requests, 4);
  assert.ok(hasValidCoverage(cancelled.result));
  for (const request of pending) request.resolve(testClassifierResponse(request.context));
  const followup = await runner.run(root, testRequest(paths), testRuntime());
  assert.equal(followup.result.summary.classified, paths.length);
  assert.ok(hasValidCoverage(followup.result));
});

test("shares a four-request concurrency budget across concurrent scans", async t => {
  const paths = Array.from({ length: 12 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  let active = 0;
  let maximum = 0;
  const runtime = testRuntime({
    classify: async (_model, context) => {
      active++; maximum = Math.max(maximum, active);
      await delay(5); active--;
      return testClassifierResponse(context);
    },
  });
  const runner = createFileClassifier();
  const scans = await Promise.all([runner.run(root, testRequest(paths), runtime), runner.run(root, testRequest(paths), runtime)]);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  for (const scan of scans) {
    assert.equal(scan.result.summary.classified, 12);
    assert.ok(hasValidCoverage(scan.result));
  }
});

test("rejects a third active scan and accounts for all files on cancellation", async t => {
  const paths = Array.from({ length: 12 }, (_, index) => "f" + index + ".ts");
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, "example"])));
  let started = 0;
  const runtime = testRuntime({
    classify: async () => { started++; return new Promise<ClassifierResult>(() => {}); },
  });
  const runner = createFileClassifier({ scanDeadlineMs: 1000, requestDeadlineMs: 1000 });
  const controller = new AbortController();
  const first = runner.run(root, testRequest(paths), runtime, controller.signal);
  const second = runner.run(root, testRequest(paths), runtime, controller.signal);
  const third = await runner.run(root, testRequest(paths), runtime);
  assert.equal(third.result.error?.tag, "ScanBusy");
  while (started < 4) await delay(2);
  controller.abort();
  for (const scan of await Promise.all([first, second])) {
    assert.equal(scan.result.error?.tag, "Cancelled");
    assert.ok(hasValidCoverage(scan.result));
    assert.equal(scan.result.summary.classified, 0);
  }
  assert.equal(started, 4);
  // An ignored abort cannot free a permit and start more provider requests.
  const retained = await runner.run(root, testRequest(paths), runtime);
  assert.equal(retained.result.error?.tag, "Deadline");
  assert.equal(retained.result.summary.requests, 0);
  assert.equal(started, 4);
  assert.ok(hasValidCoverage(retained.result));
});

test("request deadlines finish even if the provider ignores AbortSignal", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const scan = await createFileClassifier({ scanDeadlineMs: 1000, requestDeadlineMs: 20 }).run(root, testRequest(), testRuntime({
    classify: async () => new Promise<ClassifierResult>(() => {}),
  }));
  const file = scan.result.files[0];
  assert.ok(file && file.status === "failed");
  assert.equal(file.reason, "deadline");
  assert.ok(scan.result.summary.elapsedMs < 1000);
  assert.ok(hasValidCoverage(scan.result));
});

test("scan duration uses the supplied clock capability", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  let now = 100;
  const runner = createFileClassifier(undefined, { now: () => now });
  const scan = await runner.run(root, testRequest(), testRuntime({
    classify: async (_model, context) => { now = 125; return testClassifierResponse(context); },
  }));
  assert.equal(scan.result.summary.elapsedMs, 25);
  assert.equal(scan.result.status, "complete");
});

test("pre-aborted calls do not submit source or resolve credentials", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const signal = AbortSignal.abort();
  const scan = await createFileClassifier().run(root, testRequest(), testRuntime({
    resolveModel: async () => { throw new Error("Already cancelled"); },
  }), signal);
  assert.equal(scan.result.error?.tag, "Cancelled");
  assert.equal(scan.result.summary.requests, 0);
});
