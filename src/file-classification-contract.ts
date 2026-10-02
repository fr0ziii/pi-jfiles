import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const objectOptions = { additionalProperties: false };

const instruction = Type.String({ minLength: 1, maxLength: 2000 });

const label = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" });

const relativePath = Type.String({ minLength: 1, maxLength: 1024 });

const questionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("bool"), instructions: instruction,
    criteria: Type.Object({ true: instruction, false: instruction }, objectOptions),
  }, objectOptions),
  Type.Object({
    type: Type.Literal("choice"), instructions: instruction,
    criteria: Type.Record(label, instruction, {
      minProperties: 2, maxProperties: 32, propertyNames: label, additionalProperties: instruction,
    }),
  }, objectOptions),
  Type.Object({
    type: Type.Literal("score"), instructions: instruction,
    criteria: Type.Array(instruction, { minItems: 2, maxItems: 10 }),
  }, objectOptions),
]);

const fileSelectionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("globs"),
    include: Type.Array(relativePath, { minItems: 1, maxItems: 32 }),
    exclude: Type.Optional(Type.Array(relativePath, { maxItems: 32 })),
  }, objectOptions),
  Type.Object({
    kind: Type.Literal("paths"),
    paths: Type.Array(relativePath, { minItems: 1, maxItems: 200 }),
  }, objectOptions),
]);

const fileClassificationRequestSchema = Type.Object({
  mode: Type.Optional(Type.Literal("classify")),
  selection: fileSelectionSchema,
  // Pi renders additionalProperties, not patternProperties. propertyNames retains key restrictions.
  questions: Type.Record(label, questionSchema, {
    minProperties: 1, maxProperties: 8, propertyNames: label, additionalProperties: questionSchema,
  }),
}, objectOptions);

/** One file tool input: selection-only preview or classification with required questions. */
export const fileClassificationInputSchema = Type.Union([
  Type.Object({ mode: Type.Literal("preview"), selection: fileSelectionSchema }, objectOptions),
  fileClassificationRequestSchema,
]);

/** Relative file selection shared by preview and classification; ignore rules always apply. */
export type FileSelection = Static<typeof fileSelectionSchema>;

/** A remote classification request; omitted mode remains classification for existing callers. */
export type FileClassificationRequest = Static<typeof fileClassificationRequestSchema>;

/** Schema-derived input variants; runtime checks also enforce paths, keys, and byte limits. */
export type FileClassificationInput = Static<typeof fileClassificationInputSchema>;

const probability = Type.Number({ minimum: 0, maximum: 1 });

const answerSchema = Type.Union([
  Type.Object({ type: Type.Literal("bool"), probability }, objectOptions),
  Type.Object({
    type: Type.Literal("choice"), choice: label,
    probabilities: Type.Record(label, probability, { maxProperties: 32, propertyNames: label, additionalProperties: probability }),
    confidence: probability,
  }, objectOptions),
  Type.Object({ type: Type.Literal("score"), score: Type.Number({ minimum: 0, maximum: 9 }), confidence: probability }, objectOptions),
]);

/** Typed classifier answers; callers must also check question coverage and criterion bounds. */
export const fileClassificationAnswersSchema = Type.Record(label, answerSchema, {
  minProperties: 1, maxProperties: 8, propertyNames: label, additionalProperties: answerSchema,
});

const reasonSchema = Type.Union([
  Type.Literal("excluded"), Type.Literal("not-eligible"), Type.Literal("symlink"),
  Type.Literal("not-regular"), Type.Literal("oversized"), Type.Literal("binary"),
  Type.Literal("unreadable"), Type.Literal("file-changed"), Type.Literal("context-limit"),
  Type.Literal("provider-error"), Type.Literal("invalid-answer"), Type.Literal("cancelled"),
  Type.Literal("deadline"), Type.Literal("scan-limit"),
]);

const count = Type.Integer({ minimum: 0 });

