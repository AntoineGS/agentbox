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

test('private launch rejects server selection but not literal option values', t => {
  const f = fixture(t);
  for (const args of [['--server', 'http://127.0.0.1:4096'],
    ['api', '--server=http://127.0.0.1:4096', 'get', '/api/info']]) {
    assert.notEqual(bash(f, 'validate_opencode_server_args "$@"', args).status, 0);
  }
  assert.equal(bash(f, 'validate_opencode_server_args "$@"', ['--prompt', '--server']).status, 0);
  assert.equal(bash(f, 'validate_opencode_server_args "$@"', ['run', '--', '--server']).status, 0);
});

test('credential mounts are individual read-only files', t => {
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

test('mount registry deduplicates equal mounts and rejects conflicting modes', t => {
  const f = fixture(t);
  const dir = path.join(f.home, 'specific'); fs.mkdirSync(dir);
  const same = bash(f,
    'declare -a output=(); declare -A seen=(); append_opencode_mount output "$1" /fixture ro seen; ' +
    'append_opencode_mount output "$1" /fixture ro seen; printf "%s\\n" "${output[@]}"', [dir]);
  assert.equal(same.status, 0, same.stderr);
  assert.equal((same.stdout.match(/-v/g) || []).length, 1);
  const conflict = bash(f,
    'declare -a output=(); declare -A seen=(); append_opencode_mount output "$1" /fixture ro seen; ' +
    'append_opencode_mount output "$1" /fixture rw seen', [dir]);
  assert.notEqual(conflict.status, 0);
});

test('mount validation rejects broad roots and unsafe delimiters', t => {
  const f = fixture(t);
  const dir = path.join(f.home, 'specific'); fs.mkdirSync(dir);
  for (const [source, destination] of [[f.home, f.home], [dir, '/fixture:bad'],
    [dir, '/fixture\tbad'], [path.join(f.home, 'missing'), '/fixture']]) {
    assert.notEqual(bash(f,
      'declare -a output=(); declare -A seen=(); append_opencode_mount output "$1" "$2" ro seen',
      [source, destination]).status, 0);
  }
});

test('mount aliases resolve multi-hop symlinks without broadening to sibling repositories', t => {
  const f = fixture(t);
  const actual = path.join(f.home, 'config-target'); fs.mkdirSync(actual);
  const link2 = path.join(f.home, 'config-link-two'); fs.symlinkSync(actual, link2);
  const link1 = path.join(f.home, 'config-link-one'); fs.symlinkSync(link2, link1);
  const result = bash(f,
    'declare -a output=(); declare -A seen=(); ' +
    'append_opencode_mount output "$1" "$1" ro seen; ' +
    'append_opencode_mount output "$2" "$2" ro seen; printf "%s\\n" "${output[@]}"', [link1, actual]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${actual}:${link1}:ro`));
  assert.ok(!result.stdout.includes(`${path.dirname(f.home)}:`));
});

test('mount appender rejects a host home root without printing credential contents', t => {
  const f = fixture(t); const secret = path.join(f.home, 'credential');
  fs.writeFileSync(secret, 'TOP_SECRET_VALUE');
  const result = bash(f,
    'declare -a output=(); declare -A seen=(); append_opencode_mount output "$1" "$1" ro seen', [f.home]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /TOP_SECRET_VALUE/);
});

test('Herdr forwards only allowlisted context and mounts socket aliases alone', async t => {
  const f = fixture(t);
  const real = path.join(f.home, 'socket-dir'); const alias = path.join(f.home, 'socket-alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias);
  const actual = path.join(real, 'herdr.sock'); const advertised = path.join(alias, 'herdr.sock');
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(actual, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = bash(f,
    'export HERDR_ENV=1 HERDR_SOCKET_PATH="$1" HERDR_PANE_ID=pane HERDR_TAB_ID=tab ' +
    'HERDR_WORKSPACE_ID=workspace HERDR_SECRET=fixture-secret OPENCODE_SESSION_ID=host-session; ' +
    'declare -a output=(); build_herdr_args output; printf "%s\\n" "${output[@]}"', [advertised]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes(`${actual}:${advertised}:ro`), `${result.stdout}\n${result.stderr}`);
  for (const id of ['HERDR_PANE_ID=pane', 'HERDR_TAB_ID=tab', 'HERDR_WORKSPACE_ID=workspace']) assert.match(result.stdout, new RegExp(id));
  assert.doesNotMatch(result.stdout, /HERDR_SECRET|OPENCODE_SESSION_ID/);
  assert.ok(!result.stdout.includes(`${real}:${real}:`));
});

test('missing Herdr socket warns without adding integration mounts and absent context is silent', t => {
  const f = fixture(t); const missing = path.join(f.home, 'missing.sock');
  const present = bash(f, 'unset HERDR_ENV; declare -a output=(); build_herdr_args output; printf "COUNT=%s\\n" "${#output[@]}"');
  assert.equal(present.status, 0, present.stderr); assert.doesNotMatch(present.stderr, /socket/i);
  const result = bash(f,
    'export HERDR_ENV=1 HERDR_SOCKET_PATH="$1"; declare -a output=(); build_herdr_args output; printf "COUNT=%s\\n" "${#output[@]}"', [missing]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout + result.stderr, /socket/i);
  assert.match(result.stdout, /COUNT=0/);
});

test('probe closure is iterative, credentials are read-only, and cache is isolated', t => {
  const f = fixture(t);
  const dependencyRoot = path.join(f.home, 'plugin-root'); fs.mkdirSync(dependencyRoot);
  const dependency = path.join(dependencyRoot, 'credential'); fs.writeFileSync(dependency, 'fixture');
  const count = path.join(f.home, 'probe-count');
  const probeArgv = path.join(f.home, 'probe-argv.bin');
  fs.writeFileSync(path.join(f.bin, 'runtime'), `#!/bin/sh
n=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); printf '%s' "$n" > '${count}'
printf '%s\\0' "$@" > '${probeArgv}'
if [ "$n" -eq 1 ]; then
  printf 'rw\\troot\\t1\\t%s\\n' '${dependencyRoot}'
  printf 'ro\\tfile\\t1\\t%s\\n' '${dependency}'
fi
`, { mode: 0o755 });
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output projectfixture; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(count, 'utf8'), '2');
  assert.ok(result.stdout.includes(`${dependency}:${dependency}:ro`), `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes(`${dependencyRoot}:${dependencyRoot}:rw`));
  assert.ok(result.stdout.indexOf(`${dependencyRoot}:${dependencyRoot}:rw`) < result.stdout.indexOf(`${dependency}:${dependency}:ro`));
  assert.ok(result.stdout.includes('/home/agent/.cache/opencode:rw'));
  assert.doesNotMatch(result.stdout, /\.local\/state\/opencode/);
  const probeArguments = fs.readFileSync(probeArgv).toString().split('\0').filter(Boolean);
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/bash']) {
    assert.ok(probeArguments.includes(flag), `probe should include ${flag}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(f.home, '.cache/agentbox/projectfixture')), ['opencode']);
});

test('OpenCode config symlink roots are exposed at lexical, canonical, and container aliases', t => {
  const f = fixture(t);
  const canonical = path.join(f.home, 'config-repository'); fs.mkdirSync(canonical);
  fs.mkdirSync(path.join(f.home, '.config'), { recursive: true });
  fs.symlinkSync(canonical, path.join(f.home, '.config/opencode'));
  fs.writeFileSync(path.join(f.bin, 'runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output aliasproject; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  for (const mount of [
    `${canonical}:${path.join(f.home, '.config/opencode')}:rw`,
    `${canonical}:${canonical}:rw`,
    `${canonical}:/home/agent/.config/opencode:rw`,
  ]) assert.ok(result.stdout.includes(mount), `${result.stdout}\nmissing ${mount}`);
});

test('a malformed required dependency manifest prevents the main runtime launch', t => {
  const f = fixture(t); const count = path.join(f.home, 'runtime-count');
  for (const record of ['invalid\\trole\\t2\\t/path\\n',
    `ro\\tfile\\t1\\t${path.join(f.home, 'missing-required')}\\n`]) {
    fs.rmSync(count, { force: true });
    fs.writeFileSync(path.join(f.bin, 'runtime'), `#!/bin/sh
n=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); printf '%s' "$n" > '${count}'
printf '${record}'
`, { mode: 0o755 });
    const result = bash(f,
      'RUNTIME=runtime; declare -a dirs=() ports=(); run_container name projectfixture dirs opencode false false false ports false');
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(count, 'utf8'), '1');
  }
});

test('managed OpenCode command pins standalone and quotes prompt data literally', t => {
  const f = fixture(t);
  const sentinel = path.join(f.home, 'prompt-injection');
  const capture = path.join(f.home, 'argv.bin');
  fs.writeFileSync(path.join(f.home, '.zshrc'), '');
  fs.writeFileSync(path.join(f.bin, 'opencode'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${capture}'\n`, { mode: 0o755 });
  const prompt = `literal spaces 'quotes' $(touch ${sentinel}); semicolon`;
  const result = bash(f,
    'declare -a cmd=(); build_container_cmd cmd false false opencode --prompt "$1"; "${cmd[@]}"', [prompt]);
  assert.equal(result.status, 0, result.stderr);
  const argv = fs.readFileSync(capture).toString().split('\0').filter(Boolean);
  assert.deepEqual(argv, ['--standalone', '--prompt', prompt]);
  assert.equal(fs.existsSync(sentinel), false);
});

