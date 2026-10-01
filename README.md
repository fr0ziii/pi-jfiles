# pi-jfiles

Publication is pending a license choice. The package is marked private until
that choice is confirmed; the install command below is the release target.

Ask task-specific questions about whole project files through Pi codemode.
The extension returns paths, typed answers, and coverage. It does not return
source text. Read selected files separately to inspect the evidence.

## Setup

Requirements: Pi 0.99.1 or later, Node.js 24.8.0 or later, and ripgrep on PATH.

Install the npm package through Pi:

```bash
pi install npm:pi-jfiles
pi update --models
pi --tools read,bash,edit,write,codemode
```

Run `/reload` in an existing Pi session. If codemode is not active, add
`"+codemode"` to the existing `defaultTools` array in Pi settings, or use
the CLI tool list above. `pi install` records the package in Pi settings;
it does not enable codemode or grant upload permission.

If an older local copy is loaded, remove that copy before loading this package.
Both copies register the same tool and consent flag. Keep only one active copy.

The model is fixed to `typesafe/jev-latest` with API
`typesafe-system-one`. There is no provider fallback or model selection flag.
Use `/login` to configure the TypeSafe API key through Pi, or supply
`TYPESAFE_API_KEY` through your local environment. Do not commit credentials.

Preview works without credentials or upload consent. To permit classification,
start a new Pi process with explicit consent. `/reload` cannot grant this
startup permission, and an API key is not upload permission:

```bash
pi --jev-files-allow-remote --tools read,bash,edit,write,codemode
```

**This flag permits remote source submission for the process.** Each request
sends the relative path, whole file content, and all questions to TypeSafe
through Pi. Review the selected paths before classification. Embedded secrets
can exist in ordinary source files; filename exclusions are not secret detection.
Source consumes classifier context and can incur cost. Pi owns the transport and
credentials. Review any local TypeSafe provider overrides before use.

## Preview, then classify

Run this in codemode:

```js
const selection = {
  kind: "globs", include: ["src/**/*.ts"], exclude: ["**/*.test.ts"]
};
const preview = await tools.classify_files({ mode: "preview", selection });
store("billingSelection", selection);
text({ status: preview.status, files: preview.files, error: preview.error });
```

Preview accepts selection only. It needs no questions, credentials, or consent.
It reports metadata and does not read source content or call TypeSafe. Binary
and invalid UTF-8 content can pass preview; classification checks content later.
After review, in a process with upload consent, run:

```js
const selection = load("billingSelection");
if (!selection) throw new Error("Run the preview script first.");
const request = {
  mode: "classify",
  selection,
  questions: {
    prorating: {
      type: "bool",
      instructions: "Does this file calculate prorated subscription charges?",
      criteria: {
        true: "Calculates charges for partial billing periods",
        false: "Does not calculate prorated charges"
      }
    }
  }
};
const scan = await tools.classify_files(request);
store("billingScan", scan);
const candidates = scan.files.filter(file =>
  file.status === "classified" &&
  file.answers.prorating?.type === "bool" &&
  file.answers.prorating.probability >= 0.8
);
text({
  status: scan.status, summary: scan.summary, error: scan.error,
  candidates: candidates.map(file => ({
    path: file.path, probability: file.answers.prorating.probability
  }))
});
```

One tool has two input variants. `mode: "preview"` requires selection and rejects
questions. Classification requires questions; omitted mode remains classification
for existing callers. Old previews that spread a classification request must now
pass selection only. There is no separate preview tool or consent argument.

Preview is not a frozen source snapshot. Classification repeats selection and
read checks. If the process or branch changed, check stored values or repeat the
preview. Do not rely on unverified in-memory state. Check coverage before you
interpret findings. A follow-up can use exact paths and different questions:

