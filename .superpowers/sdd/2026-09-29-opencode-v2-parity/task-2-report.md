# Task 2 implementation report

## Changes

- Added `opencode-dependencies.cjs`, exporting `discover(options)` and `collectConfig(document, source, context)` while guarding its CLI from normal `require()`.
- Discovery parses JSON/JSONC only as data, resolves plugin and skill paths against their required bases, collects `{file:...}` references, scans relevant roots for symlinks with realpath cycle protection, deduplicates normalized records, and emits path-only four-field TSV.
- Validation and CLI failures avoid configuration contents; file references remain read-only even when deduplicated with other records. Optional global skills roots and required config roots are represented explicitly.
- Added `tests/opencode-dependencies.test.cjs` coverage for JSONC, CLI output/errors, plugin forms and package kinds, path bases, skill roots, malformed data, path delimiters, deduplication, symlinks, and inert command strings.
- Copied the helper into `/usr/local/lib/agentbox/opencode-dependencies.cjs` in the root-owned Dockerfile copy section. No host runtime dependency or runtime probe/mount integration was added.

## RED evidence

- Before implementation, `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/opencode-dependencies.test.cjs` failed as expected with `Cannot find module '../opencode-dependencies.cjs'`.
- Added malformed plugin cases; the focused test failed with `Missing expected exception` for null/empty plugin declarations. Validation was tightened, and the focused suite then passed.
- During test development, corrected two fixture assumptions: duplicate aggregation belongs to `discover()` rather than `collectConfig()`, and the skipped-directory rule means testing a symlink that is itself the `node_modules` entry rather than a symlink nested inside it.

## GREEN and final checks

- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/opencode-dependencies.test.cjs` — 15 tests passed.
- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs` — 25 tests passed (10 existing, 15 new).
- `node --check opencode-dependencies.cjs` — passed.
- `git diff --check` — passed.
- No image build or runtime probe/mount integration was attempted; those are outside Task 2.

## Commits

- `c8727a2a2f0ef05dee18a2952a77fa98044b8c58 feat: discover OpenCode filesystem dependencies safely` — helper, tests, Dockerfile copy.
- Report commit: `docs: record Task 2 implementation and verification`.

## Concerns

- Docker image build and end-to-end mount integration remain unverified by design and are assigned outside this task.
- Jev review selection covered all three implementation paths; no reviewers were launched, consistent with the task's no-reviewer instruction. Independent review remains with the controller.

## Fix round 1/5

### Review findings addressed

1. Each relevant config document is inspected with `lstat`; config symlink targets are emitted and their link chains are inspected with a visited-path set. Cycles and dangling targets terminate, including project and ancestor config files, without scanning ancestor directories.
2. Scan roots are metadata-inspected before traversal. Regular files are terminal; directory descent occurs only for directories. Symlink file roots and chains emit path records without reading file contents. Directory-root symlink cycles terminate.
3. Home/config/project/scan inputs and collector source paths are validated as absolute, delimiter-safe paths before filesystem operations. Filesystem metadata failures use the fixed `Filesystem metadata failed:` category and a sanitized path. Invalid configuration and file-URL failures use safe source-path errors without raw parser/config values.
- Also strengthened the mount collision assertion: a `{file:...}` reference colliding with a writable root is represented as `file`/`ro`; internal symlink records satisfied by a mounted root are not duplicated.

### RED evidence

- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/opencode-dependencies.test.cjs` — new regressions failed before the fixes: config-file chains/cycles were absent, file scan roots threw `ENOTDIR` from `readdirSync`, delimiter paths did not fail safely, and malformed-config errors exposed a newline-containing source path.
- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test --test-name-pattern='invalid file URLs' tests/opencode-dependencies.test.cjs` — failed as expected with raw `ERR_INVALID_FILE_URL_HOST` rather than the sanitized source path.
- One initial symlink-config fixture expected a relative plugin path based on the resolved target; corrected it to the established defining-document lexical path base, then the regression passed.

### GREEN and final checks

- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/opencode-dependencies.test.cjs` — 21 tests passed.
- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs` — 31 tests passed (10 existing, 21 discovery tests).
- `node --check opencode-dependencies.cjs` — passed.
- `git diff --check` — passed.
- Regression output confirms CLI metadata failures produce empty stdout and a sanitized `Filesystem metadata failed: <path>` stderr line; no credential fixture contents appear in manifests/errors.
- No image build, host config change, runtime integration, or later task was performed.

### Fix commits

- `0d44c0ed097d7a4e80f3c48a81926d65c77bad74 fix: close OpenCode config symlink metadata safely` — discovery and regression tests.
- Report update commit: `docs: record Task 2 fix round 1`.

### Remaining concerns

- Image build and runtime probe/mount integration remain outside Task 2 and were not verified.
