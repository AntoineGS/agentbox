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
  for (const runtime of ['docker', 'podman']) {
    fs.writeFileSync(path.join(bin, runtime), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, bin };
}

function bash(f, body, args = []) {
  const library = path.join(f.home, 'agentbox-library.sh');
  const source = fs.readFileSync(path.join(repo, 'agentbox'), 'utf8')
    .replace(/\n# Run main function\nmain "\$@"\s*$/, '\n');
  fs.writeFileSync(library, source);
  return spawnSync('bash', ['--noprofile', '--norc', '-c',
    'set -euo pipefail; source "$AGENTBOX_TEST_SOURCE"; shift; ' + body,
    'agentbox-test', repo, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, AGENTBOX_TEST_SOURCE: library },
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
    { env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid tool/);
  assert.match(result.stderr, /claude.*opencode/);
});

test('sourcing agentbox defines functions without running the CLI', t => {
  const f = fixture(t);
  const marker = path.join(f.home, 'runtime-called');
  for (const runtime of ['docker', 'podman']) {
    fs.writeFileSync(path.join(f.bin, runtime), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c',
    'source "$1/agentbox"; declare -F parse_opencode_version', 'source-test', repo], {
    cwd: repo,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parse_opencode_version/);
  assert.equal(fs.existsSync(marker), false);
});

test('version changes change the image hash', t => {
  const f = fixture(t);
  const a = bash(f, 'OPENCODE_VERSION=2.0.18; calculate_image_hash');
  const b = bash(f, 'OPENCODE_VERSION=2.0.19; calculate_image_hash');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(a.stdout, b.stdout);
});

test('host OpenCode version selection rejects V1, accepts V2, and keeps Claude usable', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'opencode'), '#!/bin/sh\nprintf "%s\\n" "1.18.10"\n', { mode: 0o755 });
  assert.notEqual(bash(f, 'select_opencode_version opencode').status, 0);
  assert.equal(bash(f, 'select_opencode_version claude').stdout.trim(), '2');

  fs.writeFileSync(path.join(f.bin, 'opencode'), '#!/bin/sh\nprintf "%s\\n" "opencode v2.0.19"\n', { mode: 0o755 });
  assert.equal(bash(f, 'select_opencode_version opencode').stdout.trim(), '2.0.19');
});

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

test('missing host OpenCode selects the stable V2 range', t => {
  const f = fixture(t);
  const result = bash(f,
    'command() { if [[ "$1" == -v && "$2" == opencode ]]; then return 1; fi; builtin command "$@"; }; select_opencode_version opencode');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2');
});

test('image compatibility hash includes helper contents', t => {
  const f = fixture(t);
  const dependency = path.join(f.home, 'dependencies.cjs');
  fs.writeFileSync(dependency, 'first');
  const a = bash(f, 'DEPENDENCIES_PATH="$1"; calculate_image_hash', [dependency]);
  fs.writeFileSync(dependency, 'second');
  const b = bash(f, 'DEPENDENCIES_PATH="$1"; calculate_image_hash', [dependency]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(a.stdout, b.stdout);
});

test('rebuild policy notices missing image, changed hash, and images at least 48 hours old', t => {
  const f = fixture(t);
  const runtime = path.join(f.bin, 'runtime');
  const state = path.join(f.home, 'runtime-state');
  fs.writeFileSync(runtime, `#!/bin/sh
if [ "$1" = image ] && [ "$2" = inspect ]; then
  [ -f '${state}' ]
  exit
fi
if [ "$1" = inspect ]; then
  case "$*" in
    *agentbox.hash*) cat '${state}' | cut -d' ' -f1 ;;
    *agentbox.built*) cat '${state}' | cut -d' ' -f2- ;;
  esac
fi
`, { mode: 0o755 });
  const helper = path.join(f.home, 'helper.cjs');
  fs.writeFileSync(helper, 'first');
  const policy = 'RUNTIME=runtime; DEPENDENCIES_PATH="$HOME/helper.cjs"; OPENCODE_VERSION=2.0.19; if needs_rebuild; then echo rebuild; else echo current; fi';
  const current = bash(f, 'RUNTIME=runtime; DEPENDENCIES_PATH="$HOME/helper.cjs"; OPENCODE_VERSION=2.0.19; calculate_image_hash', []);
  assert.equal(current.status, 0, current.stderr);
  const hash = current.stdout.trim();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(state, `${hash} ${now}`);
  assert.equal(bash(f, policy).stdout.trim(), 'current');
  assert.equal(bash(f, policy.replace('OPENCODE_VERSION=2.0.19', 'OPENCODE_VERSION=2.0.20')).stdout.trim(), 'rebuild');
  fs.writeFileSync(helper, 'changed');
  assert.equal(bash(f, policy).stdout.trim(), 'rebuild');
  fs.writeFileSync(state, `wrong ${now}`);
  assert.equal(bash(f, policy).stdout.trim(), 'rebuild');
  const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const changed_hash = bash(f, 'RUNTIME=runtime; DEPENDENCIES_PATH="$HOME/helper.cjs"; OPENCODE_VERSION=2.0.19; calculate_image_hash').stdout.trim();
  fs.writeFileSync(state, `${changed_hash} ${old}`);
  assert.equal(bash(f, policy).stdout.trim(), 'rebuild');
  fs.rmSync(state);
  assert.equal(bash(f, policy).stdout.trim(), 'rebuild');
});

test('production files no longer install or launch ocv', () => {
  const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /@opencode\/cli/);
  assert.doesNotMatch(dockerfile, /@leohenon\/ocv/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'entrypoint.sh'), 'utf8'), /\bocv\b/);
});
