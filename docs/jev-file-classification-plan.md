# Dynamic file classification for Pi

Status: implemented. The source was extracted from dotfiles revision `e560e02`.
The earlier baseline, `cbe2f6e`, required changes to preview inputs, typed
declarations, exclusions, and consent diagnostics.
The [extension guide](../README.md) describes the current behavior.
Section 13 records the pre-extraction review evidence and remaining risks.

## 1. Goal and scope

Let the agent ask task-specific questions about project files through codemode.
The extension reads whole files and sends them to the official TypeSafe Jev
classifier through Pi. It returns typed answers, paths, digests, and coverage.
The primary agent receives source only through a separate read operation.

Questions are dynamic boolean, choice, or score questions. All questions go
with each whole file in one request. Callers select recursive globs or exact
paths, then filter, rank, and store results in codemode.

Review the complete extension, not only the reported failures. The review covers
its interface, selection policy, source reads, provider use, resource ownership,
results, tests, documentation, installation, and dependency risks.

### Required changes

| ID | Baseline problem | Required result |
| --- | --- | --- |
| R1 | Preview requires questions; an empty map fails validation | Preview accepts selection without questions |
| R2 | Codemode renders `questions: {}` and `answers: {}` | Generated declarations contain all question and answer variants and typed maps |
| R3 | Filename rules exclude legitimate design tokens | Ordinary token, credential, and secret implementation files remain eligible |
| R4 | Generic `oauth` and `sessions` directory rules hide source | Exclude known runtime storage, not all implementation directories with those names |
| R5 | Credentials can be mistaken for upload permission | Consent diagnostics explain the startup flag and restart requirement |
| R6 | Current tests do not detect the declaration regression | Exercise actual Pi declarations, validation, and codemode calls |
| R7 | The plan describes only the baseline | Record compatibility choices, review evidence, and completion gates |

Do not add fixed audit presets, generated questions, custom HTTP clients,
MCP servers, virtual-model routers, background scans, or persistent source caches.
Use Effect for runtime I/O, concurrency, deadlines, clocks, and cleanup.
Keep pure logic in TypeScript and public contracts in TypeBox.
Code-window localization, caching, provider selection, and new registered tools
are outside this revision.

## 2. Decisions to preserve

- Register exactly one tool: `classify_files`, with `exposure: "codemode"`.
  Do not add `preview_files` or a second classification tool.
- Fix the model to `typesafe/jev-latest` with API `typesafe-system-one`.
  Reject another provider, model, or classifier API. Do not add a fallback.
- Reuse Pi model discovery, authentication, and classifier transport.
  Do not copy credentials or read `auth.json` directly.
- Require `--jev-files-allow-remote` at process startup for classification.
  Preview needs neither credentials nor consent and reads metadata only.
- Keep an output schema and source-free `structuredContent`.
  Keep direct content and details to safe summaries.
- Preserve ripgrep ignore rules before applying Node glob matching.
  Exact paths cannot bypass ignore rules or sensitive-file exclusions.
- Read bounded whole UTF-8 files with snapshot and symlink checks.
  Never truncate source or convert a failure into a negative answer.
- Admit at most two scans and share four classifier request permits.
  Hold permits until provider promises settle, even if they ignore cancellation.
- Use 30-second request and 120-second scan deadlines, with no retries.
- Preserve valid reported usage, including billed errors. Missing usage and
  zero catalog pricing remain unknown; neither establishes free service.

Source uploads consume classifier context and can incur cost. Filename rules
are not secret detection. Confidence is evidence, not proof. Filesystem checks
are not an OS sandbox against hostile concurrent changes.

## 3. One tool, two input variants

The following declarations specify the intended interface. Actual declarations
can be inlined by Pi; these names do not require additional registered tools.

```ts
type FileSelection =
  | { kind: "globs"; include: string[]; exclude?: string[] }
  | { kind: "paths"; paths: string[] };

type FileClassificationQuestion =
  | {
      type: "bool";
      instructions: string;
      criteria: { true: string; false: string };
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    };

type FilePreviewInput = {
  mode: "preview";
  selection: FileSelection;
};

type FileClassificationRequest = {
  mode?: "classify";
  selection: FileSelection;
  questions: Record<string, FileClassificationQuestion>;
};

type FileClassificationInput = FilePreviewInput | FileClassificationRequest;
```

### Compatibility choices

- Keep omitted `mode` as classification for existing callers. Missing questions
  must never cause an implicit preview.
- Require explicit `mode: "preview"` for preview. Reject `questions` in this
  variant so its declaration has only preview inputs.
- Keep both explicit and implicit classification calls valid. Use explicit
  `mode: "classify"` in new examples.
- Existing previews that spread a classification request must change to pass
  selection only. Do not use a compatibility shim that silently drops fields.
