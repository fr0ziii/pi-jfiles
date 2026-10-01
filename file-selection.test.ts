import assert from "node:assert/strict";
import { test } from "node:test";
import { rename, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readSelectedSource, selectSourceFiles } from "./file-selection.ts";
import { createFileClassifier } from "./file-classification.ts";
import { createTestProject, hasValidCoverage, testRequest, testRuntime } from "./test-fixtures.ts";

test("recursive globs preserve ignore rules, excludes, and hidden source files", async t => {
  const root = await createTestProject(t, {
    ".gitignore": "ignored.ts\n", "ignored.ts": "ignored", "src/a.ts": "first",
    "src/deep/b.ts": "second", "src/deep/no.ts": "excluded", "src/.hidden.ts": "hidden",
    "node_modules/dependency.ts": "dependency", "dist/generated.ts": "generated",
  });
  const scan = await createFileClassifier().run(root, {
    mode: "preview",
    selection: { kind: "globs", include: ["**/*.ts", "**/.*.ts"], exclude: ["**/no.ts"] },
  }, testRuntime({ allowRemote: false, resolveModel: async () => { throw new Error("Must not resolve in preview"); } }));
  assert.equal(scan.result.status, "preview");
  assert.deepEqual(scan.result.files.map(file => file.path), ["src/.hidden.ts", "src/a.ts", "src/deep/b.ts"]);
  assert.equal(scan.result.summary.bytesSubmitted, 0);
  assert.ok(hasValidCoverage(scan.result));
});

test("token, OAuth, and session implementation paths stay eligible, while credential data stays excluded", async t => {
  const allowed = [
    "src/styles/tokens.css", "src/styles/design-tokens.scss", "src/lib/tokens.ts",
    "src/lib/credentials.ts", "src/lib/secrets.ts", "src/pages/oauth/callback.ts",
    "src/oauth/token.ts", "src/sessions/store.ts", "src/auth/login.ts",
    "src/.pi/agent/extensions/helper/bin/tokens.ts",
  ];
  const denied = [
    ".env", ".env.local", ".env.ts", "auth.json", "AUTH.JSON", "credentials", "credentials.toml",
    "config/.tokens", "config/.secrets", "config/.credentials",
    "config/secrets.json", "config/access-tokens.json", "config/credentials.yaml", "config/secrets.yml",
    ...["jsonc", "ini", "cfg", "conf", "txt", "csv", "xml", "properties", "log", "bak"].map(extension => "config/credentials." + extension),
    ".ssh/id_ed25519", ".aws/credentials", "keys/private.pem", "keys/private.KEY",
    ".pi/agent/sessions/history.jsonl", ".pi/agent/oauth/state.json", ".pi/agent/npm/a.ts",
    ".pi/agent/bin/a.ts", ".pi/agent/logs/a.ts", "nested/.pi/sessions/history.jsonl",
    "node_modules/package/tokens.ts", "dist/tokens.css", ".DS_Store", "herdr-agent-state.ts",
  ];
  const root = await createTestProject(t, Object.fromEntries([...allowed, ...denied].map(path => [path, "SYNTHETIC"])));
  const runner = createFileClassifier();
  const exact = await runner.run(root, {
    mode: "preview", selection: { kind: "paths", paths: [...allowed, ...denied] },
  }, testRuntime({ allowRemote: false }));
  assert.deepEqual(exact.result.files.filter(file => file.status === "preview").map(file => file.path).sort(), [...allowed].sort());
  assert.equal(exact.result.summary.skipped, denied.length);
  assert.ok(exact.result.files.every(file => file.status === "preview" || (file.status === "skipped" && file.reason === "excluded")));
  assert.ok(hasValidCoverage(exact.result));
  const globs = await runner.run(root, {
    mode: "preview", selection: { kind: "globs", include: ["**/*", "**/.*"] },
  }, testRuntime({ allowRemote: false }));
  assert.deepEqual(globs.result.files.filter(file => file.status === "preview").map(file => file.path).sort(),
    allowed.filter(path => !path.includes("/.pi/")).sort());
  assert.ok(hasValidCoverage(globs.result));

  const submitted: string[] = [];
  const scan = await runner.run(root, testRequest([...allowed, ...denied]), testRuntime({
    classify: async (_model, context) => {
      submitted.push(String(context.state.path));
      return { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
        stopReason: "stop", answers: { relevant: { type: "bool", probability: 1 } } };
    },
  }));
  assert.deepEqual(submitted.sort(), [...allowed].sort());
  assert.ok(hasValidCoverage(scan.result));
});

