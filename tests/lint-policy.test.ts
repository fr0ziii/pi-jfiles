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

test("root Oxlint policy accepts typed values and rejects unsafe syntax", async t => {
  const root = await createTestProject(t, {
    "accepted.ts": 'export const answer = { type: "bool", probability: 0.9 } as const;\n',
    "explicit-any.ts": "export function unsafe(value: any) { return value; }\n",
    "non-null.ts": "export function unsafe(value?: string) { return value!.length; }\n",
    "assertion.ts": "export function unsafe(value: unknown) { return value as string; }\n",
  });

  const lint = (path: string) => execute(join(repositoryRoot, "node_modules", ".bin", "oxlint"), [
    "--config", join(repositoryRoot, ".oxlintrc.json"), "--deny-warnings",
    "--report-unused-disable-directives", join(root, path),
  ], { cwd: repositoryRoot });

  await lint("accepted.ts");

  for (const [path, rule] of [
    ["explicit-any.ts", "no-explicit-any"],
    ["non-null.ts", "no-non-null-assertion"],
    ["assertion.ts", "consistent-type-assertions"],
  ] as const) {
    await assert.rejects(lint(path), error => {
      if (!(error instanceof Error) || !Check(lintFailureSchema, error)) return false;

      return error.stdout.includes(rule);
    });
  }
});
