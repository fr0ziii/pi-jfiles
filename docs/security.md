# Security

These controls reduce accidental source disclosure. They are not secret
detection or an OS sandbox. See [README.md](../README.md) for the exact selection
rules and [architecture.md](architecture.md) for resource ownership.

## Consent and credentials

Remote classification requires --jev-files-allow-remote at Pi process startup.
An API key, a tool argument, settings, or /reload cannot grant this permission.
For a valid classification request, consent is checked before model resolution,
credential access, discovery, source reads, or submission. Refusal returns
ConsentRequired with zero requests and submitted bytes.

Preview is local and metadata-only. It needs neither consent nor credentials.
Pi owns authentication and transport. The extension checks credential
availability through Pi; it does not copy credentials or read auth.json itself.

The classifier verifies the fixed provider, model, and classifier API. That
identity check does not prove that a locally overridden provider endpoint is
trustworthy. Review provider overrides before remote use.

## Data flow

A provider request contains the relative path, whole file content, the
untrusted-project-file source marker, and caller questions. Project content is
evidence, not extension instructions. It cannot change selection, consent,
limits, or provider options and is never executed by the extension.

Results and diagnostics contain no scanned source, credentials, provider
response bodies, or raw causes. Diagnostics use bounded allowlisted messages.
Paths, digests, questions, and answers can still be sensitive. Codemode storage
and Pi session records follow Pi's retention rules.

## Selection safeguards

Discovery is rooted at the real path of the current working directory.
Requests cannot select another root. Ripgrep preserves ignore rules and uses
bounded NUL-separated discovery. Exact paths cannot bypass ignore rules or
exclusions.

Paths are portable relative paths. Absolute paths, drive prefixes, traversal,
empty components, controls, backslashes, and invalid UTF-8 discovery paths are
rejected. Exact-path entries are literal filenames. Globs support the restricted
syntax documented in README.md; braces and extglobs are rejected.

One exclusion policy governs discovery pruning, selection, and read eligibility.
It excludes dependency and generated directories, credential files, private
keys, and known Pi runtime storage. Sensitive filename checks ignore case.
Application OAuth and session directories remain eligible. For example,
src/styles/tokens.css and src/lib/credentials.ts can be selected, while
config/access-tokens.json and credentials.toml are excluded.

Filename exclusions do not detect embedded secrets. Eligible source may still
contain secrets. Design-token data files can also match sensitive-name rules.
There is no caller-controlled exclusion bypass.

## Source-read safeguards

Classification checks these conditions before accepting source:

- The selected snapshot belongs to the current real project root.
- Every path component is checked for symlinks before and after the read.
- The file is opened with O_RDONLY, O_NOFOLLOW, and O_NONBLOCK and is regular.
- Device, inode, size, modification time, and change time agree with the selected
  snapshot and final pathname.
- Bounded reads reject growth and oversized content without truncation.
- NUL bytes and invalid UTF-8 are rejected. Unicode paths and UTF-8 BOM content
  retain their identity. SHA-256 uses the original bytes.
- Handles close on success, failure, and interruption.

File-count and aggregate-byte limits fail before upload. Estimated context
overflow skips a file without submission. Preview does not decode content and
cannot guarantee that a later read sees the same file.

## Remaining risks

- Filesystem races are reduced, not eliminated. Hostile concurrent changes
  require stronger isolation than this extension supplies.
- Native filesystem operations may need to settle before cleanup can finish.
  Cancellation does not guarantee immediate OS I/O cancellation.
- A provider that ignores abort retains its request permit until settlement.
  Reload creates a new runner, so do not reload while requests are pending.
- Model answers and confidence are evidence, not proof. They cannot establish
  cross-file correctness or complete test coverage.
- Uploads can incur cost. Attempted requests and reported usage do not establish
  exact provider billing.
- The pinned Pi development installation includes a shrinkwrapped
  brace-expansion@5.0.9 high-severity denial-of-service advisory. Rejecting brace
  globs does not patch Pi. Recheck audits and update Pi when a corrected release
  is available. A clean runtime-only audit does not assess the separately
  installed Pi host.

## Live validation

Routine checks use synthetic files and credentials with local transport.
Live TypeSafe validation requires separate approval and an explicitly
consent-enabled process. Approve the files and scope before submission.
Local integration checks do not establish live authentication, billing,
latency, or answer quality.
