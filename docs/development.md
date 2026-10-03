# Development

Read [architecture.md](architecture.md) before changing module ownership or
resource lifecycle. Read [security.md](security.md) before changing selection,
source reads, consent, or diagnostics. [README.md](../README.md) describes use;
[CONTEXT.md](../CONTEXT.md) defines the domain language.

## Local setup

Use the platform requirements and dependency versions in package.json.
Ripgrep must be on PATH.

```bash
npm ci --ignore-scripts
npm run check
git diff --check
```

Runtime modules are in src/. Tests and synthetic fixtures are in tests/.
Keep runtime changes on the pinned Effect APIs. TypeBox owns tool contracts.
Promise conversion belongs at Pi and native API seams.

Editing this checkout does not update an installed npm copy. Local directory
installs need dependencies installed first; Pi installs runtime dependencies for
npm packages. Publish a new version before updating the npm installation.
Keep only one active copy of the extension.

## Naming

Use the shortest name that is clear at a call site and unique in a project
search. CONTEXT.md owns domain terms. A Scan is the complete operation; a
Classification is model-produced evidence about one project file. Keep Question
and Answer distinct from the criteria that define them.

Types use PascalCase, operations use verb-object camelCase, module files use
kebab-case, and fixed limits use UPPER_SNAKE_CASE. Use Input for caller arguments
and Result for returned data. Reserve request terminology for provider transport.
Keep file paths and the registered classify_files name unchanged.

### Naming migration

Direct TypeScript imports must use the new symbols below. This is a source-level
change, not a change to the version 1 tool contract. There are no legacy aliases.

| Previous symbol | Current symbol |
| --- | --- |
| FileClassificationInput | ScanInput |
| FileClassificationRequest | ClassifyInput |
| FileClassificationOutput | ScanResult |
| FileClassificationOutcome | FileResult |
| FileScanError | ScanError |
| fileClassificationInputSchema | scanInputSchema |
| fileClassificationRequestSchema (private) | classifyInputSchema (private) |
| fileClassificationOutputSchema | scanResultSchema |
| fileClassificationAnswersSchema | answersSchema |
| parseFileClassificationInput | parseScanInput |
| SelectedSourceFile | SelectedFile |
| SourceSelection | SelectedFiles |
| selectSourceFiles | selectFiles |
| readSelectedSource | readSelectedFile |
| isExcludedSourcePath (private) | isExcludedFilePath (private) |
| testRequest (test fixture) | testScanInput (test fixture) |

Failure modes to check before validating a naming change:

- Imports, type-only uses, or embedded test scripts retain an old symbol.
- Schema-derived input or result types lose precision or accepted input variants.
- Schema keys, status values, diagnostics, consent flags, or provider fields change.
- Effect span names no longer match renamed operations.
- Documentation uses two names for one concept or describes classifications as
  verified findings.
- Runtime modules or required documents disappear from the npm archive.

Use the existing compiler contract checks, parser checks, Pi codemode E2E, and
package installation E2E. Compare serialized schema fingerprints before and
after the migration. Naming-only changes do not need new unit tests or generated
property cases; the accepted values and invariants are unchanged.

## Verification

npm run check runs lint, typechecking, and project tests. Its success establishes
those checks only, not dependency safety or live provider behavior.

| Tests | Verify |
| --- | --- |
| file-classification-contract.test.ts | Reserved keys, label boundaries, portable paths/globs, question criteria and byte limits |
| file-selection.test.ts | Real ripgrep, exclusions, metadata-only preview, safe reads, budgets, child cleanup |
| file-classification.test.ts | Answers, coverage, usage, consent ordering, deadlines, shared capacity, cancellation |
| codemode-integration.test.ts | Real Pi registration, generated declarations, nested calls, local TypeSafe transport |
| lint-policy.test.ts and anti-slop-policy.test.ts | Accepted and rejected fixtures through the root lint configuration |
| package-installation.test.ts | Exact archive contents, isolated Pi installation, preview, consent refusal, removal |

The Pi E2E tests own ordinary input variants, multi-question classification,
path follow-up, tool declarations, local transport, and installed-package use.
Do not repeat those scenarios in parser-only tests.

### Failure inventory for retained focused checks

These checks cover failures that the current E2E scenarios do not exercise:

