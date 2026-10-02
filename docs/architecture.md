# Architecture

This document describes the current runtime. For installation, tool inputs,
results, and limits, read [README.md](../README.md). The domain terms are in
[CONTEXT.md](../CONTEXT.md). Selection and disclosure rules are in
[security.md](security.md). Verification is in [development.md](development.md).

## Scope

The extension registers one codemode-only tool, classify_files. Callers select
project files and supply task-specific questions. Classification sends each
whole file and all questions in one request to typesafe/jev-latest through Pi.
There are no fixed question presets, source caches, background scans, provider
fallbacks, or separate preview tools.

## Module ownership

| Module | Owns |
| --- | --- |
| src/index.ts | Pi registration, startup consent flag, model and credential resolution, tool result translation |
| src/file-classification-contract.ts | TypeBox schemas, schema-derived types, input parsing |
| src/file-selection.ts | Ripgrep discovery, exclusions, metadata selection, bounded source reads |
| src/file-classification.ts | Scan admission, shared request capacity, deadlines, cancellation, answers, coverage, usage |

The Pi Adapter constructs one classifier for the extension. Pi supplies the
operation-specific FileClassifierRuntime through an explicit seam. Production
uses Pi model resolution and classifier transport. Tests supply controlled
runtimes and also exercise the real Pi Adapter.

A second Context tag and Layer graph would duplicate this seam for one
entrypoint. Keep runtime capabilities explicit. Effect owns I/O, concurrency,
clocks, and cleanup; pure checks remain ordinary TypeScript.

## Request flow

1. Pi validates tool arguments against the registered schema.
2. The classifier parser checks the input before filesystem or provider access.
3. Preview goes directly to metadata selection. It does not resolve a model,
   inspect credentials, read source content, or acquire provider permits.
4. Classification checks startup consent, then resolves the fixed model and
   credentials through Pi.
5. Selection applies ignore rules, exclusions, metadata checks, and budgets.
6. Classification acquires a shared request permit, reads bounded source, checks
   estimated context size, and submits the file with all questions.
7. The classifier validates answers, records outcomes and usage, and returns a
   source-free result. The Pi Adapter converts the Effect to a Promise.

Preview is not a source snapshot for later classification. Each classification
repeats selection and read checks.

## Contract ownership

TypeBox owns the input and output schemas. Public types derive from these
schemas; there is no second Effect schema or handwritten codemode declaration.

Preview requires explicit mode: "preview" and accepts selection only.
Classification requires questions; omitted mode remains classification.
Static types cannot enforce all path, key, count, and byte restrictions. The
internal classifier accepts the schema-derived union but retains runtime parsing.
Only the parser accepts raw unknown input, with a documented line-scoped lint
exception.

Dynamic maps use typed additionalProperties and propertyNames. Pi's declaration
renderer does not derive map values from patternProperties alone. Keep runtime
restrictions and generated declarations tested together.

## Resource ownership

Each classifier owns scan admission and shared provider capacity. Limits are
listed in README.md and enforced inside the runtime, not supplied by callers.
Preview occupies scan capacity but no provider request capacity. Requests have
zero automatic retries.

A request permit is acquired interruptibly. Before submission, the Effect owns
its release, including skipped content and read failures. At submission,
ownership transfers to the native provider Promise. Both settlement branches
release exactly once. Timeout or interruption aborts the signal but does not
release the permit while that Promise is outstanding. A provider that never
settles can hold capacity until process exit.

File handles and discovery children use Effect acquireUseRelease. Native handle
operations finish before closure. Discovery cleanup terminates an unfinished
child, awaits its close event, and removes listeners. Node metadata operations
that cannot be cancelled may settle after interruption; they own no source
handles and read no source content.

Effect Clock owns deadlines and monotonic duration. Caller AbortSignal
cancellation returns accounted scan results. Direct Effect interruption remains
interruption. Late provider settlement cannot mutate a returned result or add
late usage. Reload creates another classifier, so pending work must settle
before reload.

## Outcomes and accounting

Expected selection and read failures use typed Effect error channels. The runner
translates failures into bounded scan or file outcomes. Raw causes stay private.
Pi may reject malformed arguments before execution; those failures need not be
versioned scan results.

The selected count equals files.length and the sum of classified, previewed,
skipped, failed, and unprocessed counts. A classification with any non-classified
file is partial. Scan-level failures are failed and set the Pi result's isError.
Missing or invalid answers never become fabricated negative answers.

Answer validation checks exact question coverage and matching variants.
Probabilities and confidence are finite and bounded. Choice labels and keys
match criteria; probability sums allow a tolerance of 0.01. Score positions are
zero-based, may be fractional, and stay within the caller's criteria.

Valid reported usage includes billed errors and reaches Pi nested totals once.
Zero reported usage differs from missing usage. Invalid usage is omitted without
discarding valid answers. All-zero catalog pricing is unknown, not free.
Request and byte counters describe attempted submissions, not acceptance or
billing. Absent Pi usage remains an omitted property, not undefined.
