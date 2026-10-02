# anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop
Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`

The complete upstream `src/` tree is copied to this directory, including rule
tests and the nested ESLint Stylistic license and provenance. The upstream root
MIT license is copied as `LICENSE`.

Entry points:

- Generic rules: `index.ts`
- Optional Effect rules: `effect/index.ts`

The project registers both plugins in its root `.oxlintrc.json`. Oxlint and
`@oxlint/plugins` are exact development dependencies at version 1.86.0.
This directory is local development tooling and is not in the npm archive.
It is excluded from application lint. The application TypeScript check covers
`src/` and `tests/`, not this vendored tree.

## Local changes

No upstream source or rule tests were modified. This record and the copied
root license are the only additions to the upstream source tree. Project lint
configuration is not an upstream source modification.

## Updates

Retrieve the recorded commit for the original snapshot. Stage incoming source
separately and review changes before merging. Preserve local customizations,
both licenses, and the nested provenance record. Keep dependency versions paired.
Verify plugin loading, root policy fixtures, and upstream rule tests separately
from application lint. Upstream CLI tests invoke `pnpm exec oxlint`; this project
uses npm. Run that CLI test with a temporary executable adapter that forwards only
this command to the installed Oxlint binary. Direct pnpm execution can install
dependencies and create a second lockfile.

## Verification notes

The upstream entry points pass TypeScript 5.9.3 with strict checking. Adding
`noUncheckedIndexedAccess` reports an upstream indexed-access error in
`shared/dictionary-types.ts`. Keep this finding visible; do not silently rewrite
the vendored rule or include the vendor tree in the application compiler scope.