- Request validation: reserved question and choice keys, label boundaries,
  incomplete criteria, unsafe paths/globs, and aggregate question bytes.
  The runner must also reject invalid input before discovery or submission;
  Pi can reject E2E input before it reaches that boundary.
- Classifier responses: missing/extra answers, wrong answer types, invalid
  probabilities or choice distributions, out-of-range scores, fractional scores,
  provider errors/throws/aborts, context overflow, and leaked error payloads.
- Accounting and contracts: duplicate-path submissions, source alteration,
  retries, missing digests/signals, incomplete coverage, billed errors, absent
  versus zero/invalid usage, unknown versus catalog pricing, and widened runner
  input or Effect result types.
- Runtime lifecycle: excess active scans or requests, cancellation before or
  during model resolution, premature or missing permit release, deadlines that
  wait for ignored aborts, omitted queued outcomes, late result mutation, direct
  Effect interruption, and incorrect elapsed time. Controlled clocks and native
  Promise settlement expose these failures without live-provider timing.
- File selection and reads: missing ripgrep, child cleanup after cancellation,
  ignore/exclusion bypass, overbroad credential rules, content reads in preview,
  symlink escape, cross-root or stale snapshots, oversized/binary/invalid UTF-8
  source, Unicode/BOM corruption, incorrect digests, empty matches, invalid path
  encoding, and exceeded file/byte budgets. Reader-interface checks control the
  change between selection and read; ordinary E2E scans do not.
- Lint policy: missing rules, wrong diagnostics, or rejection of supported
  syntax. These checks run the real CLI with the root configuration; extension
  E2E execution does not check development policy.

Temporal tests use Effect TestClock, Deferred readiness signals, and controlled
native Promises. Keep follow-up operations on the controlled clock when a short
deadline is part of the test. Test both late success and rejection; neither may
release capacity before settlement or mutate returned results.

Tests use temporary projects and agent directories. They must leave user
settings unchanged and keep synthetic source and credentials out of results.
On macOS, the filesystem can reject the invalid-UTF-8 filename fixture before
discovery. Report that skip instead of claiming its decoder branch was tested.

## Lint tooling

The root .oxlintrc.json owns lint policy. Generic anti-slop and optional Effect
rules are vendored under tools/oxlint/anti-slop/. Oxlint checks syntax and local
patterns, not TypeScript inference or lifecycle safety.

Keep Oxlint and @oxlint/plugins pinned to the same exact version. Vendor code
stays outside application lint, typechecking, and the npm archive. Preserve its
source, tests, licenses, and provenance. In the source checkout, follow
tools/oxlint/anti-slop/UPSTREAM.md for updates and separate vendor verification.
Upstream CLI tests need the documented temporary npm adapter,
not a second package-manager lockfile.

Raw input at the TypeBox parser stays unknown. Its line-scoped exception records
that input still needs validation. Use schema-derived types after that owner;
casts, renamed parameters, and global rule disables are not substitutes.

## Package inspection

After changing shipped files or package metadata, run:

```bash
npm pack --dry-run --ignore-scripts
```

--dry-run lists the archive that npm would create without creating or publishing
it. --ignore-scripts skips lifecycle hooks during inspection. Check the file
list, not just the exit code.

Confirm that runtime modules, documentation, the manifest, and the license are
included. Keep tests, fixtures, vendored tooling, development configuration,
credentials, runtime state, and node_modules out of the archive. package.json
owns the included paths. Update the exact archive assertion in
tests/package-installation.test.ts when intended contents change.

That test creates a real archive, installs its runtime dependencies offline from
the npm cache, and loads it through Pi in an isolated agent directory. This
verifies more than the dry-run, but does not establish public-registry
installation or live provider behavior.

## CI and npm releases

.github/workflows/ci.yml runs checks on pull requests and pushes to main.
Both CI and release verification use Node.js 24, locked dependencies, and
ripgrep on Ubuntu. They run lint, typechecking, tests, package inspection, and a
blocking runtime dependency audit. A separate full dependency audit also checks
development dependencies and blocks both workflows on reported vulnerabilities.
Read both audit outputs; passing tests do not establish dependency safety.

.github/workflows/release.yml runs only when a GitHub Release is published.
Pushing a tag or saving a draft does not publish to npm. Verification checks the
release tag, package.json, both lockfile version fields, and the GitHub prerelease
flag. It runs all checks again at the release commit, then stores an archive and
its SHA-256 fingerprint.