- Keep output version 1 because the output shape and meaning do not change.
  Document the input change separately; version 1 does not promise input
  compatibility with the old preview shape.

Preview must work with both selection kinds. It must not validate questions,
resolve the classifier, inspect credentials, read source content, or upload.
It still applies path checks, ignore rules, exclusions, metadata checks,
selection budgets, cancellation, and the scan deadline.

Classification requires 1–8 questions. An absent or empty map is invalid.
Reject unsupported fields, including caller-provided source, root, credentials,
provider, limits, or a consent override. Keep strict objects for the variants,
selection, individual questions, and answers.

Parsing owns the conversion from unknown input to the validated input union.
Selection needs only the shared selection data; it must not depend on questions.
Only the classification branch can access questions or provider operations.
Do not cast a preview into a classification input to reuse existing code.

### Question invariants

- Keys match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.
- Reject `__proto__`, `prototype`, and `constructor` in dynamic maps.
- Instructions and criterion descriptions contain 1–2,000 characters.
- Choice criteria have 2–32 labels and obey the same label restrictions.
- Score criteria have 2–10 ordered descriptions.
- Serialized questions occupy at most 16 KiB, measured as UTF-8 bytes.
- Reject unsupported question types and extra question fields.

Static declarations cannot encode all count, byte, or key restrictions.
Runtime validation must retain these restrictions even when declarations improve.

## 4. Codemode declaration correctness

The baseline uses bounded `Type.Record` schemas with `patternProperties` and
`additionalProperties: false`. The installed Pi declaration renderer handles
`additionalProperties`, but does not render `patternProperties`. Thus a valid
runtime map becomes `{}` in the script-visible declaration.

This affects three separate map positions:

1. The top-level question map.
2. Choice criterion maps.
3. Answer maps and choice probability maps.

The implementation uses typed `additionalProperties` for declaration rendering
and `propertyNames` for label restrictions. TypeBox, Pi runtime validation, and
the generated declarations are tested together. The parser retains reserved-key
and serialized-byte checks. Do not remove validation to improve a declaration.

The installed renderer handles `anyOf` and `oneOf`, so a union is a candidate
for the input variants. Confirm the complete Pi registration and nested-call
path before choosing the final schema representation.

The answer declaration must expose this structure:

```ts
type FileClassificationAnswer =
  | { type: "bool"; probability: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "score"; score: number; confidence: number };
```

### Declaration acceptance checks

- `describeTool("classify_files")` shows both input variants.
- Preview has no required question field; classification does.
- Every question and answer discriminant and field is visible.
- All dynamic maps have typed values, not `{}`, `unknown`, or `any`.
- The generated declaration compiles with representative valid calls.
- Type-level invalid-call cases reject missing classification questions and
  invalid question variants. Runtime tests cover restrictions not expressible
  in TypeScript, including extra fields and key patterns.
- A runtime preview without questions succeeds through actual codemode.
- `searchTools()` can find the same registered tool. An inline declaration
  budget can omit the tool, but `describeTool()` must return its full declaration.
- The complete input stays below Pi's declaration-size fallback limit.

Do not hand-maintain a second declaration string, patch installed Pi files,
change codemode settings to hide the problem, or add a second tool as a workaround.
If the host cannot represent the required interface, report the compatibility
blocker before changing this design.

## 5. Discovery, exclusions, and source safety

### Discovery and selection

Keep discovery local to the real path of the current working directory.
Requests cannot choose another root. Preserve ripgrep ignore rules and bounded
NUL-separated discovery with `--hidden`, `--no-config`, and `--no-require-git`.
Do not follow symlinks or enable an unrestricted filesystem traversal.

Paths must be relative, slash-separated, and at most 1,024 characters.
Reject absolute paths, drive prefixes, traversal, empty components, controls,
and backslashes. Reject invalid UTF-8 discovery paths. Preserve Unicode and
BOM characters rather than changing path identity.

Globs support `*`, `**`, `?`, and character classes. Reject braces and extglobs.
Ordinary `**/*.ts` does not select dotfiles; explicit patterns can select them.
Treat exact-path entries literally, including filenames with glob characters.
Deduplicate paths and return deterministic outcomes.

An empty glob match succeeds with zero selected files. An empty exact-path
list is invalid. Ignored or missing exact paths receive `not-eligible` outcomes.
Explicitly denied exact paths receive `excluded` outcomes.

Preserve the distinction between discovery and eligible source. Sensitive paths
can be visible as metadata without becoming eligible for reads. Do not claim
that every excluded path is absent from discovery, or that the discovered count
is the total number of files on disk.

### Revised exclusion policy

