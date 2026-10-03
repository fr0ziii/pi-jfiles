import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScanInput } from "../src/file-classification-contract.ts";
import { testScanInput } from "./test-fixtures.ts";

test("dynamic map labels stay constrained when their declarations expose values", () => {
  const question = testScanInput().questions.relevant;
  assert.ok(question);

  for (const key of ["1bad", "__proto__", "prototype", "constructor", "x".repeat(65)]) {
    assert.equal(parseScanInput({ ...testScanInput(), questions: Object.fromEntries([[key, question]]) }).status, "error", key);

    const choice = { type: "choice", instructions: "Which role?",
      criteria: Object.fromEntries([["valid", "First role"], [key, "Second role"]]) };

    assert.equal(parseScanInput({ ...testScanInput(), questions: { role: choice } }).status, "error", key);
  }
});

test("rejects empty questions and incomplete question criteria", () => {
  const input = testScanInput();

  const invalid: unknown[] = [
    { ...input, questions: {} },
    { ...input, questions: { wrong: { type: "bool", instructions: "?", criteria: { true: "yes" } } } },
    { ...input, questions: { wrong: { type: "choice", instructions: "?", criteria: { only: "one" } } } },
    { ...input, questions: { wrong: { type: "score", instructions: "?", criteria: [] } } },
  ];

  for (const value of invalid) assert.equal(parseScanInput(value).status, "error");
});

test("rejects absolute paths, traversal, controls, and unsupported glob syntax", () => {
  for (const path of ["/tmp/a.ts", "src/../a.ts", "./a.ts", "a//b.ts", "C:/a.ts", "a\\b.ts", "a\nb.ts", "a\0b.ts"]) {
    assert.equal(parseScanInput(testScanInput([path])).status, "error", path);
  }

  for (const glob of ["src/{a,b}.ts", "src/!(a).ts", "../**/*.ts"]) {
    const input = { ...testScanInput(), selection: { kind: "globs", include: [glob] } };
    assert.equal(parseScanInput(input).status, "error", glob);
  }
});

test("caps question payload bytes, not only question count", () => {
  const input = testScanInput();
  input.questions.large = { type: "choice", instructions: "Classify",
    criteria: Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["label" + index, "x".repeat(1000)])) };
  assert.equal(parseScanInput(input).status, "error");
});
