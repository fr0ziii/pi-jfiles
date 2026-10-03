import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFileClassificationInput } from "../src/file-classification-contract.ts";
import { testRequest } from "./test-fixtures.ts";

test("dynamic map labels stay constrained when their declarations expose values", () => {
  const question = testRequest().questions.relevant;
  assert.ok(question);

  for (const key of ["1bad", "__proto__", "prototype", "constructor", "x".repeat(65)]) {
    assert.equal(parseFileClassificationInput({ ...testRequest(), questions: Object.fromEntries([[key, question]]) }).status, "error", key);

    const choice = { type: "choice", instructions: "Which role?",
      criteria: Object.fromEntries([["valid", "First role"], [key, "Second role"]]) };

    assert.equal(parseFileClassificationInput({ ...testRequest(), questions: { role: choice } }).status, "error", key);
  }
});

test("rejects empty questions and incomplete question criteria", () => {
  const request = testRequest();

  const invalid: unknown[] = [
    { ...request, questions: {} },
    { ...request, questions: { wrong: { type: "bool", instructions: "?", criteria: { true: "yes" } } } },
    { ...request, questions: { wrong: { type: "choice", instructions: "?", criteria: { only: "one" } } } },
    { ...request, questions: { wrong: { type: "score", instructions: "?", criteria: [] } } },
  ];

  for (const value of invalid) assert.equal(parseFileClassificationInput(value).status, "error");
});

test("rejects absolute paths, traversal, controls, and unsupported glob syntax", () => {
  for (const path of ["/tmp/a.ts", "src/../a.ts", "./a.ts", "a//b.ts", "C:/a.ts", "a\\b.ts", "a\nb.ts", "a\0b.ts"]) {
    assert.equal(parseFileClassificationInput(testRequest([path])).status, "error", path);
  }

  for (const glob of ["src/{a,b}.ts", "src/!(a).ts", "../**/*.ts"]) {
    const request = { ...testRequest(), selection: { kind: "globs", include: [glob] } };
    assert.equal(parseFileClassificationInput(request).status, "error", glob);
  }
});

test("caps question payload bytes, not only question count", () => {
  const request = testRequest();
  request.questions.large = { type: "choice", instructions: "Classify",
    criteria: Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["label" + index, "x".repeat(1000)])) };
  assert.equal(parseFileClassificationInput(request).status, "error");
});
