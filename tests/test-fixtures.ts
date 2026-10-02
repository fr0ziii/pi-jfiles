import type { TestContext } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { fileClassificationOutputSchema, type FileClassificationRequest, type FileClassificationOutput } from "../src/file-classification-contract.ts";
import type { FileClassifierRuntime } from "../src/file-classification.ts";

/** Temporary project fixture; every file is synthetic and is removed after the test. */
export async function createTestProject(t: TestContext, files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-jev-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  return root;
}

/** Synthetic classifier descriptor; tests never use a live provider. */
export const testClassifierModel: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier", provider: "typesafe", id: "jev-latest", name: "Jev test fixture",
  api: "typesafe-system-one", baseUrl: "https://unused.invalid", input: ["text"], contextWindow: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A dynamic request shared only by tests. */
export function testRequest(paths = ["src/example.ts"]): FileClassificationRequest {
  return {
    selection: { kind: "paths", paths },
    questions: { relevant: { type: "bool", instructions: "Does the source calculate prorated charges?",
      criteria: { true: "Calculates prorated charges", false: "Does not calculate prorated charges" } } },
  };
}

/** Deterministic multi-question test responses; not a production classifier mock. */
export function testClassifierResponse(context: ClassifierContext): ClassifierResult {
  return {
    api: testClassifierModel.api, provider: testClassifierModel.provider, model: testClassifierModel.id,
    stopReason: "stop", timestamp: 0,
    answers: Object.fromEntries(Object.entries(context.questions).map(([key, question]) => {
      switch (question.type) {
        case "bool": return [key, { type: "bool", probability: 0.9 }];
        case "choice": {
          const labels = Object.keys(question.criteria);

          return [key, { type: "choice", choice: labels[0] ?? "missing",
            probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 1 : 0])), confidence: 1 }];
        }

        case "score": return [key, { type: "score", score: question.criteria.length - 1, confidence: 0.8 }];
      }
    })),
  };
}

/** Source-free fake runtime; callers can replace individual boundary behaviors. */
export function testRuntime(overrides: Partial<FileClassifierRuntime> = {}): FileClassifierRuntime {
  return {
    allowRemote: true,
    resolveModel: async () => ({ status: "ok", model: testClassifierModel }),
    classify: async (_model, context) => testClassifierResponse(context),
    ...overrides,
  };
}

/** Assert the actual schema and the coverage invariant at the returned tool boundary. */
export function hasValidCoverage(result: FileClassificationOutput): boolean {
  return Check(fileClassificationOutputSchema, result) &&
    result.summary.selected === result.files.length &&
    result.summary.selected === result.summary.classified + result.summary.previewed +
      result.summary.skipped + result.summary.failed + result.summary.unprocessed;
}