```js
const scan = load("billingScan");
const paths = scan.files.filter(file =>
  file.status === "classified" &&
  file.answers.prorating?.type === "bool" &&
  file.answers.prorating.probability >= 0.8
).map(file => file.path);
if (paths.length > 0) {
  const followup = await tools.classify_files({
    mode: "classify",
    selection: { kind: "paths", paths },
    questions: {
      duration: {
        type: "choice",
        instructions: "Which time basis is visible in the prorating calculation?",
        criteria: {
          calendar: "Uses calendar period boundaries",
          fixed: "Uses a fixed number of days or seconds",
          other: "Another basis, or not visible in this file"
        }
      }
    }
  });
  text(followup);
}
```

Exact paths are not glob patterns. An empty path list is invalid.
Use `searchTools("classify_files")` or `describeTool("classify_files")`
if the tool is not in codemode's inline declaration.

## Several questions per file

Questions are caller-defined. For example, inspect authorization placement
without declaring the code defective:

```js
const scan = await tools.classify_files({
  mode: "classify",
  selection: { kind: "globs", include: ["src/**/*.ts"] },
  questions: {
    authorization: {
      type: "bool",
      instructions: "Does this file visibly check permission before a protected operation?",
      criteria: {
        true: "An explicit permission check precedes a protected operation",
        false: "No such check is visible in this file"
      }
    },
    layer: {
      type: "choice",
      instructions: "What role does this file have?",
      criteria: {
        domain: "Domain rules or calculations",
        adapter: "HTTP, database, or runtime integration",
        other: "Another role, mixed roles, or insufficient evidence"
      }
    },
    coupling: {
      type: "score",
      instructions: "Rate visible runtime coupling.",
      criteria: [
        "No runtime-specific dependency",
        "Some runtime-specific dependency",
        "Runtime-specific dependencies throughout"
      ]
    }
  }
});
text({ status: scan.status, summary: scan.summary, files: scan.files });
```

Each file gets all questions in one request. Boolean answers contain
`probability` between 0 and 1. Choice answers contain `choice`, a probability
map, and `confidence`. Score answers contain `score` and `confidence`;
the score uses zero-based criteria positions and can be fractional.
The extension does not apply thresholds or rank files.

File-level answers cannot prove a cross-file bug, authorization correctness,
or missing tests. Confidence is evidence, not proof. Use deterministic search
for literal text such as TODO comments.

## Results and limits

The schema version is 1. Scan statuses are `complete`, `partial`, `preview`,
and `failed`. File statuses are `classified`, `preview`, `skipped`,
`failed`, and `unprocessed`. Skipped or failed files have reasons, not
fabricated negative answers. Classified files include SHA-256 content digests.

The selected count equals the number of file outcomes and the sum of outcome
counts. Globs do not select ignored or pruned paths. Other denied glob matches
and denied exact paths are reported as skipped. Ignored or missing exact paths
are `not-eligible`. Discovery counts are not the total number of files on disk.
An empty glob match is a successful empty scan. Scan-level failures return
structured diagnostics and mark the tool result as an error. Pi can reject
malformed arguments before execution; those failures are not scan results.

| Resource | Limit |
| --- | --- |
| Selected files | 200 |
| Source per file | 64 KiB |
| Total eligible source per scan | 5 MiB |
| Questions | 1–8 |
| Serialized questions | 16 KiB |
| Instructions per question | 2,000 characters |
| Choice criteria | 2–32 |
| Score criteria | 2–10 |
| Include or exclude globs | 32 each |
| Path length | 1,024 characters |
| Discovery | 50,000 paths / 4 MiB output |
| Active scans | 2 |
| Outstanding classifier requests across scans | 4 |
| Request deadline | 30 seconds |
| Scan deadline | 120 seconds |

Requests cannot raise these limits. File-count and aggregate-size violations
fail before upload. Oversized files are skipped, never truncated. Context
checks use a conservative serialized-byte estimate, not exact tokenization.
Each request has zero automatic retries.

