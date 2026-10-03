import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { scanInputSchema, scanResultSchema } from "./file-classification-contract.ts";
import { createFileClassifier } from "./file-classification.ts";

/** Register whole-file semantic classification as a structured codemode-only tool. */
export default function registerJevFiles(pi: ExtensionAPI): void {
  const classifier = createFileClassifier();
  pi.registerFlag("jev-files-allow-remote", {
    type: "boolean", default: false,
    description: "Allow classify_files to submit selected project source and questions to TypeSafe.",
  });
  pi.registerTool({
    name: "classify_files",
    label: "Classify files",
    exposure: "codemode",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    description: "Classify whole project files with dynamic bool, choice, or score questions using TypeSafe Jev. Use mode: preview with selection only; it needs no questions, credentials, or remote consent and reads only metadata. Classification requires questions; omitted mode is classify. Paths and basic recursive globs are relative to cwd and preserve ignore rules. Excludes credentials, dependencies, generated directories, and symlinks. Bounds: 200 files, 64 KiB/file, 5 MiB source, 8 questions, 4 shared requests. Output contains answers and coverage, never source. Scores use zero-based criteria indices. Missing answers mean no evidence; confidence does not prove correctness. For follow-up use exact paths, then read only relevant files. Remote classification requires starting Pi with --jev-files-allow-remote; /reload cannot grant this permission.",
    parameters: scanInputSchema,
    outputSchema: scanResultSchema,
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const run = await Effect.runPromise(classifier.run(ctx.cwd, args, {
        allowRemote: pi.getFlag("jev-files-allow-remote") === true,
        async resolveModel() {
          const model = ctx.modelRegistry.getModelOfType("classifier", "typesafe", "jev-latest");

          if (!model) return { status: "error", error: { tag: "ModelUnavailable", message: "Run pi update --models to load typesafe/jev-latest." } };

          if (!(await ctx.modelRegistry.getApiKeyForProvider("typesafe"))) {
            return { status: "error", error: { tag: "CredentialsRequired", message: "Jev files requires TypeSafe credentials. Use /login or TYPESAFE_API_KEY before classification." } };
          }

          return { status: "ok", model };
        },
        classify: (model, context, options) => ctx.modelRegistry.classify(model, context, options),
      }, signal));

      const summary = { status: run.result.status, summary: run.result.summary, error: run.result.error };

      const toolResult: AgentToolResult<typeof summary> = {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        structuredContent: run.result,
        details: summary,
        // Pi keeps schema-defined error results consumable in codemode.
        isError: run.result.status === "failed",
      };

      if (run.usage) toolResult.usage = run.usage;

      return toolResult;
    },
  });
}