Use one policy for glob selection, exact paths, and source-read eligibility.
Ripgrep pruning must not contradict the final policy. An exact path cannot
bypass it. Case handling must not make sensitive paths eligible unexpectedly.

Keep dependency and generated directory exclusions: `.git`, `node_modules`,
`vendor`, `dist`, `build`, `coverage`, `.next`, `.cache`, `target`, `.venv`,
and `__pycache__`. Keep `.ssh` and `.aws` exclusions.

Remove generic `oauth` and `sessions` directory exclusions. Replace them with
explicit known Pi runtime paths under `.pi`, including its session and OAuth
storage. Preserve exclusions for known Pi `npm`, `bin`, and log storage.
Do not exclude an application directory only because its name is `oauth`,
`sessions`, or `auth`.

Keep hard exclusions for `.env*`, `auth.json`, credential data filenames,
private key names, `.netrc`, `.npmrc`, `.pypirc`, and key/certificate extensions
such as `.pem`, `.key`, `.p12`, `.pfx`, and `.keystore`.
Keep `.DS_Store` and `herdr-agent-state.ts` excluded.

Replace broad `credentials|secrets|tokens` filename matching with rules that
separate implementation files from likely credential data. Apply delimiter-matched
sensitive names to extensionless names, including hidden names, and to these
extensions: `.json`, `.jsonc`, `.toml`, `.yaml`, `.yml`, `.ini`, `.cfg`, `.conf`,
`.txt`, `.csv`, `.xml`, `.properties`, `.log`, and `.bak`.
This retains common credential-data protections without excluding source and
style filenames only because they contain these words. Hard exclusions take
precedence; a source extension is not a general bypass. Paired fixtures verify
the allowed implementation paths and each denied data extension.

| Example | Intended eligibility, subject to ignore and filesystem checks |
| --- | --- |
| `src/styles/tokens.css` | Eligible |
| `src/styles/design-tokens.scss` | Eligible |
| `src/lib/tokens.ts` | Eligible |
| `src/lib/credentials.ts` | Eligible |
| `src/lib/secrets.ts` | Eligible |
| `src/pages/oauth/callback.ts` | Eligible |
| `src/oauth/token.ts` | Eligible |
| `src/sessions/store.ts` | Eligible |
| `config/secrets.json` | Excluded |
| `config/access-tokens.json` | Excluded |
| `credentials` or `credentials.toml` | Excluded |
| `.env` or `.env.local` | Excluded |
| `auth.json`, `.ssh/id_ed25519`, or `keys/private.pem` | Excluded |
| `.pi/agent/sessions/history.jsonl` | Excluded |
| `.pi/agent/oauth/state.json` | Excluded |
| `node_modules/package/tokens.ts` or `dist/tokens.css` | Excluded |

These rules reduce accidental submission. They do not detect embedded secrets,
guarantee that eligible files are safe, or resolve every design-token data-file
false positive. Do not add a caller-controlled exclusion bypass.

### Read checks to retain

- Resolve the project root and reject a selected snapshot from another root.
- Check every path component for symlinks before and after reading.
- Open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and require a regular file.
- Check device, inode, size, modification time, and change time against the
  selected snapshot and the final pathname.
- Read bounded bytes, detect growth, and close file handles on every outcome.
- Reject NUL-containing or invalid UTF-8 content as `binary`.
- Preserve a UTF-8 BOM. Compute SHA-256 over the original bytes.
- Never truncate an oversized file or include read bytes in an error.

Preview cannot guarantee that classification will read the same snapshot.
Classification repeats selection and read checks. No preview token or frozen
selection is added in this revision.

## 6. Consent, credentials, and provider behavior

For a valid classification request, check process consent before model/auth
resolution, discovery, source reads, or classifier execution. An absent flag
returns `ConsentRequired`, zero requests, and zero submitted bytes.
A configured API key is not upload permission.

Use a bounded consent message that states all of these facts:

- The current Pi process does not permit remote source submission.
- Start a new Pi process with `--jev-files-allow-remote` to permit it.
- `/reload` cannot grant this startup permission.

Retain the `ConsentRequired` tag. Do not include credentials, source, provider
bodies, or a complete user prompt in diagnostics. Do not automatically restart
Pi, send a restart command to another pane, mutate flag values in production,
add a tool consent argument, or save consent in settings.

After consent, use Pi to resolve `typesafe/jev-latest`, verify its identity and
API, and check credential availability without displaying the credential.
Retain actionable `ModelUnavailable` and `CredentialsRequired` messages.
The credential message can refer to `/login` and `TYPESAFE_API_KEY`.

Each provider request carries only the relative path, whole content,
`sourceKind: "untrusted-project-file"`, and caller questions in classifier
state/questions. File content is untrusted evidence, not extension instructions.
Do not execute scanned content or let it change selection or provider options.