Discovery preserves ripgrep ignore rules. Globs support `*`, `**`, `?`,
and character classes, but not braces or extglobs. Ordinary `**/*.ts` does
not match dotfiles; select them explicitly, for example `**/.*.ts`.
Selection rejects absolute paths, traversal, control characters, and backslashes.

Dependencies and generated directories are excluded, as are `.ssh`, `.aws`,
`.env*`, `auth.json`, private key names, `.netrc`, `.npmrc`, `.pypirc`, and
`.pem`, `.key`, `.p12`, `.pfx`, and `.keystore` files. `.DS_Store` and
`herdr-agent-state.ts` stay excluded. Sensitive filename checks ignore case.

Delimiter-matched `credentials`, `secrets`, and `tokens` names are excluded
when extensionless, including hidden names, or ending in `.json`, `.jsonc`,
`.toml`, `.yaml`, `.yml`, `.ini`, `.cfg`, `.conf`, `.txt`, `.csv`, `.xml`,
`.properties`, `.log`, or `.bak`.
Thus `config/secrets.json` and `config/access-tokens.json` are excluded, but
`src/styles/tokens.css`, `src/lib/tokens.ts`, and `src/lib/credentials.ts`
are eligible unless another rule excludes them. Design-token JSON files can
still be excluded. No filename rule proves that an eligible file is safe.

Pi runtime storage under `.pi/{sessions,oauth,npm,bin,logs}/` and
`.pi/agent/{sessions,oauth,npm,bin,logs}/` is excluded at any project depth.
Application directories such as `src/oauth/` and `src/sessions/` are not excluded
only because of their names. Hard credential and runtime rules take precedence;
a source extension cannot bypass them.

Reads reject symlinks, non-regular files, NUL bytes, invalid UTF-8, and changed
file snapshots.
These checks reduce accidental disclosure; they are not an OS sandbox against
hostile concurrent filesystem changes.

Capacity limits belong to one extension runner. Do not reload while requests
are pending: reload creates a new runner, and an old provider that ignores abort
can still have outstanding work. Native filesystem operations also need to
settle before their handles can close; cancellation is not an OS I/O sandbox.

Cancellation stops new work. If a provider ignores cancellation, its request
permit stays occupied until its promise settles. Late usage after a deadline
cannot be added to an already returned result. Request and submitted-byte counts
record attempted submissions, not proof of provider acceptance or billing.
Usage availability is `complete`, `partial`, or `none`. Valid reported usage includes billed
error responses and reaches Pi session totals once. Zero catalog prices are
reported as unknown, not as free service.

Results contain no source, but paths and findings can still be sensitive.
Codemode storage and Pi session records follow Pi's own retention rules.

## Development

```bash
git clone https://github.com/fr0ziii/pi-jfiles.git
cd pi-jfiles
npm ci --ignore-scripts
npm run check
npm audit
npm pack --dry-run --ignore-scripts
```

Pi and TypeBox are host peer dependencies, not bundled runtime dependencies.
Tests use temporary projects, real ripgrep, and the real Pi codemode path.
A local HTTP fixture exercises Pi's TypeSafe classifier transport with synthetic
source and credentials. Tests inspect real codemode declarations, compile valid
and invalid caller examples, and check runtime validation. Routine checks do
not call the remote provider. A package test packs the shipped files, installs
the unpacked package with Pi in a temporary agent directory, and checks preview
and no-consent refusal through codemode. Live authentication, billing, latency,
and answer quality remain separate opt-in checks.

The npm archive contains the four runtime TypeScript modules and documentation.
Tests, fixtures, the development lockfile, and configuration stay in the source
repository. See the [design and review record](docs/jev-file-classification-plan.md)
for module ownership, verification evidence, and remaining risks.

The Pi 0.99.1 peer dependency has a shrinkwrapped `brace-expansion@5.0.9`
dependency with a high-severity denial-of-service advisory. `npm audit fix`
does not replace it. This extension rejects brace globs but does not patch Pi.
Update the upstream Pi dependency when a corrected release is available.
