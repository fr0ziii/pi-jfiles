# pi-jfiles

This repository contains one Pi extension. The runtime modules are at the
repository root. Read `README.md` for installation and use. Read
`docs/jev-file-classification-plan.md` when changing contracts, selection rules,
resource ownership, or verification requirements.

## Changes

- Use plain TypeScript and schema-derived types.
- Keep `classify_files` as the only registered tool, with codemode exposure.
- Use Pi for model discovery, credentials, and TypeSafe transport.
- Preserve the startup-only `--jev-files-allow-remote` permission.
- Keep preview local and independent of questions and credentials.
- Keep source text and credentials out of results, diagnostics, and Git.
- Use synthetic source and credentials in tests. Live provider checks need
  separate approval and can incur cost.
- Keep runtime modules in the npm file list. Keep tests and fixtures in Git.
- Use Simplified Technical English in documentation.

## Checks

Run `npm run check` and `git diff --check`. After package content changes,
inspect `npm pack --dry-run --ignore-scripts`. Report dependency audit findings
separately; passing tests do not establish dependency safety.
