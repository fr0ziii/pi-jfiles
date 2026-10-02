# pi-jfiles

This repository contains one Pi extension. Runtime modules are in `src/`.
Tests and fixtures are in `tests/`. Read `README.md` for installation and use.
Read `docs/architecture.md` when changing contracts, module ownership,
concurrency, or cleanup. Read `docs/security.md` when changing selection, source
reads, consent, or diagnostics. Read `docs/development.md` when changing checks,
dependencies, or packaging.

## Changes

- Use Effect for runtime I/O, concurrency, deadlines, clocks, and cleanup.
  Keep Promise conversion at Pi and native API boundaries. Keep pure logic in
  TypeScript. Use the pinned Effect version and inspect its APIs before changes.
- Keep TypeBox as the tool contract owner and derive public types from it.
  Use typed Effect errors for expected failures; keep raw causes private.
- Keep provider permits until the underlying Promise settles, including after
  interruption. Use Effect TestClock and explicit readiness signals in tests.
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