Pi owns transport and credentials. The model identity check does not establish
that a locally overridden provider endpoint is trustworthy. Document that users
must review provider overrides. Do not introduce a second HTTP implementation.
Unrelated warnings, such as a missing pi-cloak configuration, are not Jev
consent failures and are outside this revision.

## 7. Results, coverage, and failure semantics

Keep the source-free output shape at version 1. It contains model identity,
file outcomes, coverage, usage, duration, and an optional safe scan error.

```text
selected = files.length
selected = classified + previewed + skipped + failed + unprocessed
```

| File status | Data and meaning |
| --- | --- |
| `classified` | Relative path, bytes, digest, and validated answers |
| `preview` | Relative path and bytes; no content, digest, or answers |
| `skipped` | Path and reason; no answer was obtained |
| `failed` | Path and reason; the operation did not produce valid answers |
| `unprocessed` | Path and reason; cancellation/deadline prevented completion |

Scan status remains `preview`, `complete`, `partial`, or `failed`.
A classification scan with any skipped, failed, or unprocessed outcome is
`partial`, even when no file was classified. A scan-level failure is `failed`.
A preview can contain skipped outcomes; callers must inspect its coverage.
Keep the current scan-level error tags:

`InvalidRequest`, `ConsentRequired`, `ModelUnavailable`, `CredentialsRequired`,
`DiscoveryFailed`, `ScanLimit`, `ScanBusy`, `Cancelled`, and `Deadline`.

Return structured scan failures with `isError: true` instead of throwing away
the result. Keep `partial` findings consumable. An attached cancellation or
deadline error does not erase completed file outcomes or usage.
Pi can reject malformed arguments before execution; such schema failures are
not guaranteed to be versioned scan results. Test both validation paths.

Validate exact question coverage and matching answer types. Reject missing,
extra, malformed, or out-of-range answers rather than inventing negatives.
Boolean probabilities and confidence values are finite and between 0 and 1.
Choice labels and probability keys must match the caller's criteria; probability
sums retain the baseline tolerance of 0.01. Score positions are zero-based,
can be fractional, and cannot exceed the caller's last criterion position.

Only the caller chooses thresholds, ranking, and interpretation. File answers
cannot prove a cross-file bug, authorization correctness, or missing tests.
Use deterministic search for literal text. Read promising files separately.
Paths, digests, questions, and findings can still be sensitive even without
source. Codemode storage and Pi session records follow Pi's retention rules.

## 8. Resource ownership, usage, and performance

| Resource | Limit |
| --- | --- |
| Selected files | 200 |
| Source per file | 64 KiB |
| Total eligible source per scan | 5 MiB |
| Questions | 1–8 |
| Serialized questions | 16 KiB |
| Instructions or criterion description | 2,000 characters |
| Choice criteria | 2–32 |
| Score criteria | 2–10 |
| Include or exclude globs | 32 each |
| Path length | 1,024 characters |
| Discovery | 50,000 paths / 4 MiB output |
| Active scans | 2 |
| Outstanding classifier requests across scans | 4 |
| Request deadline | 30 seconds |
| Scan deadline | 120 seconds |

File-count and aggregate-byte violations fail before upload. Oversized files
are skipped. Context checks retain the conservative serialized-byte estimate
plus 2,048 bytes, not a claim of exact tokenization. Context overflow skips the
file without a request. Requests cannot raise limits or enable retries.

The runner owns scan admission and shared request capacity. Preview uses scan
admission but no classifier request permits. Provider requests from separate
scans share the same four permits.

Review cancellation while discovering, selecting, waiting for a permit,
reading, resolving the model, and awaiting the provider. Stop new work after
cancellation. Remove waiters and listeners, terminate discovery processes, and
close handles and timers. Release permits exactly once, only when provider
promises settle. A provider that never settles can occupy a permit until process
exit; do not conceal this by admitting replacement requests.

Review cleanup on reload and session shutdown. Do not leave an unhandled
rejection or assume that an aborted provider promise has settled. Report any
lifecycle ownership defect before adding another scheduler or shutdown layer.

Use the Effect Clock for duration and deadlines. Retain the explicit Pi runtime
seam for tests. Drive temporal tests with TestClock and readiness signals.
The runner reports valid provider usage, including billed error responses.
Codemode/Pi session totals receive nested usage once. Late usage after a returned
deadline cannot be added to that result. `bytesSubmitted` and `requests` count
attempted submissions, not proof of provider acceptance or billing.

Usage availability is `complete`, `partial`, or `none`. Zero reported tokens
differ from no usage report. Invalid usage is not added. Catalog pricing with
all zero prices remains `unknown`, and `costUsd` remains null. Do not present
unknown cost as zero cost. Keep provider-reported usage separate from this cost
interpretation and record any mismatch found in session totals.