const fileOutcomeSchema = Type.Union([
  Type.Object({
    status: Type.Literal("classified"), path: relativePath, bytes: count,
    digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    answers: fileClassificationAnswersSchema,
  }, objectOptions),
  Type.Object({ status: Type.Literal("preview"), path: relativePath, bytes: count }, objectOptions),
  Type.Object({
    status: Type.Union([Type.Literal("skipped"), Type.Literal("failed"), Type.Literal("unprocessed")]),
    path: relativePath, reason: reasonSchema,
  }, objectOptions),
]);

/** Structured scan output for codemode; it contains no scanned source or provider error body. */
export const fileClassificationOutputSchema = Type.Object({
  version: Type.Literal(1),
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("preview"), Type.Literal("failed")]),
  model: Type.Object({ provider: Type.Literal("typesafe"), id: Type.Literal("jev-latest") }, objectOptions),
  summary: Type.Object({
    discovered: count, selected: count, classified: count, previewed: count,
    skipped: count, failed: count, unprocessed: count, bytesSubmitted: count,
    requests: count, elapsedMs: count, usageReports: count,
    usageAvailability: Type.Union([Type.Literal("none"), Type.Literal("partial"), Type.Literal("complete")]),
    pricing: Type.Union([Type.Literal("catalog"), Type.Literal("unknown")]),
    usage: Type.Object({ input: count, output: count, totalTokens: count, costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]) }, objectOptions),
  }, objectOptions),
  files: Type.Array(fileOutcomeSchema, { maxItems: 200 }),
  error: Type.Optional(Type.Object({
    tag: Type.Union([
      Type.Literal("InvalidRequest"), Type.Literal("ConsentRequired"), Type.Literal("ModelUnavailable"),
      Type.Literal("CredentialsRequired"), Type.Literal("DiscoveryFailed"), Type.Literal("ScanLimit"),
      Type.Literal("ScanBusy"), Type.Literal("Cancelled"), Type.Literal("Deadline"),
    ]),
    message: Type.String({ maxLength: 300 }),
  }, objectOptions)),
}, objectOptions);

/** A source-free scan result with explicit coverage accounting. */
export type FileClassificationOutput = Static<typeof fileClassificationOutputSchema>;

/** One whole-file outcome; failed and skipped files never receive fabricated answers. */
export type FileClassificationOutcome = FileClassificationOutput["files"][number];

/** Stable scan-level failures, translated by the Pi tool entrypoint. */
export type FileScanError = NonNullable<FileClassificationOutput["error"]>;

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Parse dynamic questions and selection without erasing their schema-established types. */
export function parseFileClassificationInput(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- External input stays unknown until schema and semantic checks pass.
  value: unknown,
):
  | { readonly status: "ok"; readonly input: FileClassificationInput }
  | { readonly status: "error"; readonly error: FileScanError } {
  const invalid = { status: "error", error: { tag: "InvalidRequest", message: "Jev files request is invalid. Use bounded relative paths and typed questions." } } as const;

  if (!Check(fileClassificationInputSchema, value)) return invalid;

  if (value.mode !== "preview") {
    if (Buffer.byteLength(JSON.stringify(value.questions)) > 16 * 1024) return invalid;

    for (const [key, question] of Object.entries(value.questions)) {
      if (reservedKeys.has(key)) return invalid;

      if (question.type === "choice" && Object.keys(question.criteria).some(key => reservedKeys.has(key))) return invalid;
    }
  }

  const paths = value.selection.kind === "paths"
    ? value.selection.paths
    : [...value.selection.include, ...(value.selection.exclude ?? [])];

  for (const path of paths) {
    // Only portable slash-separated paths; globs support *, **, ?, and character classes.
    if (path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
        path.split("/").some(part => part === ".." || part === "." || part === "") ||
        // oxlint-disable-next-line no-control-regex -- Control characters are invalid in project paths.
        /[\x01-\x1f\x7f]/u.test(path) || /^[A-Za-z]:/u.test(path)) return invalid;

    if (value.selection.kind === "globs" && /[{}()!]/u.test(path)) return invalid;
  }

  return { status: "ok", input: value };
}
