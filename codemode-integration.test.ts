import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import ts from "typescript";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import registerJevFiles from "./index.ts";
import { createTestProject, testClassifierModel, testClassifierResponse, testRequest } from "./test-fixtures.ts";

const wireQuestionSchema = Type.Union([
  Type.Object({ type: Type.Literal("noul"), instructions: Type.String(), criteria: Type.Object({ true: Type.String(), false: Type.String() }) }),
  Type.Object({ type: Type.Literal("choice"), instructions: Type.String(), criteria: Type.Record(Type.String(), Type.String()) }),
  Type.Object({ type: Type.Literal("score"), instructions: Type.String(), criteria: Type.Array(Type.String()) }),
]);
const wireRequestSchema = Type.Object({
  model: Type.Literal("jev-latest"),
  state: Type.Object({ path: Type.String(), content: Type.String(), sourceKind: Type.Literal("untrusted-project-file") }),
  questions: Type.Record(Type.String(), wireQuestionSchema),
});

test("actual Pi codemode receives structured results, filters, stores, follows up, and accounts for nested usage", async t => {
  const root = await createTestProject(t, { "src/example.ts": "SYNTHETIC_SOURCE_NOT_FOR_MAIN_CONTEXT", "src/other.ts": "other" });
  const agentDir = await createTestProject(t, {});
  const usage: Usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let classifierCalls = 0;
  const serverErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/systemone");
      assert.equal(request.headers.authorization, "Bearer synthetic-test-credential");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(Check(wireRequestSchema, body));
      if (!Check(wireRequestSchema, body)) throw new Error("Invalid synthetic wire request");
      classifierCalls++;
      const questions = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
        question.type === "noul" ? { ...question, type: "bool" as const } : question,
      ]));
      const result = testClassifierResponse({ state: body.state, questions });
      const answers = Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key,
        answer.type === "bool" ? { type: "noul", noul: answer.probability } : answer,
      ]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers, usage: { input_tokens: 4, output_tokens: 1 } }));
    } catch (error) {
      serverErrors.push(error instanceof Error ? error.message : "Local fixture failure");
      response.writeHead(500); response.end("Synthetic fixture failure");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const fixtureUrl = "http://127.0.0.1:" + address.port;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("typesafe", "synthetic-test-credential");
  modelRuntime.registerProvider("typesafe", {
    baseUrl: fixtureUrl, models: [{ ...testClassifierModel, baseUrl: fixtureUrl }],
  });
  const observed: { name: string; parent: string | undefined; usage: Usage | undefined; sourceLeaked: boolean }[] = [];
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["codemode"] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      registerJevFiles, createCodemodeExtension({ mode: "on" }),
      pi => { pi.on("tool_result", event => {
        if (event.toolName === "classify_files") observed.push({
          name: event.toolName, parent: event.parentToolCallId, usage: event.usage,
          sourceLeaked: JSON.stringify(event).includes("SYNTHETIC_SOURCE_NOT_FOR_MAIN_CONTEXT"),
        });
      }); },
    ],
  });
  await resourceLoader.reload();
  resourceLoader.getExtensions().runtime.flagValues.set("jev-files-allow-remote", true);
  const chatModel = modelRuntime.getModel("openai", "gpt-4o");
  assert.ok(chatModel);
  const sessionManager = SessionManager.inMemory(root);
  sessionManager.appendMessage({
    role: "assistant", api: chatModel.api, provider: chatModel.provider, model: chatModel.id,
    content: [{ type: "toolCall", id: "scan-integration", name: "codemode", arguments: {} }],
    usage, stopReason: "toolUse", timestamp: 0,
  });
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: chatModel, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager,
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  assert.deepEqual(session.getActiveToolNames(), ["codemode"]);
  assert.equal(resourceLoader.getExtensions().errors.length, 0);
  const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
  assert.ok(codemode);
  assert.match(codemode.description, /classify_files/u);
  const declarationResult = await codemode.execute("declaration-integration", { code: `
    const matches = await searchTools("classify_files");
    if (!JSON.stringify(matches).includes("classify_files")) throw new Error("Tool not found");
    text(await describeTool("classify_files"));
  ` });
  const declarationText = declarationResult.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  const declaration = declarationText.match(/```ts\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(declaration, declarationText);
  assert.doesNotMatch(declaration, /questions: \{\}|answers: \{\}|criteria: \{\}|probabilities: \{\}|args: unknown/u);
  assert.ok(declaration.length < 16_000);
  const declarationPath = join(agentDir, "file-classification-declaration.ts");
  await writeFile(declarationPath, declaration + `
    const selection = { kind: "paths" as const, paths: ["src/example.ts"] };
    const bool = { type: "bool" as const, instructions: "Question?", criteria: { true: "Yes", false: "No" } };
    tools.classify_files({ mode: "preview", selection });
    tools.classify_files({ selection, questions: { relevant: bool } });
    tools.classify_files({ mode: "classify", selection, questions: {
      relevant: bool,
      role: { type: "choice", instructions: "Role?", criteria: { domain: "Domain", adapter: "Adapter" } },
      risk: { type: "score", instructions: "Risk?", criteria: ["Low", "High"] }
    } });
    // @ts-expect-error Classification requires questions.
    tools.classify_files({ mode: "classify", selection });
    // @ts-expect-error An omitted mode is classification, not preview.
    tools.classify_files({ selection });
    // @ts-expect-error Preview does not accept questions.
    tools.classify_files({ mode: "preview", selection, questions: { relevant: bool } });
    // @ts-expect-error The question union rejects unknown discriminants.
    tools.classify_files({ selection, questions: { invalid: { type: "other" } } });
    // @ts-expect-error Choice criteria contain string descriptions.
    tools.classify_files({ selection, questions: { invalid: { type: "choice", instructions: "?", criteria: { first: 1, second: 2 } } } });
    async function inspectAnswers() {
      const scan = await tools.classify_files({ selection, questions: { relevant: bool } });
      for (const file of scan.files) {
        if (file.status !== "classified") continue;
        const answer = file.answers.relevant;
        if (answer?.type === "bool") { const probability: number = answer.probability; }
        if (answer?.type === "choice") {
          const choice: string = answer.choice;
          const probability: number | undefined = answer.probabilities[choice];
          const confidence: number = answer.confidence;
        }
        if (answer?.type === "score") {
          const score: number = answer.score;
          const confidence: number = answer.confidence;
        }
      }
    }
  `);
  const program = ts.createProgram([declarationPath], {
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2023,
    noImplicitOverride: true, noFallthroughCasesInSwitch: true,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);

  resourceLoader.getExtensions().runtime.flagValues.set("jev-files-allow-remote", false);
  const previewResult = await codemode.execute("preview-integration", { code: `
    const preview = await tools.classify_files({ mode: "preview", selection: { kind: "globs", include: ["src/**/*.ts"] } });
    text({ status: preview.status, previewed: preview.summary.previewed, requests: preview.summary.requests });
  ` });
  assert.match(JSON.stringify(previewResult.content), /previewed[^0-9]*2/u);
  assert.match(JSON.stringify(previewResult.content), /requests[^0-9]*0/u);
  assert.equal(classifierCalls, 0);
  observed.length = 0;
  const invalidResult = await codemode.execute("validation-integration", { code: `
    const selection = { kind: "paths", paths: ["src/example.ts"] };
    const question = { type: "bool", instructions: "Question?", criteria: { true: "Yes", false: "No" } };
    const invalid = [
      { mode: "preview", selection, questions: {} },
      { mode: "classify", selection },
      { selection },
      { selection, questions: { "bad label": question } },
      { selection, questions: { constructor: question } },
      { selection, questions: Object.fromEntries(Array.from({ length: 9 }, (_, index) => ["q" + index, question])) },
      { selection, questions: { role: { type: "choice", instructions: "Role?", criteria: { valid: "One", "bad label": "Two" } } } },
      { selection: { kind: "paths", paths: ["../outside.ts"] }, questions: { relevant: question } },
      { mode: "preview", selection, allowRemote: true }
    ];
    let refused = 0;
    for (const request of invalid) {
      try {
        const result = await tools.classify_files(request);
        if (result.status !== "failed" || result.error?.tag !== "InvalidRequest") throw new Error("Invalid input accepted");
        refused++;
      } catch (error) {
        if (String(error).includes("Validation failed")) refused++;
        else throw error;
      }
    }
    text({ refused });
  ` });
  assert.match(JSON.stringify(invalidResult.content), /refused[^0-9]*9/u);
  assert.equal(classifierCalls, 0);
  observed.length = 0;
  resourceLoader.getExtensions().runtime.flagValues.set("jev-files-allow-remote", true);
  const request = testRequest(["src/example.ts", "src/other.ts"]);
  request.questions.layer = { type: "choice", instructions: "Which layer?", criteria: { domain: "Domain", adapter: "Adapter" } };
  request.questions.risk = { type: "score", instructions: "Rate risk.", criteria: ["Low", "High"] };
  const first = await codemode.execute("scan-integration", { code: `
    const scan = await tools.classify_files(${JSON.stringify(request)});
    if (typeof scan !== "object" || !scan.files) throw new Error("Expected structuredContent");
    const hits = scan.files.filter(file => file.status === "classified" && file.answers.relevant.probability > 0.8)
      .sort((left, right) => right.answers.relevant.probability - left.answers.relevant.probability);
    store("jev-hits", hits.map(file => file.path));
    text({ status: scan.status, hits: hits.length, tokens: scan.summary.usage.totalTokens });
  ` });
  const firstText = first.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.match(firstText, /Script completed/u);
  assert.match(firstText, /"hits":2/u);
  assert.match(firstText, /"tokens":10/u);
  assert.doesNotMatch(firstText, /SYNTHETIC_SOURCE_NOT_FOR_MAIN_CONTEXT/u);
  const second = await codemode.execute("followup-integration", { code: `
    const paths = load("jev-hits");
    if (!Array.isArray(paths) || paths.length !== 2) throw new Error("Store not restored");
    const scan = await tools.classify_files({
      selection: {kind:"paths",paths:[paths[0]]},
      questions: ${JSON.stringify(request.questions)}
    });
    text({status:scan.status,classified:scan.summary.classified});
  ` });
  const secondText = second.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.match(secondText, /Script completed/u);
  assert.match(secondText, /"classified":1/u);
  assert.equal(classifierCalls, 3);
  assert.deepEqual(serverErrors, []);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(event => event.usage?.totalTokens), [10, 5]);
  assert.ok(observed.every(event => event.parent && !event.sourceLeaked));

  resourceLoader.getExtensions().runtime.flagValues.set("jev-files-allow-remote", false);
  const refusal = await codemode.execute("consent-integration", { code: `
    const scan = await tools.classify_files(${JSON.stringify(request)});
    text(scan.error.tag);
  ` });
  assert.match(JSON.stringify(refusal.content), /ConsentRequired/u);
  assert.equal(classifierCalls, 3);
  assert.ok(observed.every(event => !event.sourceLeaked));
});