## 9. Module ownership and change locations

Runtime modules live under `src/`. Tests and fixtures live under `tests/`.
Development configuration stays at the repository root. This review record lives
under `docs/`.

| File | Owns | Review/change focus |
| --- | --- | --- |
| `src/index.ts` | Pi registration, consent flag, auth/model resolution, tool results | One registration; accurate description; source-free errors and nested usage |
| `src/file-classification-contract.ts` | Input/output schemas and parser | Input union; typed maps; key/count/byte checks; output compatibility |
| `src/file-selection.ts` | Discovery, exclusions, metadata, safe reads | Shared selection type; narrow exclusions; preserve read safeguards |
| `src/file-classification.ts` | Runner, coverage, deadlines, capacity, answers, usage | Mode narrowing; consent ordering; retain lifecycle and result invariants |
| `tests/test-fixtures.ts` | Synthetic projects, requests, runtime responses | Distinct preview/classification fixtures without invalid casts |
| `tests/*.test.ts` | Contract, selection, runner, real Pi/codemode evidence | Regression matrix below |
| `package.json`, lockfile, `tsconfig.json` | Dependencies and checks | Strict types; host peers; no new runtime dependency without need |
| `README.md` | Installation, safety, examples, limitations | Selection-only preview; restart guidance; exact exclusion behavior |
| This review record | Design and review status | Links and evidence stay consistent |

The `FileClassifier` interface exposes one scan operation. Keep selection,
coverage, deadlines, and provider mechanics inside this deep module, not in
caller scripts. Pi already owns auth and transport; do not add a redundant
provider adapter. Schema-derived types and ordinary TypeScript narrowing must
carry the two input variants through the implementation.

## 10. Verification matrix

Routine tests use Node's test runner, temporary directories, real ripgrep,
and explicit classifier runtimes for failure/resource cases. The integration
uses a real Pi SDK session and Pi TypeSafe transport against a local HTTP
fixture, with synthetic source and credentials. No routine check calls the
paid remote service or mocks an imported provider function.

| Area | Required evidence |
| --- | --- |
| Preview contract | Both selection kinds; no questions; no consent; no credentials; no model resolution or classifier call |
| Classification contract | Explicit and omitted mode; valid mixed questions; absent/empty/oversized/invalid questions rejected |
| Variant separation | Preview with questions rejected; invalid modes and extra options rejected; no implicit preview |
| Declarations | Actual Pi output exposes union and every typed map; generated declarations compile; negative type cases fail |
| Runtime validation | Actual nested tool calls reject invalid keys, fields, paths, and question counts |
| Allowed paths | Every eligible example in section 5 works for globs and exact paths when applicable |
| Sensitive paths | Denied examples never reach source upload; case variants and nested known runtime paths stay denied |
| Discovery | Ignore rules, user exclusions, dotfiles, duplicates, empty matches, invalid UTF-8 and overlong paths |
| Safe reads | External root, symlink file/parent, snapshot mutation/replacement, non-regular and unreadable files |
| Content | Empty file, Unicode/BOM content and paths, digest accuracy, NUL bytes, invalid UTF-8, oversize without truncation |
| Budgets | File/discovery/aggregate/context limits; no request before failed preflight |
| Preconditions | No flag with credentials still yields `ConsentRequired`; no model or key after consent produces correct diagnostics |
| Answers | Missing/extra keys, wrong variants, bad probabilities/labels/sums, finite fractional score and criterion bounds |
| Lifecycle | Caller/provider abort, request/scan deadline, blocked permits, provider rejection, ignored abort, scan admission |
| Coverage | Coverage equation for every result; stable ordering; partial and all-file-failure semantics |
| Usage | Reported zero versus missing usage; billed errors; invalid usage; unknown prices; nested totals counted once |
| Data exposure | Synthetic source and credentials absent from content, details, structured results, errors, and emitted tool results |
| Codemode workflow | Preview, classify, filter, store/load, rank, exact-path follow-up, nested IDs and structured failures |
| Installation | npm archive contents, isolated Pi installation, package discovery, single tool registration, startup flag |

For lifecycle cases, prefer controllable promises and explicit synchronization
over long sleeps. Keep real transport and registration coverage; do not replace
it with assertions against a copied declaration or hand-built result.

A passing baseline suite does not verify the proposed interface. Each required
change needs a regression that fails on the baseline and passes on the revision.
Record review findings by file, violated requirement, reproduction, and severity.
Separate a confirmed defect from a question or a deferred enhancement.

## 11. Implementation order and completion gates

1. Reproduce the declaration failure and preview validation failure with the
   installed Pi version. Capture source-free evidence and add failing tests.
