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