test('Claude managed command retains its permission option', t => {
  const f = fixture(t);
  const result = bash(f, 'declare -a cmd=(); build_container_cmd cmd false false claude; printf "%s\\n" "${cmd[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude --dangerously-skip-permissions/);
});

test('OpenCode runtime selectors override injected state paths only for OpenCode', t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(repo, 'entrypoint.sh'), 'utf8');
  const branch = source.match(/if \[\[ "\$\{TOOL:-\}" == opencode \]\]; then\n[\s\S]*?\nfi/);
  assert.ok(branch, 'OpenCode runtime branch must exist');
  const foreign = path.join(f.home, 'foreign-state'); fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'sentinel'), 'unchanged');
  for (const tool of ['opencode', 'claude']) {
    const result = spawnSync('bash', ['-c', branch[0] +
      '\nprintf "%s|%s|%s|%s|%s|%s|%s\\n" "$OPENCODE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "${OPENCODE_SESSION_ID:-}" "$ANTHROPIC_API_KEY"'], {
      env: { ...process.env, HOME: f.home, TOOL: tool, OPENCODE_CONFIG_DIR: foreign,
        XDG_CONFIG_HOME: foreign, XDG_DATA_HOME: foreign, XDG_CACHE_HOME: foreign,
        XDG_STATE_HOME: foreign, OPENCODE_SESSION_ID: 'host-session', ANTHROPIC_API_KEY: 'preserved' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = tool === 'opencode'
      ? [`${f.home}/.config/opencode`, `${f.home}/.config`, `${f.home}/.local/share`, `${f.home}/.cache`, `${f.home}/.local/state`, '', 'preserved']
      : [foreign, foreign, foreign, foreign, foreign, 'host-session', 'preserved'];
    assert.deepEqual(result.stdout.trim().split('|'), expected);
  }
  assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'unchanged');
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