2. Implement the input union and typed dictionary representation together.
   Confirm registration, declarations, static types, parser, and actual codemode.
3. Narrow exclusions in both discovery pruning and final selection. Add paired
   allow/deny fixtures before accepting the disclosure-policy change.
4. Improve consent diagnostics. Verify that every refusal still sends zero bytes
   and requests, and that preview stays independent from model/auth resolution.
5. Review the complete runner, read path, result accounting, and lifecycle using
   the verification matrix. Fix confirmed defects within the agreed scope.
   Report changes that would alter preserved decisions for separate approval.
6. Update the guide and examples only when the implementation matches them.
   State the old-preview migration, optional classification mode, new exclusion
   rules, metadata limitations, and source-submission risks.
7. Run checks, inspect the complete diff, and record remaining risks.

```bash
npm run check
npm audit
npm pack --dry-run --ignore-scripts
pi list
git diff --check
git status --short
```

Use a temporary Pi agent directory for package installation tests. Keep the
user's existing settings and MCP configuration unchanged during those tests.
Do not commit credentials, runtime state, source-bearing reports, dependency
directories, or test artifacts.

The baseline development audit reports a high-severity denial-of-service
advisory in the Pi 0.99.1 peer's shrinkwrapped `brace-expansion@5.0.9`.
Ordinary audit fixes and an attempted override did not replace it.
Recheck the installed dependency and track an upstream fix. Do not hide the
finding or claim that rejecting brace globs patches Pi. Routine checks may
remain green while this documented upstream risk remains unresolved.

### Local smoke test

After loading the changed extension, inspect the real declaration and run a
bounded selection-only preview. With the flag absent, confirm a classification
refusal returns structured `ConsentRequired` with zero submissions. Credentials
must not be printed. This gate requires no live source upload.

### Separate, optional live validation

A successful local HTTP fixture does not validate live authentication, billing,
latency, or answer quality. A live check requires user-approved files and a Pi
process explicitly started with consent. Do not treat approval of this spec as
permission to upload source or control another process.

Start such a process only when requested, for example:

```bash
pi --continue --jev-files-allow-remote --tools read,bash,edit,write,codemode
```

Prefer one small synthetic file for transport/authentication validation.
For project-source validation, review a fresh preview and select one explicitly
approved, non-sensitive file. Use a bounded question set and one scan. Inspect
structured answers, coverage, usage, and safe errors. Read evidence separately.
If the process or branch changed, verify codemode stored values or rebuild the
request; do not depend on unverified in-memory state.

If consent or credentials are absent, record this live gate as not run.
Do not describe an attempted or refused request as successful remote validation.

### Definition of done

- R1–R7 have implementation and test evidence, or an explicit reported blocker.
- The complete review matrix has recorded results; no finding is silently lost.
- Exactly one registered tool has both accurate input variants and typed output.
- Security, coverage, resource, usage, and provider invariants are preserved.
- Documentation matches the shipped behavior and names unresolved risks.
- The final diff contains only the agreed extension and documentation changes.
- Remote validation is reported separately as passed, failed, or not run.

## 12. Deferred work

Measure real scans before adding code windows or caching. A future window result
must identify exact line ranges and source digests. Do not infer whole-file
claims from window answers without an explicit rule.

Any future cache must include content, relevant path, complete questions, model
version, and classifier options. Do not persist source by default.
A path-only relevance classifier must not become a mandatory filter: filenames
can hide relevant behavior. Fixed audits, automatic consent, a second registered
tool, and provider routing remain rejected directions, not deferred defaults.

## 13. Pre-extraction implementation review evidence

### Required changes

- R1: Preview is selection-only. Both selection variants pass; questions in
  preview and missing classification questions fail. Preview does not decode
  content, resolve models, check keys, or call the classifier.
- R2: Typed maps use `additionalProperties` with `propertyNames`. Real Pi
  `describeTool()` output compiles under strict TypeScript. Positive calls and
  negative input/answer cases verify the union and all dynamic map values.
- R3/R4: Exact paths and recursive globs admit token/style implementation and
  application OAuth/session files. Paired fixtures deny credential data,
  hidden extensionless names, case variants, and nested Pi runtime storage.
  Common data extensions beyond the original four examples stay protected.
- R5: Consent refusal names the startup flag and explains that `/reload`
  cannot grant permission. Credentials have separate `/login` and environment
  guidance. Refused calls resolve no model and submit zero bytes/requests.
- R6: Actual Pi/codemode calls validate mode separation, bad keys, question
  counts, traversal, and extra options. Local TypeSafe transport still verifies
  structured results, nested IDs, usage, storage, ranking, and follow-up.
- R7: The matrix below records review, test evidence, and untested boundaries.
  The guide states migration, exact exclusions, consent, and remaining risks.

