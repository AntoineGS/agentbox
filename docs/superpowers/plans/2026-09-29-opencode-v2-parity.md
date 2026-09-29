# OpenCode V2 Host Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentBox run the user's complete OpenCode V2 setup, remove ocv, and retain Claude support.

**Architecture:** Keep the existing ephemeral-container and bind-mount architecture. A small Node helper discovers configuration dependencies as data; Bash validates and mounts them, selects a matching OpenCode release, and launches a private container server with host networking and Herdr context. Host config/auth/history remain shared; runtime state and cache do not.

**Tech Stack:** Bash 4+, Debian Dockerfile, existing NVM/Node LTS, official `@opencode/cli`, `jsonc-parser@3.3.1`, Node's built-in test runner, Docker/Podman, ShellCheck.

**Spec:** `docs/superpowers/specs/2026-09-29-opencode-v2-parity-design.md`

## Global Constraints

- "Full host parity, not just a stock OpenCode installation."
- "Host networking, rather than a Meridian-only relay."
- "Selective filesystem mounts, not the entire host home directory."
- "Shared OpenCode configuration, authentication, and session history, with separate container service state."
- "Removal of `ocv`; OpenCode V2 replaces it. Claude support remains unchanged."
- Official package: `@opencode/cli`; inspected host version: `2.0.19`; Meridian loopback port: `3456`.
- Herdr allowlist: `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`.
- Do not convert host configuration, port plugins, change permissions/models, restart host services, or enable disabled debugger MCPs.
- Do not add a host Python/Node requirement. Node is a development-test dependency and is installed in the image for discovery.
- Do not print credential contents or arbitrary config/environment values. Discovery runs without plugins, network access, or the normal entrypoint.
- No paid prompts or session mutation during verification. Preserve historical ocv specs/plans.
- Preserve Docker preference, Podman `--userns=keep-id`, 48-hour refresh, `.env` handling, directory flags, argument quoting, and Claude's current launch behavior.
- Use comments sparingly and keep current user documentation concise, per `CLAUDE.md`.

## Review Focus

1. Paths with spaces/quotes, and delimiter characters: preserve ordinary paths exactly; reject unsupported volume/manifest delimiters with a path-only error. Owned by Task 2 and Task 3 tests.
2. A live host database with an image built for another version: rebuild before mounting/starting OpenCode; malformed/V1 detection must not fall back silently for OpenCode or prevent Claude use. Owned by Task 1 tests.
3. Nested symlinks and disabled debugger configurations: preserve required aliases without exposing whole repositories or interpreting/executing MCP shell strings. Owned by Task 2 tests.
4. An external server flag hidden among passthrough arguments, or `.env` overriding runtime directories: reject a genuine remote-server selection, preserve literal prompt text, and make isolated runtime paths authoritative. Owned by Task 3 tests.
5. Herdr socket loss and ancestor symlinks: missing socket warns, absent context is normal, and a working socket mounts alone at the advertised path. Owned by Task 3 and Task 4 tests.

## File map and task dependencies

| File | Responsibility |
| --- | --- |
| `Dockerfile` | Install V2 and the JSONC parser; copy the discovery helper; remove ocv. |
| `agentbox` | Version/rebuild policy, probe lifecycle, validated mounts, networking, context forwarding, private-server launch, tool selection. |
| `opencode-dependencies.cjs` | Read JSON/JSONC and filesystem metadata; produce a dependency manifest. Never load plugin modules or credential files. |
| `entrypoint.sh` | Isolated OpenCode runtime environment and current startup banner; retain Claude setup. |
| `tests/agentbox.test.cjs` | Bash/CLI behavior with fixture homes and stub runtimes, including current Claude regressions. |
| `tests/opencode-dependencies.test.cjs` | Structured discovery and symlink/config fixtures. |
| `tests/opencode-smoke.sh` | Opt-in, non-generating integration checks in an actual AgentBox image. |
| `README.md`, `DEVELOPMENT_NOTES.md` | Current tool, mount, networking, and version behavior. |
| `.dockerignore` | Exclude tests from production image context; leave the helper included. |

Task 1 establishes version selection and testability. Task 2 establishes the discovery contract. Task 3 consumes both and completes runtime integration. Task 4 verifies the complete setup and finishes current documentation. Do not create a new shell library or refactor unrelated code.

## Execution setup

- [ ] At execution time, use `using-git-worktrees` to establish an isolated workspace and move the session there if appropriate. Preserve the existing spec commit and any user changes.
- [ ] Read both the spec and this plan. Load TDD and relevant shell/JavaScript testing skills before product/test implementation.
- [ ] Install the development-only JSONC parser outside the repository:

```bash
npm install --prefix /tmp/opencode/agentbox-dev jsonc-parser@3.3.1
```

Use `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs` for development tests. Production discovery uses the image's own parser. Do not install or regenerate anything under the host's OpenCode config.

---

### Task 1: Install V2, match host versions, and retire ocv

**Files:**
- Modify: `Dockerfile:232-242`, `agentbox:16-28,93-159,379-450,577-797`, `entrypoint.sh:76-80`.
- Create: `tests/agentbox.test.cjs`.
- Modify: `.dockerignore` to add `tests`.

**Interfaces:**
- Consumes: existing `calculate_hash(path)`, `needs_rebuild()`, `build_image()`, and `$tool` selection.
- Produces: `parse_opencode_version(text)` prints a semantic version or returns nonzero; `select_opencode_version(tool)` prints the desired version/range or fails; global `OPENCODE_VERSION`; `calculate_image_hash()` includes Dockerfile, entrypoint, helper, and desired version. The no-host range is `2`, not `latest`, to select stable V2 even if npm's latest major changes.
- Produces: sourceable `agentbox` definitions without calling `main`; only `claude` and `opencode` remain accepted.

- [ ] **Step 1: Add failing CLI, version, and build-policy tests.** Begin the test file with this reusable fixture harness:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');