test("metadata preview does not decode source or resolve the classifier", async t => {
  const root = await createTestProject(t, { "binary.ts": Buffer.from([0, 255]), "invalid.ts": Buffer.from([0xc3, 0x28]) });
  const scan = await createFileClassifier().run(root, {
    mode: "preview", selection: { kind: "paths", paths: ["binary.ts", "invalid.ts"] },
  }, testRuntime({
    allowRemote: false,
    resolveModel: async () => { throw new Error("Preview must not inspect credentials"); },
    classify: async () => { throw new Error("Preview must not submit content"); },
  }));
  assert.equal(scan.result.status, "preview");
  assert.equal(scan.result.summary.previewed, 2);
  assert.equal(scan.result.summary.requests, 0);
  assert.equal(scan.result.summary.bytesSubmitted, 0);
  assert.ok(scan.result.files.every(file => file.status === "preview" && !("digest" in file) && !("answers" in file)));
  assert.ok(hasValidCoverage(scan.result));
});

test("exact paths cannot read ignored source, dependencies, or common credentials", async t => {
  const root = await createTestProject(t, {
    ".gitignore": "ignored.ts\n", "ignored.ts": "ignored", "src/example.ts": "safe",
    ".env": "password", "auth.json": "secret", "key.pem": "secret",
    "node_modules/a.ts": "dependency", "config/secrets.json": "secret",
  });
  const paths = ["ignored.ts", "src/example.ts", ".env", "auth.json", "key.pem", "node_modules/a.ts", "config/secrets.json", "missing.ts"];
  const submitted: string[] = [];
  const scan = await createFileClassifier().run(root, testRequest(paths), testRuntime({
    classify: async (_model, context) => {
      submitted.push(String(context.state.path));
      return { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
        stopReason: "stop", answers: { relevant: { type: "bool", probability: 1 } } };
    },
  }));
  assert.deepEqual(submitted, ["src/example.ts"]);
  assert.equal(scan.result.status, "partial");
  assert.ok(hasValidCoverage(scan.result));
});

test("symlink files and parents never submit external source", async t => {
  const root = await createTestProject(t, { "src/example.ts": "safe" });
  const external = await createTestProject(t, { "secret.ts": "DO_NOT_SUBMIT" });
  await symlink(join(external, "secret.ts"), join(root, "link.ts"));
  await symlink(external, join(root, "linked"));
  const scan = await createFileClassifier().run(root, testRequest(["link.ts", "linked/secret.ts"]), testRuntime({
    classify: async () => { throw new Error("Must not upload symlink targets"); },
  }));
  assert.equal(scan.result.summary.requests, 0);
  assert.equal(scan.result.summary.classified, 0);
  assert.ok(hasValidCoverage(scan.result));
});

test("a snapshot from a different project cannot cross the read root", async t => {
  const root = await createTestProject(t, { "src/example.ts": "local" });
  const external = await createTestProject(t, { "src/example.ts": "external" });
  const signal = new AbortController().signal;
  const selection = await selectSourceFiles(external, testRequest().selection, signal);
  assert.ok(selection.status === "ok");
  const file = selection.candidates[0];
  assert.ok(file);
  const source = await readSelectedSource(root, file, signal);
  assert.equal(source.status, "error");
});

test("skips oversized, binary, and invalid UTF-8 files without truncation", async t => {
  const root = await createTestProject(t, {
    "large.ts": "x".repeat(65_537), "binary.ts": Buffer.from([0, 1]),
    "invalid.ts": Buffer.from([0xc3, 0x28]), "empty.ts": "",
  });
  const scan = await createFileClassifier().run(root, testRequest(["large.ts", "binary.ts", "invalid.ts", "empty.ts"]), testRuntime());
  assert.equal(scan.result.summary.requests, 1);
  assert.equal(scan.result.summary.classified, 1);
  assert.equal(scan.result.summary.skipped, 3);
  assert.ok(hasValidCoverage(scan.result));
});