### Matrix results

| Area | Result and evidence |
| --- | --- |
| Preview/classification/separation | Passed contract tests and actual nested calls; omitted mode remains classification |
| Declarations/runtime validation | Passed generated-declaration compilation and invalid nested calls; one codemode-only tool |
| Allowed/sensitive paths | Passed paired glob/exact fixtures and all listed sensitive data extensions |
| Discovery | Passed real-ripgrep ignore, exclusion, dotfile, ordering, duplicate, and empty-match cases; path parser reviewed |
| Safe reads | Passed external-root, file/parent symlink, mutation, and replacement cases; reviewed regular-file checks, open flags, snapshots, and handle cleanup |
| Content | Passed Unicode/BOM, byte digest, NUL, invalid content UTF-8, and oversize tests; preview does not inspect content |
| Budgets | Passed selected-file, aggregate-byte, and model-context cases; reviewed discovery byte/path caps and stop/kill paths |
| Preconditions | Passed no-consent, missing model/key, wrong provider, and pre-aborted cases with zero submission |
| Answers | Passed mixed variants, exact coverage, label/probability/score checks, and finite fractional score |
| Lifecycle | Passed controlled abort, deadline, admission, shared-capacity, ignored-abort, and permit-settlement tests; runtime replacement limitation below |
| Coverage | Passed schema and coverage equations, partial failure and empty selection; reviewed deterministic ordering |
| Usage | Passed billed errors, zero/missing/invalid usage, catalog/unknown prices, and nested totals once |
| Data exposure | Passed synthetic-source nonexposure checks across results/events; reviewed bounded provider errors and Pi-owned credentials |
| Codemode workflow | Passed preview, classification, filtering, ranking, store/load, and exact-path follow-up |
| Installation | The original Stow installation passed `dot sync`, `pi list`, and offline `pi --help`; help exposed the consent flag; no settings/MCP changes were made |

The pre-extraction strict check ran 34 tests: 33 passed and one was skipped. This macOS
filesystem rejects non-UTF-8 filenames with `EILSEQ`, so the invalid-discovery
filename fixture cannot reach ripgrep here. That test runs where the filesystem
allows the fixture. This is not evidence that the decoder branch ran locally.
Native unreadable/non-regular fixtures and full 50,000-path/4-MiB discovery
stress boundaries were reviewed in code, not exhaustively exercised here.

A local smoke preview selected `index.ts` by metadata only. Classification in
that no-consent runtime returned `ConsentRequired`: zero bytes and requests.
The real Pi integration used local synthetic transport, not TypeSafe's remote
service. Live authentication, billing, latency, and quality validation: not run.

### Findings and remaining risks

- Confirmed contract/declaration/exclusion defects were reproduced before their
  fixes. The new regressions initially failed and now pass.
- Review found that fractional cache token usage passed `isValidUsage` in
  `file-classification.ts`. A failing regression reproduced this accounting
  defect. All token fields now require nonnegative safe integers; invalid usage
  is omitted without discarding valid answers.
- Runner capacity belongs to one extension runtime. Reload creates a new runner;
  an old provider that ignores abort can still be pending. Do not reload with
  pending requests. No process-wide replacement scheduler was added.
- Native filesystem operations must settle before all handles can close.
  These checks are not a sandbox or a guarantee of immediate OS I/O cancellation.
- `npm audit` still reports one high-severity shrinkwrapped Pi
  `brace-expansion` finding. No dependency override or host patch was added.
- No paid classification or source upload was performed. Unrelated user changes,
  including the removed task-title extension, were left unchanged.

The extension/guide diff was reviewed. `git diff --check` passed. The revision
was committed and pushed as `e560e02` before package extraction. Reload only when
no request is pending; start a consent-enabled Pi process only for remote use.

## 14. Standalone package preparation

The independent `pi-jfiles` repository contains the four runtime modules,
existing tests and fixtures, strict configuration, development lockfile, and
this review record. Runtime modules and existing tests are unchanged from the
extracted revision. The tool and startup flag keep their existing names.

The standalone strict check ran 35 tests: 34 passed and the same macOS filename
fixture was skipped. The new package test builds an npm archive and checks its
exact file list. It installs the unpacked archive through Pi's CLI in a temporary
agent directory, loads it through normal package discovery, and verifies one
codemode-only tool, metadata preview, and zero-submission consent refusal.
It also checks package removal. This is local package validation, not proof of
installation from the public npm registry.

The npm archive contains runtime modules, `package.json`, `README.md`, and this
record. It excludes tests, fixtures, the development lockfile, agent instructions,
credentials, runtime state, and dependencies. A release must also contain its
confirmed license. Pi and TypeBox remain host peers; development tests use the
pinned Pi 0.99.1 SDK. The known upstream dependency advisory remains unresolved.