Only the publish job has OIDC permission. It downloads that exact artifact by
ID and checks its fingerprint. It does not check out source or run project
scripts. npm trusted publishing uses a short-lived identity, not an NPM_TOKEN
secret. The publication includes provenance. Stable versions use latest;
prereleases use next and cannot replace latest through this workflow.

### One-time setup

1. Create the npm GitHub environment in fr0ziii/pi-jfiles. Restrict it to v* tags
   and configure required reviewers for publication approval.
2. In the pi-jfiles package settings on npm, add a GitHub Actions trusted
   publisher with these exact values:
   - Organization or user: fr0ziii
   - Repository: pi-jfiles
   - Workflow filename: release.yml
   - Environment name: npm
   - Allow direct publishing with npm publish.
3. Protect release tags with a repository ruleset. Keep all workflow actions
   pinned to reviewed commit SHAs and update their version comments together.

Trusted publisher settings belong to an existing npm package. If the package
does not yet exist, a maintainer must make the first publication with interactive
npm authentication, then configure trusted publishing. Do not put that credential
in the repository or workflow. These account settings cannot be applied by a
workflow file alone.

### Publish a version

Commit the intended changes first. Update the manifest and lockfile together:

```bash
npm version patch --no-git-tag-version
npm run check
version="$(node -p 'require("./package.json").version')"
git add package.json package-lock.json
git commit -m "Release v$version"
git tag -a "v$version" -m "Release v$version"
git push origin main
git push origin "v$version"
```

Create a GitHub Release for that tag and publish it. The tag must be v followed
by the exact manifest version. For a version such as 0.2.0-beta.1, mark the
GitHub Release as a prerelease. Do not use build metadata in npm release versions.

Wait for the publication to finish before publishing another GitHub Release.
The workflow serializes releases and never cancels an active publication, but
GitHub can replace an older pending run. Approve the npm environment deployment
when GitHub requests it.

If a run fails, inspect verification, audit, environment, and trusted publisher
logs. If registry publication may have succeeded, check npm before retrying.
Published npm versions cannot be overwritten. Do not move an existing release
tag; release a new version for a correction. Re-running a failed publish job uses
the stored artifact, which is retained for seven days.

References: [GitHub Actions practices](https://github.com/github/awesome-copilot/blob/main/instructions/github-actions-ci-cd-best-practices.instructions.md),
[pi-subagents workflows](https://github.com/nicobailon/pi-subagents/tree/main/.github/workflows),
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Dependency updates

.github/dependabot.yml checks npm daily and groups available updates for
@earendil-works/pi-* in one pull request. It updates the exact development pins
and package-lock.json. The increase-if-necessary strategy preserves peer ranges
when they already permit the new version. Peer requirements and README.md state
the oldest supported Pi version, not necessarily the latest test version.

Review each update before merging, including major releases. Keep both Pi
development packages on compatible releases. There is no automatic merge rule.
Require the CI check through GitHub branch protection or a repository ruleset;
the Dependabot file alone does not enforce that requirement or human review.

Check these failure modes when changing dependency automation:

- YAML cannot be parsed or supported settings are missing.
- Allow or group patterns miss a Pi package or include unrelated packages.
- Manifest pins and lockfile entries disagree, or peer minimums rise without
  a compatibility decision and matching README requirements.
- A Pi SDK or CLI change breaks codemode, preview, consent, or package loading.
- Audit failures are ignored, or a new dependency advisory blocks CI.
- An update changes shipped files or includes configuration in the npm archive.

Validate the YAML and matching dependency names locally. Run typechecking,
existing codemode and package installation E2E tests, both dependency audits,
and package inspection. GitHub must validate the actual scheduled Dependabot
run and required-check settings after the configuration reaches the default
branch. This automation does not update a separately installed Pi host.

## Dependency audits

Run and report dependency checks separately from correctness checks:

```bash
npm audit
npm audit --omit=dev
```

The first checks the installed development tree too. The second scopes the audit
to runtime dependencies; it does not cover a separately installed Pi host.
Report package, severity, affected scope, and remediation status. Tests can pass
while a dependency has a known advisory. An empty audit also is not proof that
all vulnerabilities are known or absent.

Disclosure limits and host dependency risks are in security.md.
Review dependency changes rather than applying audit fixes blindly. Live
provider checks require separate approval as described there.
