import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTestProject, testRequest } from "./test-fixtures.ts";

const execute = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const packageManifestSchema = Type.Object({
  name: Type.Literal("pi-jfiles"),
  type: Type.Literal("module"),
  license: Type.Literal("MIT"),
  private: Type.Optional(Type.Boolean()),
  pi: Type.Object({ extensions: Type.Array(Type.String()) }),
});

test("npm archive installs in isolated Pi and preserves one tool, local preview, and consent refusal", { timeout: 60_000 }, async t => {
  const archiveDir = await createTestProject(t, {});
  const root = await createTestProject(t, { "src/example.ts": "SYNTHETIC_PACKAGE_SOURCE_DO_NOT_RETURN" });
  const agentDir = await createTestProject(t, {});

  const packed = await execute("npm", ["pack", "--ignore-scripts", "--pack-destination", archiveDir], {
    cwd: repositoryRoot, timeout: 30_000,
  });

  const archiveName = packed.stdout.trim();
  assert.match(archiveName, /^pi-jfiles-[A-Za-z0-9.+-]+\.tgz$/u);
  const archivePath = join(archiveDir, archiveName);
  const listed = await execute("tar", ["-tzf", archivePath]);
  const packedPaths = listed.stdout.trim().split("\n").filter(path => !path.endsWith("/"));
  assert.ok(packedPaths.every(path => path.startsWith("package/") && !path.includes("../")));
  await execute("tar", ["-xzf", archivePath, "-C", archiveDir]);
  const unpackedRoot = join(archiveDir, "package");
  const manifest: unknown = JSON.parse(await readFile(join(unpackedRoot, "package.json"), "utf8"));
  assert.ok(Check(packageManifestSchema, manifest));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.notEqual(manifest.private, true);
  assert.deepEqual(packedPaths.sort(), [
    "package/src/index.ts",
    "package/src/file-classification-contract.ts",
    "package/src/file-classification.ts",
    "package/src/file-selection.ts",
    "package/package.json",
    "package/README.md",
    "package/CONTEXT.md",
    "package/docs/architecture.md",
    "package/docs/security.md",
    "package/docs/development.md",
    "package/LICENSE",
  ].sort());

  // Install the real archive and its runtime dependencies from the local npm cache.
  // Pi does not install dependencies for local directory packages.
  const installDir = await createTestProject(t, {});
  await writeFile(join(installDir, "package.json"), JSON.stringify({
    private: true, dependencies: { "pi-jfiles": "file:" + archivePath },
  }));
  await execute("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: installDir, timeout: 30_000,
  });
  const packageRoot = join(installDir, "node_modules", "pi-jfiles");

  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultTools: ["codemode"], enableInstallTelemetry: false, enableAnalytics: false,
  }));
  const cliPath = join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

  const cliOptions = {
    cwd: root, timeout: 30_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
  };

  await execute(process.execPath, [cliPath, "install", packageRoot], cliOptions);
  const settingsManager = SettingsManager.create(root, agentDir);
  assert.deepEqual(settingsManager.getPackages(), [relative(agentDir, packageRoot)]);

  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ mode: "on" })],
  });

  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.flatMap(extension => [...extension.tools.keys()])
    .filter(name => name === "classify_files").length, 1);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });

  const chatModel = modelRuntime.getModel("openai", "gpt-4o");
  assert.ok(chatModel);
  const sessionManager = SessionManager.inMemory(root);
  sessionManager.appendMessage({
    role: "assistant", api: chatModel.api, provider: chatModel.provider, model: chatModel.id,
    content: [{ type: "toolCall", id: "package-smoke", name: "codemode", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 0,
  });

  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: chatModel, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager,
  });

  t.after(() => session.dispose());
  await session.bindExtensions({});
  assert.deepEqual(session.getActiveToolNames(), ["codemode"]);
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  assert.ok(codemode);

  const result = await codemode.execute("package-smoke", { code: `
    const matches = await searchTools("classify_files");
    if (matches.filter(tool => tool.name === "classify_files").length !== 1) throw new Error("Expected one tool");
    const preview = await tools.classify_files({ mode: "preview", selection: { kind: "paths", paths: ["src/example.ts"] } });
    if (preview.status !== "preview" || preview.summary.previewed !== 1 || preview.summary.requests !== 0) throw new Error("Invalid preview");
    const refused = await tools.classify_files(${JSON.stringify(testRequest(["src/example.ts"]))});
    if (refused.error?.tag !== "ConsentRequired" || refused.summary.requests !== 0 || refused.summary.bytesSubmitted !== 0) throw new Error("Consent bypass");
    text({ previewed: preview.summary.previewed, consent: refused.error.tag, requests: refused.summary.requests });
  ` });

  const resultText = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.match(resultText, /"previewed":1/u);
  assert.match(resultText, /"consent":"ConsentRequired"/u);
  assert.match(resultText, /"requests":0/u);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PACKAGE_SOURCE_DO_NOT_RETURN/u);
  await execute(process.execPath, [cliPath, "remove", packageRoot], cliOptions);
  assert.deepEqual(SettingsManager.create(root, agentDir).getPackages(), []);
});