function fixture(t) {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  const home = fs.mkdtempSync('/tmp/opencode/agentbox-test-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, bin };
}

function bash(f, body, args = []) {
  return spawnSync('bash', ['--noprofile', '--norc', '-c',
    'set -euo pipefail; source "$1/agentbox"; shift; ' + body,
    'agentbox-test', repo, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

test('V2 output variants parse exactly', t => {
  const f = fixture(t);
  for (const input of ['opencode v2.0.19', '2.0.19', 'opencode 2.0.19']) {
    const result = bash(f, 'parse_opencode_version "$1"', [input]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '2.0.19');
  }
  assert.notEqual(bash(f, 'parse_opencode_version "$1"', ['not-a-version']).status, 0);
});

test('ocv is rejected before runtime access', t => {
  const f = fixture(t);
  const result = spawnSync('bash', [path.join(repo, 'agentbox'), '--tool', 'ocv'],
    { env: { ...process.env, HOME: f.home }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid tool/);
  assert.match(result.stderr, /claude.*opencode/);
});

test('version changes change the image hash', t => {
  const f = fixture(t);
  const a = bash(f, 'OPENCODE_VERSION=2.0.18; calculate_image_hash');
  const b = bash(f, 'OPENCODE_VERSION=2.0.19; calculate_image_hash');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(a.stdout, b.stdout);
});
```

Add table-driven cases with the same fixture harness: a stub `opencode` printing `1.18.10` rejects `select_opencode_version opencode` but returns `2` for Claude; a stub printing `garbage` or exiting 7 rejects OpenCode without exposing its output; a stub printing `2.0.19` returns that exact version. Stub creation:

```javascript
fs.writeFileSync(path.join(f.bin, 'opencode'), '#!/bin/sh\nprintf "%s\\n" "1.18.10"\n', { mode: 0o755 });
assert.notEqual(bash(f, 'select_opencode_version opencode').status, 0);
assert.equal(bash(f, 'select_opencode_version claude').stdout.trim(), '2');
```

```javascript
test('unusable host versions fail safely for OpenCode without blocking Claude', t => {
  const f = fixture(t);
  for (const [text, exit] of [['1.18.10', 0], ['SENSITIVE_ERROR', 0], ['2.0.19', 7]]) {
    fs.writeFileSync(path.join(f.bin, 'opencode'),
      `#!/bin/sh\nprintf '%s\\n' '${text}'\nexit ${exit}\n`, { mode: 0o755 });
    const result = bash(f, 'select_opencode_version opencode');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /SENSITIVE_ERROR/);
    assert.equal(bash(f, 'select_opencode_version claude').stdout.trim(), '2');
  }
});
```

For no-host fallback, run the selector with a Bash `command` function returning failure only for `command -v opencode`; delegate other calls to `builtin command`. For rebuild tests, a fake runtime returns a stored hash and a current UTC timestamp; assert same inputs do not rebuild, changing version or helper content does rebuild, and an absent image or 49-hour timestamp still rebuilds. Use copies under the fixture home for file-hash mutation; never mutate the working tree as a test fixture.

- [ ] **Step 2: Run the new tests and record the expected failure.**

```bash
node --test tests/agentbox.test.cjs
```

Expected: missing functions/sourceability or still-accepted ocv causes failure. Do not accept unrelated shell startup failures as the red evidence.

- [ ] **Step 3: Implement version selection and shared image hashing.** Add `DEPENDENCIES_PATH="${SCRIPT_DIR}/opencode-dependencies.cjs"` and initialize `OPENCODE_VERSION=2`. Replace the unconditional footer with:

```bash
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
```

Implement the version functions using this policy and quoting:

```bash
parse_opencode_version() {
    local text="$1"
    if [[ "$text" =~ (^|[[:space:]])v?([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)([[:space:]]|$) ]]; then
        printf '%s\n' "${BASH_REMATCH[2]}"
    else
        return 1
    fi
}

select_opencode_version() {
    local tool="$1" output version
    if ! command -v opencode >/dev/null 2>&1; then
        printf '%s\n' 2
        return
    fi
    if output=$(opencode --version 2>/dev/null) && version=$(parse_opencode_version "$output"); then
        if [[ "$version" == 2.* ]]; then
            printf '%s\n' "$version"
            return
        fi
    fi
    if [[ "$tool" == opencode ]]; then
        log_error "Host OpenCode must report a V2 version before sharing its data."
        return 1
    fi
    printf '%s\n' 2
}

calculate_image_hash() {
    printf '%s\0' "$(calculate_hash "$DOCKERFILE_PATH")" \
        "$(calculate_hash "$ENTRYPOINT_PATH")" \
        "$(calculate_hash "$DEPENDENCIES_PATH")" "$OPENCODE_VERSION" |
        sha256sum | cut -d' ' -f1
}
```

Assign `OPENCODE_VERSION=$(select_opencode_version "$tool")` after tool validation and before runtime/build selection. Replace the duplicated hash construction in both rebuild/build functions with `calculate_image_hash`. Add `--build-arg "OPENCODE_VERSION=$OPENCODE_VERSION"` and `--label "agentbox.opencode_version=$OPENCODE_VERSION"` to the existing build arguments. Keep timestamp and prune behavior unchanged.

- [ ] **Step 4: Replace ocv with the official V2 installation.** Replace only the ocv install block:

```dockerfile
ARG OPENCODE_VERSION=2
RUN bash -c 'source "$NVM_DIR/nvm.sh" && \
    npm install -g "@opencode/cli@${OPENCODE_VERSION}" && \
    npm install --prefix "$HOME/.local/lib/agentbox" jsonc-parser@3.3.1 && \
    opencode --version'
```

Remove the ocv branches in validation, mount selection, command selection, help examples, and the startup banner. Keep `claude --dangerously-skip-permissions` and its mount branch unchanged. At this task's boundary, OpenCode still launches plainly; private-server/network/mount parity is Task 3. Update the current README tool list and ocv-only examples now so this commit does not advertise a removed tool; the parity documentation is Task 4. Add `tests` to `.dockerignore`, without excluding the root helper.

- [ ] **Step 5: Add and run the implementation checks.**

```javascript
test('production files no longer install or launch ocv', () => {
  const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /@opencode\/cli/);
  assert.doesNotMatch(dockerfile, /@leohenon\/ocv/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'entrypoint.sh'), 'utf8'), /\bocv\b/);
});
```

```bash
node --test tests/agentbox.test.cjs
bash -n agentbox entrypoint.sh
./agentbox --help
git diff --check
```

Expected: all tests pass, no syntax/whitespace errors, help lists only Claude and OpenCode. Preserve historical ocv documents.

- [ ] **Step 6: Review this deliverable and commit only its files.** Use Jev selection with the real diff and no delegation unless authorized; check version/data compatibility and Claude regressions yourself if selection falls back.

```bash
git add Dockerfile agentbox entrypoint.sh README.md .dockerignore tests/agentbox.test.cjs
git commit -m "feat: install matching OpenCode V2 and retire ocv"
```

### Task 2: Discover filesystem dependencies without executing configuration

**Files:**
- Create: `opencode-dependencies.cjs`, `tests/opencode-dependencies.test.cjs`.
- Modify: `Dockerfile:222-227` to copy the helper to `/usr/local/lib/agentbox/opencode-dependencies.cjs`.

**Interfaces:**
- Consumes: `discover({ home, configDir, projectDir, scanRoots })`; all inputs are absolute paths visible through the read-only probe mounts.
- Produces: an array of `{ path, mode, role, required }`, where mode is `ro`/`rw`, role is `root`/`plugin`/`skills`/`file`/`symlink`, required is boolean, and path is an absolute filesystem path.
- CLI: `node opencode-dependencies.cjs --home PATH --config PATH --project PATH [--scan PATH ...]` emits one `mode<TAB>role<TAB>required-as-0-or-1<TAB>path` record per line. Errors go to stderr as path-only messages; exit nonzero. No JSON/config/secret values go to stdout.
- Exports: `discover(options)` and `collectConfig(document, source, context)` for tests; normal `require()` does not run the CLI.

- [ ] **Step 1: Add discovery tests with real JSONC and filesystem fixtures.**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discover, collectConfig } = require('../opencode-dependencies.cjs');

function tree(t) {
  fs.mkdirSync('/tmp/opencode', { recursive: true });
  const home = fs.mkdtempSync('/tmp/opencode/agentbox-discovery-');
  const configDir = path.join(home, '.config/opencode');
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectDir);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, configDir, projectDir, scanRoots: [configDir] };
}

test('JSONC file references produce path-only read-only mounts', t => {
  const ctx = tree(t);
  const token = path.join(ctx.home, 'private', 'view-token');
  fs.writeFileSync(path.join(ctx.configDir, 'opencode.jsonc'),
    '{ // fixture\n "mcp": {"servers": {"db": {"type":"remote",' +
    '"headers":{"Authorization":"Bearer {file:' + token + '}"}}}}, }');
  const result = discover(ctx);
  assert.ok(result.some(r => r.path === token && r.mode === 'ro' && r.role === 'file'));
  assert.doesNotMatch(JSON.stringify(result), /Bearer/);
  assert.ok(!result.some(r => r.path === path.dirname(token)));
});

test('plugin and skill relative paths use different bases', t => {
  const ctx = tree(t);
  const result = collectConfig({ plugins: ['./local-plugin'], skills: ['./local-skills'] },
    path.join(ctx.configDir, 'opencode.json'), ctx);
  assert.ok(result.some(r => r.path === path.join(ctx.configDir, 'local-plugin')));
  assert.ok(result.some(r => r.path === path.join(ctx.projectDir, 'local-skills')));
});

test('disabled debugger shell strings are never evaluated or mounted as paths', t => {
  const ctx = tree(t);
  const sentinel = path.join(ctx.home, 'must-not-exist');
  const result = collectConfig({ mcp: { dbg: { enabled: false, type: 'local',
    command: ['bash', '-c', `touch ${sentinel}; exec /private/debugger`] } } },
    path.join(ctx.configDir, 'opencode.json'), ctx);
  assert.equal(fs.existsSync(sentinel), false);
  assert.ok(!result.some(r => r.path === '/private/debugger'));
});
```

Add table-driven cases for native/legacy plugin objects and tuples, CLI plugin objects, legacy `skills.paths`, npm/Git/HTTP packages, file URLs with percent-encoded spaces, global compatible skills, optional absent roots, invalid JSONC, duplicate paths, quoted/spaced paths, rejected tab/newline/colon paths, and a symlink directory cycle. For a nested external link, create two fixture directories plus `fs.symlinkSync(external, nestedLink)` and assert a `symlink` record, not a whole-home record. A link to its own ancestor must finish rather than recurse forever. For malformed JSONC, assert the error contains its source path but not a credential-like string embedded in that input.

```javascript
test('legacy and native plugin declarations preserve quoted local paths', t => {
  const ctx = tree(t);
  for (const document of [
    { plugins: [{ package: "./plugin with 'quote'" }] },
    { plugin: [["./plugin with 'quote'", { enabled: true }]] },
    { plugins: ["./plugin with 'quote'"] },
  ]) {
    const result = collectConfig(document, path.join(ctx.configDir, 'cli.json'), ctx);
    assert.ok(result.some(r => r.path === path.join(ctx.configDir, "plugin with 'quote'")));
  }
  for (const value of ['./bad\npath', './bad\tpath', './bad\0path', './bad:path']) {
    assert.throws(() => collectConfig({ plugins: [value] },
      path.join(ctx.configDir, 'cli.json'), ctx), /Unsupported dependency path/);
  }
});

test('nested external symlinks are discovered without following a directory cycle', t => {
  const ctx = tree(t);
  const nested = path.join(ctx.configDir, 'plugins/nested');
  const external = path.join(ctx.home, 'external-plugin');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(nested, 'dependency'));
  fs.symlinkSync(ctx.configDir, path.join(nested, 'cycle'));
  const result = discover(ctx);
  assert.ok(result.some(r => r.path === external && r.role === 'symlink'));
  assert.ok(!result.some(r => r.path === ctx.home));
});

test('JSONC errors identify the source without exposing values', t => {
  const ctx = tree(t);
  const source = path.join(ctx.configDir, 'opencode.jsonc');
  fs.writeFileSync(source, '{"apiKey":"SENSITIVE_VALUE", broken}');
  assert.throws(() => discover(ctx), error =>
    error.message.includes(source) && !error.message.includes('SENSITIVE_VALUE'));
});
```

- [ ] **Step 2: Run the discovery tests and confirm the missing-module failure.**

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/opencode-dependencies.test.cjs
```

Expected: failure because `opencode-dependencies.cjs` does not exist, before any runtime integration is written.

- [ ] **Step 3: Implement the pure configuration collector.** Use `node:fs`, `node:path`, `node:url`, `node:util`, and `jsonc-parser`; fall back to the image parser path `/home/agent/.local/lib/agentbox/node_modules/jsonc-parser` if normal module resolution cannot find it. The following code fixes the parsing and path contract:

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
let jsonc;
try { jsonc = require('jsonc-parser'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  jsonc = require('/home/agent/.local/lib/agentbox/node_modules/jsonc-parser');
}

function resolveLocal(value, base, home, packageEntry = false) {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('file:')) value = require('node:url').fileURLToPath(value);
  else if (packageEntry && !/^(\/|~\/|\.\.?\/)/.test(value)) return undefined;
  else if (/^https?:\/\//.test(value)) return undefined;
  if (value.startsWith('~/')) value = path.join(home, value.slice(2));
  const resolved = path.resolve(base, value);
  if (/[\x00\t\r\n:]/.test(resolved)) throw new Error(`Unsupported dependency path: ${resolved.replace(/[\x00\t\r\n]/g, '?')}`);
  return resolved;
}

function collectConfig(document, source, context) {
  const output = [];
  const add = (value, base, role, mode = 'ro', packageEntry = false) => {
    const dependency = resolveLocal(value, base, context.home, packageEntry);
    if (dependency) output.push({ path: dependency, mode, role, required: true });
  };
  const base = path.dirname(source);
  const entries = document.plugins ?? document.plugin ?? [];
  if (!Array.isArray(entries)) throw new Error(`Invalid configuration: ${source}`);
  for (const entry of entries) {
    const value = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : entry?.package ?? entry?.path;
    if (typeof value === 'string' && value.startsWith('/usr/lib/meridian/')) {
      add('/usr/lib/meridian', base, 'plugin');
      add(path.join(context.home, '.config/meridian'), base, 'root', 'rw');
    } else {
      add(value, base, 'plugin', 'ro', true);
    }
  }
  const skills = Array.isArray(document.skills) ? document.skills : document.skills?.paths ?? [];
  if (!Array.isArray(skills)) throw new Error(`Invalid configuration: ${source}`);
  for (const skill of skills) add(skill, context.projectDir, 'skills');
  function fileReferences(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{file:([^}]+)\}/g)) add(match[1], base, 'file');
    } else if (Array.isArray(value)) {
      value.forEach(fileReferences);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(fileReferences);
    }
  }
  fileReferences(document);
  return output;
}
```

Reject malformed plugin/skills types with a source-path error rather than printing the offending value. Do not treat normal MCP command arguments as filesystem declarations. Scan both global `opencode.json` and `opencode.jsonc`, and `cli.json`; do not convert fields or alter the documents.

- [ ] **Step 4: Implement metadata traversal and project config collection.** Seed optional global skill roots and traverse explicit scan roots using a visited-realpath set. Skip descent into ordinary `.git`, `node_modules`, and cache directories, but still inspect a directory entry that is itself a symlink. Emit external lexical symlink targets even when the probe cannot yet read them; Bash will validate and add their mounts before the next probe pass. Do not read token-file contents.

```javascript
function scanLinks(root, emit, visited = new Set()) {
  if (!fs.existsSync(root)) return;
  const canonical = fs.realpathSync(root);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(path.dirname(name), fs.readlinkSync(name));
      emit({ path: target, mode: 'ro', role: 'symlink', required: true });
    } else if (entry.isDirectory() && !['.git', 'node_modules', '.cache'].includes(entry.name)) {
      scanLinks(name, emit, visited);
    }
  }
}

function parseDocument(source) {
  const errors = [];
  const result = jsonc.parse(fs.readFileSync(source, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !result || Array.isArray(result) || typeof result !== 'object') {
    throw new Error(`Invalid configuration: ${source}`);
  }
  return result;
}
```

Implement the aggregator along these lines, retaining source-path validation and safe errors from the preceding functions:

```javascript
function discover(context) {
  const records = [];
  const roots = new Set(context.scanRoots ?? []);
  const documents = new Set();
  const add = record => records.push(record);
  roots.add(context.configDir);
  add({ path: context.configDir, mode: 'rw', role: 'root', required: true });
  for (const relative of ['.claude/skills', '.agents/skills']) {
    const root = path.join(context.home, relative);
    add({ path: root, mode: 'ro', role: 'skills', required: false });
    if (fs.existsSync(root)) roots.add(root);
  }
  for (const name of ['opencode.json', 'opencode.jsonc', 'cli.json']) {
    documents.add(path.join(context.configDir, name));
  }
  for (let directory = context.projectDir; ; directory = path.dirname(directory)) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      documents.add(path.join(directory, name));
      documents.add(path.join(directory, '.opencode', name));
    }
    const root = path.join(directory, '.opencode');
    if (fs.existsSync(root)) {
      roots.add(root);
      add({ path: root, mode: 'ro', role: 'root', required: true });
    }
    if (path.dirname(directory) === directory) break;
  }
  const meridian = path.join(context.home, '.config/meridian');
  if (roots.has(meridian)) documents.add(path.join(meridian, 'plugins.json'));
  for (const root of roots) scanLinks(root, add);
  for (const source of documents) {
    if (fs.existsSync(source)) records.push(...collectConfig(parseDocument(source), source, context));
  }
  const unique = new Map();
  for (const record of records) {
    record.path = resolveLocal(record.path, context.projectDir, context.home);
    const previous = unique.get(record.path);
    if (!previous) unique.set(record.path, record);
    else {
      const file = previous.role === 'file' || record.role === 'file';
      unique.set(record.path, {
        ...previous,
        role: file ? 'file' : previous.role,
        mode: file ? 'ro' : previous.mode === 'rw' || record.mode === 'rw' ? 'rw' : 'ro',
        required: previous.required || record.required,
      });
    }
  }
  return [...unique.values()];
}
```

Scan only relevant `.opencode` roots/config-file symlink targets, not whole ancestor directories. When a Meridian root becomes visible in a later probe pass, its `plugins.json` uses `path` objects. Never promote a credential-file mount to writable. Skip ordinary internal symlink records already satisfied by a mounted root; only explicit `file` references require a read-only overlay under an existing writable mount.

Use `parseArgs` with string options `home`, `config`, `project`, and repeatable `scan`. Validate every emitted path with the same delimiter check, including symlink targets and optional roots. Output the four-field TSV format from the interface. Wrap errors so their message contains only the failing file/path and error category, not raw parse exceptions with input contents.

Export both test interfaces and keep the CLI guarded:

```javascript
module.exports = { discover, collectConfig };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      home: { type: 'string' }, config: { type: 'string' }, project: { type: 'string' },
      scan: { type: 'string', multiple: true, default: [] },
    } });
    if (![values.home, values.config, values.project].every(value =>
      typeof value === 'string' && path.isAbsolute(value))) throw new Error('Invalid discovery arguments.');
    const records = discover({ home: values.home, configDir: values.config,
      projectDir: values.project, scanRoots: values.scan });
    for (const record of records) {
      process.stdout.write([record.mode, record.role, Number(record.required), record.path].join('\t') + '\n');
    }
  } catch (error) {
    const known = /^(Invalid configuration: |Unsupported dependency path: )/.test(error.message);
    process.stderr.write((known ? error.message : 'OpenCode dependency discovery failed.') + '\n');
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Copy the helper and run the full unit checks.** Add:

```dockerfile
COPY opencode-dependencies.cjs /usr/local/lib/agentbox/opencode-dependencies.cjs
```

Use the root-owned entrypoint-copy section; the helper is readable, not executable, and is invoked by Node. Run:

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
node --check opencode-dependencies.cjs
git diff --check
```

Expected: collector and symlink/config tests pass, no changes to fixture credentials, no generated secret values in manifest/errors, and Task 1's hash changes when a fixture helper changes.

- [ ] **Step 6: Review the parser/dependency boundary and commit.** Check path normalization, file-URL decoding, malformed input handling, and that no configuration is evaluated or imported. Use the real diff for Jev selection; inline fallback is mandatory if unavailable.

```bash
git add opencode-dependencies.cjs tests/opencode-dependencies.test.cjs Dockerfile
git commit -m "feat: discover OpenCode filesystem dependencies safely"
```

### Task 3: Integrate selective mounts, host networking, and private launch

**Files:**
- Modify: `agentbox:327-450,518-575,753-793`, `entrypoint.sh:5-20`.
- Extend: `tests/agentbox.test.cjs`, `tests/opencode-dependencies.test.cjs`.

**Interfaces:**
- Consumes: Task 1 version/hash policy and Task 2's four-field dependency manifest.
- Produces: `append_opencode_mount(arrayName, source, destination, mode, registryName)`; `build_opencode_mounts(arrayName, projectId)`; `build_herdr_args(arrayName)`; `build_network_args(networkArrayName, portArrayName, tool, portsArrayName)`; `validate_opencode_server_args(args...)`.
- Mount registry: associative Bash array keyed by destination, used to deduplicate/conflict-check mounts. Source is resolved on the host; destination retains the configured lexical path. Read-only external files are mounted after enclosing writable roots.
- Probe: read-only temporary mounts, no normal entrypoint, no plugins or network; output goes into a unique AgentBox-owned temporary manifest. Cache persists under `${HOME}/.cache/agentbox/${projectId}/opencode`; state stays inside the ephemeral container.

- [ ] **Step 1: Add failing mount, network, and argument tests.** Use Task 1's `fixture`/`bash` harness and append tests like these:

```javascript
test('OpenCode uses host networking and omits port publication', t => {
  const f = fixture(t);
  const result = bash(f,
    'declare -a net=() published=() requested=(3002 3002:8080); ' +
    'build_network_args net published opencode requested; ' +
    'printf "NET=%s\\n" "${net[*]}"; printf "PORTS=%s\\n" "${published[*]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NET=--network=host/);
  assert.match(result.stdout, /PORTS=\n/);
  assert.match(result.stdout + result.stderr, /host networking/);
});

test('Claude retains ordinary networking and port mapping', t => {
  const f = fixture(t);
  const result = bash(f,
    'declare -a net=() published=() requested=(3002); ' +
    'build_network_args net published claude requested; ' +
    'printf "NET=%s\\n" "${net[*]}"; printf "PORTS=%s\\n" "${published[*]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NET=\n/);
  assert.match(result.stdout, /PORTS=-p 3002:3002/);
});

test('private launch rejects server selection but not a literal prompt value', t => {
  const f = fixture(t);
  for (const args of [['--server', 'http://127.0.0.1:4096'],
    ['api', '--server=http://127.0.0.1:4096', 'get', '/api/info']]) {
    assert.notEqual(bash(f, 'validate_opencode_server_args "$@"', args).status, 0);
  }
  assert.equal(bash(f, 'validate_opencode_server_args "$@"', ['--prompt', '--server']).status, 0);
  assert.equal(bash(f, 'validate_opencode_server_args "$@"', ['run', '--', '--server']).status, 0);
});

test('a credential mounts as a read-only file, not its parent', t => {
  const f = fixture(t);
  const file = path.join(f.home, "token with 'quote'");
  fs.writeFileSync(file, 'fixture-only');
  const result = bash(f,
    'declare -a output=(); declare -A seen=(); ' +
    'append_opencode_mount output "$1" "$1" ro seen; printf "%s\\n" "${output[@]}"', [file]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${file}:${file}:ro`));
  assert.ok(!result.stdout.includes(`${f.home}:${f.home}:`));
});
```

Create a Node `net.createServer()` Unix-socket fixture, close it in `t.after`, and run `build_herdr_args` in a child with a complete allowlisted Herdr context and an extra `HERDR_SECRET` variable. Assert the socket alone is mounted at the lexical advertised path, pane/tab/workspace identities are preserved, and `HERDR_SECRET`, host `OPENCODE_SESSION_ID`, and host state directories are absent. Repeat with the socket parent as a symlink, a missing socket, and no Herdr context; missing socket warns, absent context does not.

```javascript
test('Herdr preserves a socket alias without mounting its configuration directory', async t => {
  const f = fixture(t);
  const actualDir = path.join(f.home, 'actual-herdr');
  const aliasDir = path.join(f.home, 'herdr-alias');
  fs.mkdirSync(actualDir);
  fs.symlinkSync(actualDir, aliasDir);
  const actualSocket = path.join(actualDir, 'herdr.sock');
  const advertisedSocket = path.join(aliasDir, 'herdr.sock');
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(actualSocket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = bash(f,
    'export HERDR_ENV=1 HERDR_SOCKET_PATH="$1" HERDR_PANE_ID=pane ' +
    'HERDR_TAB_ID=tab HERDR_WORKSPACE_ID=workspace HERDR_SECRET=fixture-secret ' +
    'OPENCODE_SESSION_ID=host-session; ' +
    'declare -a output=(); build_herdr_args output; printf "%s\\n" "${output[@]}"',
    [advertisedSocket]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${actualSocket}:${advertisedSocket}:ro`));
  assert.match(result.stdout, /HERDR_PANE_ID=pane/);
  assert.doesNotMatch(result.stdout, /HERDR_SECRET|OPENCODE_SESSION_ID/);
  assert.ok(!result.stdout.includes(`${actualDir}:${actualDir}:`));
});

test('a missing advertised Herdr socket warns without exposing extra files', t => {
  const f = fixture(t);
  const socket = path.join(f.home, 'missing.sock');
  const result = bash(f,
    'export HERDR_ENV=1 HERDR_SOCKET_PATH="$1"; declare -a output=(); ' +
    'build_herdr_args output; printf "COUNT=%s\\n" "${#output[@]}"', [socket]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /socket/i);
  assert.match(result.stdout, /COUNT=0/);
});
```

Add unit cases for duplicate destinations, conflicting mount modes, missing required files, broad-home/root rejection, tab/newline/colon rejection, multiple levels of external symlinks, no unrelated sibling repositories, and `.env` runtime override prevention. Use fake probe output so shell mount tests do not need a real image or credentials. Keep separate actual-probe integration checks in Task 4.

- [ ] **Step 2: Run and record the expected failures.**

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
```

Expected: new runtime functions are missing; previous Task 1/2 tests still pass. Do not implement networking before the assertions fail.

- [ ] **Step 3: Implement mount validation, aliases, and the probe lifecycle.** `append_opencode_mount` must:
1. Reject unsupported delimiters, nonexistent sources, invalid modes, and broad mount sources `/`, `/home`, `/usr`, `/etc`, `/var`, or the entire host home. Reuse existing critical-directory checks, while allowing the explicitly required `/usr/lib/meridian` package.
2. Resolve the source with host `realpath -e`, retaining the exact absolute destination. For a directory symlink root, add both the lexical host-path alias and canonical destination, plus `/home/agent` discovery aliases where applicable.
3. Deduplicate destination/source/mode tuples. A conflicting source for the same destination is an error. Do not blindly relabel host system/plugin directories with SELinux `:z`; report access problems rather than silently changing host security labels.
4. Append one quoted `-v` value. Never construct/evaluate a shell command from paths or manifest values.

Implement the mount appender with this validation/insertion pattern, preserving source and destination aliases:

```bash
append_opencode_mount() {
    local -n output_ref="$1" registry_ref="$5"
    local source destination="$3" mode="$4"
    if [[ "$mode" != ro && "$mode" != rw ]] ||
        [[ "$2$destination" == *$'\n'* || "$2$destination" == *$'\r'* ||
           "$2$destination" == *$'\t'* || "$2" == *:* || "$destination" == *:* ]] ||
        [[ "$2" != /* || "$destination" != /* ]]; then
        log_error "Unsupported OpenCode mount path or mode."
        return 1
    fi
    source=$(realpath -e "$2") || {
        log_error "Missing OpenCode dependency: $2"
        return 1
    }
    if [[ "$source" == *:* || "$source" == *$'\n'* || "$source" == *$'\r'* || "$source" == *$'\t'* ]]; then
        log_error "Unsupported resolved OpenCode mount path."
        return 1
    fi
    local canonical_home
    canonical_home=$(realpath -e "$HOME") || return 1
    case "$source" in
        /|/home|/usr|/usr/bin|/usr/sbin|/usr/lib|/usr/lib64|/usr/share|/etc|/var|"$HOME"|"$canonical_home")
            log_error "Broad OpenCode mount is not allowed: $source"
            return 1 ;;
    esac
    if is_critical_system_dir "$source"; then
        log_error "Critical OpenCode mount is not allowed: $source"
        return 1
    fi
    local signature="$source:$mode"
    if [[ -n "${registry_ref[$destination]+present}" ]]; then
        [[ "${registry_ref[$destination]}" == "$signature" ]] && return 0
        log_error "Conflicting OpenCode mount: $destination"
        return 1
    fi
    registry_ref["$destination"]="$signature"
    output_ref+=(-v "$source:$destination:$mode")
}
```

Provide distinct registries for read-only probe mounts and final runtime mounts. Build final mounts from the consolidated manifest in parent-first order, not from the probe registry; this avoids treating the intentional probe-`ro` to runtime-`rw` transition as a conflict.

`build_opencode_mounts` seeds config/data roots and optional compatible skill directories. Add writable aliases for OpenCode config/data at both the host lexical/canonical paths and `/home/agent/.config/opencode` / `/home/agent/.local/share/opencode`. Add skills read-only at both their configured host paths and V2 discovery paths under `/home/agent`. Do not mount host runtime state, the host cache, or whole `.claude`.

Bootstrap the probe with only read-only configuration roots/files and their required symlink aliases. Walk host project ancestors to select existing `opencode.json(c)` files and `.opencode` directories; do not bind ancestor directories wholesale. For links that prevent an initial config read, add the link's lexical target alias plus its resolved canonical source before parsing. Use host `readlink`, `realpath`, `find -print0`, and quoted arrays; no host JSON parser is required.

Run the helper using the existing runtime, propagating Podman's user-namespace option when applicable:

```bash
"$RUNTIME" run --rm --network=none --read-only \
    --cap-drop=ALL --security-opt=no-new-privileges \
    "${probe_runtime_args[@]}" "${probe_mounts[@]}" \
    --entrypoint /bin/bash "$IMAGE_NAME" \
    -c 'source "$NVM_DIR/nvm.sh"; exec node /usr/local/lib/agentbox/opencode-dependencies.cjs "$@"' \
    agentbox-discovery --home "$HOME" --config "$HOME/.config/opencode" \
    --project "$PROJECT_DIR" "${scan_args[@]}" > "$manifest_file"
```

Read records with `IFS=$'\t' read -r mode role required dependency`; validate all four fields before use. Required sources must exist on the host. If a newly declared root or external symlink target must be read to discover its own links/config, add it as a read-only probe mount and `--scan` root, then rerun discovery. Stop when the destination registry is stable; cap closure at 32 passes with an explicit path-only error. Keep symlink visited sets so ordinary cycles do not cause another pass indefinitely. The helper is not permitted to open credential contents during these passes.

Propagate every probe, record-validation, and mount-validation failure explicitly with `|| return 1`; do not rely on `set -e` inside functions invoked in conditional contexts. Assert with a stub runtime that a malformed/missing required dependency prevents the main container's `run` call.

Build the complete final manifest from all passes, not just the last one. Explicit credential files stay read-only even under writable roots. Skip generic roots/symlink aliases already covered by existing project/additional mounts rather than making ordinary project config read-only. Plugin directories expose adjacent package dependencies; external plugin-file entries use their containing package directory when a host package manifest identifies one. Meridian uses the specifically configured installed package root `/usr/lib/meridian`, not just `dist/meridian-v2`.

Use `mktemp -d "$HOME/.cache/agentbox/$project_id/opencode-discovery.XXXXXX"` after creating that AgentBox-owned cache parent, and remove only that newly created directory on both success and failure. Do not delete generic directories or print manifest contents in user logs.

- [ ] **Step 4: Implement networking and Herdr context.**

```bash
build_network_args() {
    local -n network_ref="$1" publication_ref="$2" requested_ref="$4"
    network_ref=()
    publication_ref=()
    if [[ "$3" == opencode ]]; then
        network_ref+=(--network=host)
        if (( ${#requested_ref[@]} )); then
            log_warning "OpenCode uses host networking; -p mappings are ignored."
        fi
    else
        build_port_args "$2" "$4"
    fi
}
```

In `run_container`, replace direct port construction with this function and include the new network array in the runtime call. Preserve Podman `--userns=keep-id`. Apply the OpenCode network branch to selected shell mode too.

`build_herdr_args` returns no arguments if `HERDR_ENV` is not `1`. If the socket is advertised but missing, warn by path and return without an integration mount. For a valid socket, use the host's resolved socket as source and the advertised lexical socket path as destination; do not mount its parent. Forward set allowlist values with `--env "${name}=${!name}"`, not a wildcard environment copy. Do not forward `HERDR_BIN_PATH` or mount the Herdr executable because the inspected integrations do not use it.

- [ ] **Step 5: Enforce private-server launch and isolated runtime paths.** Implement the argument scanner with explicit value-taking options verified against V2 root/run/API help. Stop parsing flags after `--`; do not interpret prompt/header/data values as flags.

```bash
validate_opencode_server_args() {
    local argument skip_value=false
    for argument in "$@"; do
        if [[ "$skip_value" == true ]]; then
            skip_value=false
            continue
        fi
        case "$argument" in
            --) break ;;
            --server|--server=*)
                log_error "AgentBox OpenCode uses a private container server; --server is not supported."
                return 1 ;;
            --prompt|--session|-s|--model|-m|--agent|--format|--file|-f|--title|--data|-d|--header|-H|--param|--log-level|--completions)
                skip_value=true ;;
        esac
    done
}
```

Call this for managed OpenCode before invoking the container. Set its command prefix to `opencode --standalone`, retain existing `%q` argument escaping, and preserve the shell/admin/Claude branches. A real V2 CLI smoke test must verify that parent and child command routing retains the private-server flag; if the CLI requires a flag after a subcommand, insert it at that position and pin the discovered behavior with a regression test rather than assuming the prefix works for every subcommand.

Mount dedicated cache storage at `/home/agent/.cache/opencode` and pass `--env "AGENTBOX_OPENCODE_VERSION=$OPENCODE_VERSION"` for verification. Do not mount `/home/agent/.local/state/opencode` from the host. In the OpenCode-only entrypoint branch, override runtime-directory selectors after `.env` loading so the server never uses an injected host state path:

```bash
if [[ "${TOOL:-}" == opencode ]]; then
    export OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
    export XDG_CONFIG_HOME="$HOME/.config"
    export XDG_DATA_HOME="$HOME/.local/share"
    export XDG_CACHE_HOME="$HOME/.cache"
    export XDG_STATE_HOME="$HOME/.local/state"
    unset OPENCODE_SESSION_ID
    mkdir -p "$XDG_CACHE_HOME/opencode" "$XDG_STATE_HOME/opencode"
fi
```

Do not unset provider credentials or application-specific `.env` variables. `build_mount_opts` delegates only its OpenCode branch to the new functions; the existing Claude symlink setup remains untouched. For a selected OpenCode shell, these directory protections still apply; managed direct OpenCode uses the private-server flag.

- [ ] **Step 6: Pin quoting, runtime isolation, and entrypoint behavior.** Execute the constructed managed command through a fixture `zsh`/`opencode` shim that captures NUL-delimited argv. Assert a prompt with spaces, quotes, `$()`, and semicolons is a single literal argument; no sentinel file is created. Assert OpenCode has a private-server option and Claude retains its skip-permissions option.

For the fast test, extract and execute only the new OpenCode runtime branch from `entrypoint.sh`; do not run the entire existing entrypoint on the host, since its literal `/home/agent` git/SSH operations are container-specific. Whole-entrypoint execution is covered by Task 4's real container checks:

```javascript
test('OpenCode runtime selectors override injected state paths only for OpenCode', t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(repo, 'entrypoint.sh'), 'utf8');
  const branch = source.match(/if \[\[ "\$\{TOOL:-\}" == opencode \]\]; then\n[\s\S]*?\nfi/);
  assert.ok(branch, 'OpenCode runtime branch must exist');
  const foreign = path.join(f.home, 'foreign-state');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'sentinel'), 'unchanged');
  for (const tool of ['opencode', 'claude']) {
    const result = spawnSync('bash', ['-c',
      branch[0] + '\nprintf "%s\\n" "$XDG_STATE_HOME"'], {
      env: { ...process.env, HOME: f.home, TOOL: tool, XDG_STATE_HOME: foreign },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), tool === 'opencode' ? `${f.home}/.local/state` : foreign);
  }
  assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'unchanged');
});
```

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
bash -n agentbox entrypoint.sh
shellcheck agentbox entrypoint.sh
git diff --check
```

Record pre-existing ShellCheck findings separately; fix new findings without unrelated cleanup. Expected: all regression tests pass and no newly introduced lint/syntax failures remain.

- [ ] **Step 7: Review actual runtime boundaries and commit.** Check source/destination aliases, manifest merging, read-only credentials, symlink closure, service isolation, flag parsing, and host-network scope. Use Jev on the actual diff; do not skip inline review if its credentials are unavailable.

```bash
git add agentbox entrypoint.sh tests/agentbox.test.cjs tests/opencode-dependencies.test.cjs
git commit -m "feat: preserve OpenCode host integrations inside AgentBox"
```

### Task 4: Verify the real setup and document the security boundary

**Files:**
- Create: `tests/opencode-smoke.sh`.
- Modify: `README.md:37-115,188-220`, `DEVELOPMENT_NOTES.md:14-38,76-96,132-160`.
- Extend: `tests/agentbox.test.cjs` for documentation/runtime-contract checks.

**Interfaces:**
- Consumes: the built image, completed runtime functions, version policy, and actual host configuration.
- Produces: an opt-in, non-generating smoke check invoked inside an OpenCode-selected AgentBox shell; concise current documentation and recorded verification evidence. Options: repeatable `--require-plugin ID_OR_SOURCE`, `--require-mcp NAME`, `--disabled-mcp NAME`, and optional `--meridian-url URL` for a read-only catalog endpoint.
- API checks use V2 `GET /api/info`, `/api/plugin`, `/api/agent`, `/api/skill`, `/api/command`, `/api/model`, and `/api/mcp`. No configuration dump, credential endpoint, session-control operation, prompt, or update command is allowed.

- [ ] **Step 1: Write a failing smoke precondition test and the integration checker.** Assert that the checker fails before any service call if `TOOL` is not `opencode` or the reported version is not the image's selected V2 version. Use a stub recorder; its only permitted precondition invocation is `--version`:

```javascript
test('smoke rejects a version mismatch before starting a server', t => {
  const f = fixture(t);
  const record = path.join(f.home, 'calls');
  fs.writeFileSync(path.join(f.bin, 'opencode'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\nprintf "%s\\n" "2.0.18"\n',
    { mode: 0o755 });
  const result = spawnSync('bash', [path.join(repo, 'tests/opencode-smoke.sh')], {
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`,
      TOOL: 'opencode', AGENTBOX_OPENCODE_VERSION: '2.0.19', RECORD: record,
      OPENCODE_CONFIG_DIR: `${f.home}/.config/opencode`,
      XDG_STATE_HOME: `${f.home}/.local/state` },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(record, 'utf8').trim(), '--version');
});
```

The initial checker's core deliberately lacks the expected-version check so this assertion fails; Step 3 adds it before any server startup. Keep one newly created private server alive for API checks so background package installation and MCP connection establishment can complete; do not start and stop seven separate standalone servers:

```bash
#!/usr/bin/env bash
set -euo pipefail

[[ "${TOOL:-}" == opencode ]] || {
    printf '%s\n' 'Run this check in an OpenCode-selected AgentBox shell.' >&2
    exit 1
}
opencode --version
[[ "${XDG_STATE_HOME:-}" == "$HOME/.local/state" ]] || exit 1
[[ "${OPENCODE_CONFIG_DIR:-}" == "$HOME/.config/opencode" ]] || exit 1

umask 077
mkdir -p /tmp/opencode
workspace=$(mktemp -d /tmp/opencode/agentbox-smoke.XXXXXX)
server_pid=
cleanup() {
    if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf -- "$workspace"
}
trap cleanup EXIT
opencode serve --hostname 127.0.0.1 --port 0 > "$workspace/server.log" 2>&1 &
server_pid=$!
deadline=$((SECONDS + 120))
server_url=
while (( SECONDS < deadline )); do
    kill -0 "$server_pid" 2>/dev/null || exit 1
    if server_url=$(grep -Eo 'http://127[.]0[.]0[.]1:[0-9]+' "$workspace/server.log" | head -n 1) && [[ -n "$server_url" ]]; then
        break
    fi
    sleep 0.2
done
[[ -n "$server_url" ]] || exit 1

api_get() {
    opencode api --server "$server_url" get "$1" 2>> "$workspace/server.log"
}

for endpoint in info plugin agent skill command model mcp; do
    response=$(api_get "/api/$endpoint")
    printf '%s' "$response" | jq -e 'type == "object" or type == "array"' >/dev/null
    printf 'Verified API endpoint: %s\n' "$endpoint"
done

if [[ "${HERDR_ENV:-}" == 1 ]]; then
    [[ -S "${HERDR_SOCKET_PATH:-}" ]] || {
        printf '%s\n' 'Herdr socket is unavailable.' >&2
        exit 1
    }
fi
```

The `serve` child is a newly created container-local process, not the shared host service; `--server` here connects the direct CLI to that exact child, not through AgentBox's managed remote-server interface. The inspected V2 serve implementation reports `server listening on http://127.0.0.1:PORT`. Before starting it, generate a random test-only `OPENCODE_PASSWORD` in the smoke process, unset its legacy password alias, and let both the child and direct API client inherit it. This prevents printing/reusing a host service password and authenticates against the owned child:

```bash
export OPENCODE_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
unset OPENCODE_SERVER_PASSWORD
trap 'exit 130' INT
trap 'exit 143' TERM
```

Do not print this generated value. Cleanup must kill/wait only the owned child and remove only its `mktemp` directory. Fail with a sanitized startup error if no listening URL appears, rather than falling back to host service discovery.

Parse the declared smoke options into arrays before the checks. Unknown options or missing option values fail with an option-name-only error. Extend the checker to assert requested plugin IDs/sources and MCP statuses, without printing complete response bodies. The inspected V2 OpenAPI specifies catalog envelopes as `{ location, data }`; `Plugin.Info` uses `.state.status == "active"`, and MCP records use `.name` and `.status.status` (`connected`, `pending`, `disabled`, `failed`, `needs_auth`). Failure output identifies a missing name/status only, never the status object's raw error. Missing optional Herdr outside its environment is not a failure.

- [ ] **Step 2: Run the smoke precondition test and verify the intended failure.**

```bash
node --test tests/agentbox.test.cjs
bash -n tests/opencode-smoke.sh
```

Expected: the newly added smoke-contract assertions expose the missing explicit version/status checks before those checks are implemented; the script is syntactically valid. Never point the stub recorder at the actual host database.

- [ ] **Step 3: Complete read-only assertions and current documentation.** Source the guarded `agentbox` definitions from the script's repository parent to reuse `parse_opencode_version`, without calling `main`. Before starting the child server, compare the actual version with `AGENTBOX_OPENCODE_VERSION`: exact equality for a pinned version, or major `2` for range `2`; a missing selector fails. The mismatch test now passes.

For requested catalogs, use these predicates and a bounded readiness loop within the existing 120-second deadline, retaining the same child server:

```bash
plugins=$(api_get /api/plugin)
mcps=$(api_get /api/mcp)
for plugin in "${required_plugins[@]}"; do
    printf '%s' "$plugins" | jq -e --arg value "$plugin" \
        'any(.data[]; (.id == $value or .source.path == $value or .source.target == $value) and .state.status == "active")' >/dev/null
done
for name in "${required_mcps[@]}"; do
    printf '%s' "$mcps" | jq -e --arg name "$name" \
        'any(.data[]; .name == $name and .status.status == "connected")' >/dev/null
done
for name in "${disabled_mcps[@]}"; do
    printf '%s' "$mcps" | jq -e --arg name "$name" \
        'any(.data[]; .name == $name and .status.status == "disabled")' >/dev/null
done
if [[ -n "$meridian_url" ]]; then
    curl --fail --silent --connect-timeout 3 --max-time 5 "$meridian_url" |
        jq -e '.data | type == "array" and length > 0' >/dev/null
fi
```

Wrap the readiness predicates in conditionals so `set -e` does not terminate on an expected transient state; on timeout print only requested names and sanitized statuses. Meridian's inspected plugin reads `/v1/models` without generation; the current configured base path is `/v1` on loopback port 3456. A cached model catalog alone is not proof of current loopback connectivity.

For Herdr, after checking the socket file, use Node's `net.createConnection` with a three-second timeout, close on connection, and send no RPC payload. Unit fixtures exercise reporting; actual-socket smoke checks must not report/switch a real pane/session.

```bash
node -e '
const socket = require("node:net").createConnection(process.argv[1]);
socket.setTimeout(3000, () => { process.exitCode = 1; socket.destroy(); });
socket.once("error", () => { process.exitCode = 1; });
socket.once("connect", () => { socket.end(); });
' "$HERDR_SOCKET_PATH"
```

Replace current README tool/auth entries with these facts, adapted to its existing concise style:

```markdown
- OpenCode V2: built-in; uses the host V2 version when installed.

OpenCode shares host configuration, authentication, and session history.
Local plugins, skills, symlink targets, and referenced credential files are
mounted selectively; external credentials and installed plugin code are read-only.
Container cache persists separately, and OpenCode uses a private container server.

OpenCode uses host networking for local services such as Meridian. This removes
network isolation; `-p` mappings are ignored. Herdr context and its socket are
forwarded when available. Claude networking and launch behavior are unchanged.
```

Document that `--server` conflicts with managed private-server execution. Update rebuild documentation to include helper/version changes in addition to the existing 48-hour refresh. Correct development notes only where touched: installed V2, supported tools, helper responsibility, aliases, cache/state separation, and tests. Do not rewrite unrelated known issues or delete historical ocv documents.

- [ ] **Step 4: Run the full fast checks, then build the real image.**

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
bash -n agentbox entrypoint.sh tests/opencode-smoke.sh
node --check opencode-dependencies.cjs
shellcheck agentbox entrypoint.sh tests/opencode-smoke.sh
git diff --check
IFS= read -r -d '' first_worktree < <(git worktree list --porcelain -z)
main_checkout="${first_worktree#worktree }"
verification_dirs=()
[[ "$main_checkout" == "$PWD" ]] || verification_dirs=(--add-dir "$main_checkout")
./agentbox "${verification_dirs[@]}" --tool opencode --rebuild --version
```

Run the last command through a real terminal/pseudo-TTY, since the existing launcher uses `-it`. No `agentbox:latest` image currently exists, so this is a full first build and may take substantial time. Do not prune unrelated images or change the Java/toolchain versions to work around a build failure without a diagnosis and scope check.

The explicit main-checkout mount is for this repository's implementation worktree: Git's common metadata and OpenCode's saved canonical checkout otherwise lie outside the mounted worktree. It uses existing `--add-dir` behavior and does not authorize mounting unrelated repositories or add automatic whole-checkout discovery to AgentBox.

Expected: official V2 installation and helper/parser are present; the version matches the currently detected host V2 version; no ocv executable is installed. Record build errors honestly and diagnose their origin before changing code.

- [ ] **Step 5: Exercise the completed container using read-only checks.** From the worktree containing the implementation, use a real terminal:

```bash
IFS= read -r -d '' first_worktree < <(git worktree list --porcelain -z)
main_checkout="${first_worktree#worktree }"
verification_dirs=()
[[ "$main_checkout" == "$PWD" ]] || verification_dirs=(--add-dir "$main_checkout")
./agentbox "${verification_dirs[@]}" --tool opencode shell bash tests/opencode-smoke.sh
./agentbox "${verification_dirs[@]}" --tool opencode shell bash tests/opencode-smoke.sh \
    --require-plugin /usr/lib/meridian/dist/meridian-v2 \
    --require-mcp interbase_nrf01 --require-mcp interbase_reference \
    --require-mcp interbase_centrale --require-mcp interbase_todos \
    --require-mcp interbase_mdevapps \
    --disabled-mcp rdbg_x64 --disabled-mcp rdbg_x86 \
    --disabled-mcp rdbg_vm_x64 --disabled-mcp rdbg_vm_x86 \
    --meridian-url http://127.0.0.1:3456/v1/models
```

Separately exercise managed `agentbox --tool opencode api get /api/info`, with the same explicit main-checkout directory flag when needed, to verify Task 3's private-server flag routing; only server metadata is printed. The smoke script connects to its owned private child for the extended checks. Do not publish full catalogs or logs that could include sensitive configuration. Assert the container server's state/identity differs from the existing host service and its mounted data directory is the approved shared directory. Do not stop, restart, interrupt, migrate manually, or modify the host service/database.

Open the actual TUI and inspect provider-indicator and Herdr CLI plugin loading without sending a prompt or selecting/resuming an active host session. Run this renderer-only check inside the selected container shell with a fresh container-local `XDG_DATA_HOME` and `HERDR_ENV=0`, so global tab restoration cannot activate a host session and Herdr cannot reassign the live pane. Headless checks already exercised the approved shared data and real socket; unit fixtures exercise Herdr reporting. Check all configured server plugin IDs/sources (Meridian/Jev/routing/Superpowers/safety-net), agent/command/skill catalogs, enabled remote MCP connections, and disabled debugger status. If an external service is down or credentials are unavailable, report that integration as blocked; do not claim full parity from `--version` alone.

Check a second container launch for cache reuse and absence of AgentBox-driven config/auth replacement or conversion. Record a legitimate OpenCode credential refresh separately if it occurs; do not restore stale host credentials to force a byte-hash match. Do not compare live SQLite byte hashes while the host is active; shared session data is intentionally writable. Fixture-only tests cover migrations and destructive cases.

- [ ] **Step 6: Perform final correctness review, rerun verification, and commit.** Load requesting-code-review at this boundary. Use Jev with the whole implementation branch, the approved spec, and the actual selected execution/review policy. Native execution's independent reviewer runs only after the user has authorized that execution method; otherwise review inline. Check all five Review Focus items and every spec section against implemented code and actual evidence.

```bash
NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
bash -n agentbox entrypoint.sh tests/opencode-smoke.sh
node --check opencode-dependencies.cjs
git diff --check
git status --short
git add README.md DEVELOPMENT_NOTES.md tests/opencode-smoke.sh tests/agentbox.test.cjs
git commit -m "docs: verify and document OpenCode V2 host parity"
```

Use verification-before-completion before reporting success. Summarize only observed results and outstanding integration blockers. Do not merge, push, or remove the worktree without the user's selected finishing action.

## Plan self-review and execution handoff

- [x] Confirm Task 1 covers version selection, build compatibility, install/removal, and unchanged Claude behavior.
- [x] Confirm Task 2 covers JSONC, native/legacy declarations, external files/plugins/skills, project discovery, path-only errors, and symlink metadata.
- [x] Confirm Task 3 covers probe closure, alias mounts, required/optional failures, read-only overlays, networking/ports, Herdr, private-server arguments, `.env` runtime selectors, and isolated cache/state.
- [x] Confirm Task 4 covers actual image/TUI/catalog/network/MCP checks, no paid requests/session mutation, documentation, and honest blockers.
- [x] Confirm each Review Focus item has an owning task's test and no interface/record-name mismatch exists between Task 2 and Task 3.
- [x] Scan for placeholder markers, unspecified types/functions, unsafe generic deletes, V1 package/API syntax, and user-secret exposure; fix findings inline.
- [ ] Link this plan for review and obtain an execution-method selection before implementation.

Self-review performed inline; Jev review selection fell back because the request exceeded its size limit, and no independent reviewer or implementer has run. Syntax-checked the plan's 14 JavaScript and 25 Bash fences: zero syntax failures. No unresolved placeholder markers remain. These are documentation checks, not executed product tests or implementation verification.

Recommended execution: **Native**, because four sequential tasks share tight version/discovery/runtime interfaces, and one final independent whole-branch review provides a useful fresh check without per-task agent overhead. Subagent-driven execution remains an option if the user prefers independent implementation and review gates for every task.
