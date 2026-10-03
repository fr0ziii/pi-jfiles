import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createTestProject } from "./test-fixtures.ts";

const execute = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const lintFailureSchema = Type.Object({ stdout: Type.String() });

test("root anti-slop configuration loads generic and all optional Effect rules", async t => {
  const root = await createTestProject(t, {
    "accepted.ts": [
      'import { Data, Match, Predicate } from "effect";',
      "",
      'const Ready = Data.tagged<{ readonly _tag: "Ready"; readonly value: number }>("Ready");',
      "",
      "export const ready = Ready({ value: 1 });",
      "",
      'export const isReady = Predicate.isTagged("Ready");',
      "",
      'export function labelResult(kind: "a" | "b" | "other") {',
      '  return Match.value(kind).pipe(Match.when("a", () => "A"), Match.when("b", () => "B"), Match.orElse(() => "Other"));',
      "}",
      "",
    ].join("\n"),
    "module-mocking.ts": 'vi.mock("./dependency.ts");\n',
    "reflect-get.ts": 'export const result = Reflect.get({ value: 1 }, "value");\n',
    "empty-spread.ts": 'export const result = { ...(enabled ? { value: 1 } : {}) };\n',
    "runtime-typeof.ts": 'export function isText(value: string | number) {\n  return typeof value === "string";\n}\n',
    "unknown-parameter.ts": 'export function forward(value: unknown) {\n  return value;\n}\n',
    "spacing.ts": 'export function increment(value: number) {\n  const next = value + 1;\n  return next;\n}\n',
    "error-tag.ts": 'export const recover = Effect.catch((error) => error._tag === "Missing" ? Effect.void : Effect.fail(error));\n',
    "tag-comparison.ts": 'export function isReady(result: { readonly _tag: "Ready" }) {\n  return result._tag === "Ready";\n}\n',
    "tag-construction.ts": 'export const result = { _tag: "Ready", value: 1 };\n',
    "constructor-import.ts": 'import { makeDemo } from "./demo.ts";\n\nexport const demo = makeDemo();\n',
    "manual-match.ts": 'export function labelResult(kind: "a" | "b" | "other") {\n  return kind === "a" ? "A" : kind === "b" ? "B" : "Other";\n}\n',
  });

  const lint = (path: string) => execute(join(repositoryRoot, "node_modules", ".bin", "oxlint"), [
    "--config", join(repositoryRoot, ".oxlintrc.json"), "--deny-warnings",
    "--report-unused-disable-directives", join(root, path),
  ], { cwd: repositoryRoot });

  await lint("accepted.ts");

  for (const [path, rule] of [
    ["module-mocking.ts", "no-module-mocking"],
    ["reflect-get.ts", "no-reflect-get"],
    ["empty-spread.ts", "no-conditional-empty-object-spread"],
    ["runtime-typeof.ts", "no-runtime-typeof"],
    ["unknown-parameter.ts", "no-unknown-parameters"],
    ["spacing.ts", "require-readable-spacing"],
    ["error-tag.ts", "no-manual-effect-error-tag"],
    ["tag-comparison.ts", "no-manual-tag-comparison"],
    ["tag-construction.ts", "no-manual-tagged-construction"],
    ["constructor-import.ts", "no-service-constructor-imports"],
    ["manual-match.ts", "prefer-effect-match"],
  ] as const) {
    await assert.rejects(lint(path), cause => {
      if (!Check(lintFailureSchema, cause)) return false;

      return cause.stdout.includes(rule);
    });
  }
});