Local preparation ended with a private, `UNLICENSED` draft to prevent accidental
publication. No npm package or GitHub repository was published at that stage.
MIT is now confirmed for the release. Public npm installation and removal of
the original dotfiles copy are separate release validation gates. No remote
TypeSafe submission was made.

## 15. Effect runtime and Oxlint

Effect owns runtime I/O, concurrent work, deadlines, clocks, and cleanup.
TypeBox remains the public tool contract owner. The tool name, input variants,
output schema, consent rule, limits, retries, and Pi transport stay unchanged.
The internal runner and selection operations now return Effects, not Promises.

The runner keeps its explicit interface and extension-owned construction.
Pi supplies an operation-specific runtime from the current tool context.
Keep that capability value explicit; a second Context tag and Layer graph would
duplicate the existing seam for this single entrypoint. Use the built-in Effect
Clock instead of a custom clock interface. Duration uses monotonic nanoseconds,
converted to integer milliseconds. Keep pure validation and usage logic local.

Effect semaphores replace the custom request queue and scan counter.
Effect forEach replaces the worker loop. Effect races and timeoutOrElse replace
manual deadline timers and withAbort. The provider callback boundary transfers
permit ownership to the native Promise. Both settlement branches release exactly
once. Interruption aborts the provider signal but cannot release its permit.
The synchronous Effect execution at that native settlement boundary is limited
to releasing the permit. No detached provider fiber or replacement capacity is
introduced.

File handles and discovery processes use acquireUseRelease. Native handle I/O
finishes before handle cleanup. Discovery cleanup kills and awaits its child,
including spawn failure. Callback listeners are removed. Metadata operations
that Node cannot cancel may still settle after interruption; they read no source
and own no handles. Cancellation is not an OS sandbox.

Tests retain Node's runner and the real Pi SDK integration rather than adding a
second test framework. Temporal tests provide TestClock and use Deferred for
readiness. Native Promises are controlled at the actual Pi runtime seam.
Tests cover caller and Effect interruption, request and scan deadlines, queued
file coverage, shared capacity, late success and rejection, unchanged returned
results, model-resolution cancellation, missing ripgrep, and discovery-process
cleanup. Tests also verify that skipped content returns local permits.
The macOS non-UTF-8 filename limitation remains a reported skip.

Oxlint runs through the root check command. Its configuration is the rule source
of truth. Positive and negative fixtures exercise that configuration. This is
syntax/local-pattern enforcement, not type-aware analysis or proof of lifecycle
safety. TypeScript and resource tests remain separate gates.

The archive contains the same eight shipped files. Effect is an exact runtime
dependency; Oxlint is an exact development dependency. The archive test installs
runtime dependencies offline from the npm cache before loading the installed
package through Pi. Local directory packages need their dependencies installed.
The TypeScript target is ES2024, compatible with the existing Node requirement,
so native Promise.withResolvers can be used in test controls.

Verification: the strict check ran 42 tests: 41 passed and the known filename
fixture was skipped. Archive inspection and whitespace checks passed.
The dependency audit still reports one high-severity brace-expansion finding
under the pinned Pi development dependency. The runtime-only audit reports no
findings; it does not assess the separately installed Pi host. No upstream patch
was applied. No live TypeSafe request or paid source submission was made.

## 16. anti-slop policy and cleanup

The generic and all optional Effect plugins are vendored in
tools/oxlint/anti-slop. The recorded source, tests, licenses, and provenance
remain unchanged. The root Oxlint configuration owns the enabled rules.
The vendor tree stays outside application lint, typechecking, and the npm archive.

Spacing fixes were applied separately from semantic edits. Conditional object
construction now uses assignments. Absent usage remains absent, not a property
set to undefined. Lint subprocess failures use TypeBox checks. The local HTTP
fixture checks the address object returned by Node.

The internal classifier accepts the TypeBox-derived input union. It still calls
the parser before filesystem or provider access. Static types cannot enforce
portable paths, strict objects, reserved keys, or payload byte limits. Raw parser
input remains unknown, with one documented line-scoped lint exception. No cast,
duplicate schema, or second parser was added. Tests cover schema-shaped invalid
requests and positive and negative TypeScript calls through this interface.

The scan-deadline test also provides TestClock to its follow-up scan. That scan
previously used a real 20 ms deadline and could fail under filesystem load.
The test now checks the follow-up duration with the controlled clock.

Verification: npm run check passed 44 tests, with the known macOS filename
fixture skipped. All 24 vendored rule test files passed. Whitespace and archive
checks passed; the archive still contains eight files and excludes local tooling.
The runtime-only dependency audit is clean. The existing high-severity Pi
development-dependency finding remains. No live TypeSafe request was made.