test("detects mutation and symlink replacement after preflight", async t => {
  const root = await createTestProject(t, { "src/example.ts": "original" });
  const input = testRequest();
  const selection = await selectSourceFiles(root, input.selection, new AbortController().signal);
  assert.equal(selection.status, "ok");
  if (selection.status !== "ok") return;
  const file = selection.candidates[0];
  assert.ok(file);
  await writeFile(join(root, file.path), "changed");
  const changed = await readSelectedSource(selection.root, file, new AbortController().signal);
  assert.equal(changed.status, "error");
  await rename(join(root, file.path), join(root, "original.ts"));
  await symlink(join(root, "original.ts"), join(root, file.path));
  const replacement = await readSelectedSource(selection.root, file, new AbortController().signal);
  assert.equal(replacement.status, "error");
});

test("preserves Unicode paths, literal glob characters, and UTF-8 BOM source", async t => {
  const source = "\uFEFFconst marker = true;";
  const paths = ["src/[entry].ts", "src/café.ts", "\uFEFFbom.ts"];
  const root = await createTestProject(t, Object.fromEntries(paths.map(path => [path, source])));
  const submitted: string[] = [];
  const scan = await createFileClassifier().run(root, testRequest(paths), testRuntime({
    classify: async (_model, context) => {
      assert.equal(context.state.content, source);
      submitted.push(String(context.state.path));
      return { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0,
        stopReason: "stop", answers: { relevant: { type: "bool", probability: 1 } } };
    },
  }));
  assert.deepEqual(submitted.sort(), paths.sort());
  assert.equal(scan.result.status, "complete");
  for (const file of scan.result.files) {
    assert.ok(file.status === "classified");
    assert.equal(file.bytes, Buffer.byteLength(source));
    assert.equal(file.digest, createHash("sha256").update(source).digest("hex"));
  }
  assert.ok(hasValidCoverage(scan.result));
});

test("empty glob matches have complete zero coverage without classifier calls", async t => {
  const root = await createTestProject(t, { "src/example.ts": "example" });
  const scan = await createFileClassifier().run(root, {
    ...testRequest(), selection: { kind: "globs", include: ["nothing/**/*.ts"] },
  }, testRuntime({ classify: async () => { throw new Error("No files to submit"); } }));
  assert.equal(scan.result.status, "complete");
  assert.equal(scan.result.summary.selected, 0);
  assert.equal(scan.result.summary.requests, 0);
  assert.ok(hasValidCoverage(scan.result));
});

test("discovery rejects invalid UTF-8 paths before upload", async t => {
  const root = await createTestProject(t, {});
  const invalidPath = Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff]), Buffer.from(".ts")]);
  try { await writeFile(invalidPath, "SYNTHETIC_SOURCE"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EILSEQ") {
      t.skip("The filesystem rejects non-UTF-8 paths before discovery.");
      return;
    }
    throw error;
  }
  const scan = await createFileClassifier().run(root, {
    ...testRequest(), selection: { kind: "globs", include: ["**/*.ts"] },
  }, testRuntime({ classify: async () => { throw new Error("Invalid discovery must not upload"); } }));
  assert.equal(scan.result.error?.tag, "DiscoveryFailed");
  assert.match(scan.result.error?.message ?? "", /non-UTF-8 path/u);
  assert.equal(scan.result.summary.requests, 0);
  assert.ok(hasValidCoverage(scan.result));
});

test("rejects file and aggregate budgets before any upload", async t => {
  const root = await createTestProject(t, Object.fromEntries(
    Array.from({ length: 201 }, (_, index) => ["f" + index + ".ts", index < 90 ? "x".repeat(63_000) : "tiny"])));
  const runtime = testRuntime({ classify: async () => { throw new Error("Must not classify over-budget selection"); } });
  const runner = createFileClassifier();
  const files = await runner.run(root, {
    ...testRequest(), selection: { kind: "globs", include: ["*.ts"] },
  }, runtime);
  assert.equal(files.result.error?.tag, "ScanLimit");
  const bytes = await runner.run(root, testRequest(Array.from({ length: 90 }, (_, index) => "f" + index + ".ts")), runtime);
  assert.equal(bytes.result.error?.tag, "ScanLimit");
  assert.equal(bytes.result.summary.requests, 0);
});
