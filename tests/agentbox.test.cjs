const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');

function fixture(t) {
  const fixtureRoot = process.env.AGENTBOX_TEST_TMPDIR || '/tmp/opencode';
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(fixtureRoot, 'agentbox-test-'));
  const tmpdir = path.join(home, 'tmp');
  const bin = path.join(home, 'bin');
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(tmpdir);
  fs.mkdirSync(bin);
  fs.mkdirSync(projectDir);
  for (const runtime of ['docker', 'podman']) {
    fs.writeFileSync(path.join(bin, runtime), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, bin, projectDir, tmpdir };
}

function bash(f, body, args = []) {
  return spawnSync('bash', ['--noprofile', '--norc', '-c',
    'set -euo pipefail; source "$1/agentbox"; shift; ' +
    'dirname() { if [[ "${@: -1}" == "$HOME" ]]; then printf "/\\n"; else command dirname "$@"; fi; }; ' + body,
    'agentbox-test', repo, ...args], {
    cwd: f.projectDir,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

function useRealDependencyHelper(f, mountVisible = false) {
  const helper = path.join(repo, 'opencode-dependencies.cjs');
  const runtime = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const helper = ${JSON.stringify(helper)};
const marker = process.argv.indexOf('agentbox-discovery');
if (marker < 0) process.exit(97);
if (${mountVisible}) {
  const { discover } = require(helper);
  const mounts = [];
  for (let i = 2; i < marker; i++) {
    if (process.argv[i] === '-v') {
      const [source, destination] = process.argv[++i].split(':');
      mounts.push({ source, destination });
    }
  }
  require(${JSON.stringify(path.join(repo, 'tests/probe-visible-fs.cjs'))})(mounts);
  const { values } = require('node:util').parseArgs({ args: process.argv.slice(marker + 1), options: {
    home: { type: 'string' }, config: { type: 'string' }, project: { type: 'string' },
    scan: { type: 'string', multiple: true },
  } });
  for (const r of discover({ home: values.home, configDir: values.config,
    projectDir: values.project, scanRoots: values.scan })) {
    process.stdout.write([r.mode, r.role, Number(r.required), r.path].join('\\t') + '\\n');
  }
  process.exit(0);
}
const result = spawnSync(process.execPath, [helper, ...process.argv.slice(marker + 1)], {
  env: process.env, encoding: 'utf8',
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`;
  fs.writeFileSync(path.join(f.bin, 'runtime'), runtime, { mode: 0o755 });
}

function smokeEnvironment(f, record, overrides = {}) {
  const env = { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`,
    TOOL: 'opencode', AGENTBOX_OPENCODE_VERSION: '2', RECORD: record,
    OPENCODE_CONFIG_DIR: `${f.home}/.config/opencode`,
    XDG_STATE_HOME: `${f.home}/.local/state`, TMPDIR: f.tmpdir };
  delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_SERVER_PASSWORD;
  for (const name of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

function writeSmokeOpenCode(f, { version = '2.0.19', plugins, agents, skills, commands,
  mcps, delayedCatalogs = {}, delayedLocationActivationMs = 0, catalogLocation,
  requirePrivatePassword = false,
  apiErrorEndpoint, failEndpoint } = {}) {
  const record = path.join(f.home, 'smoke-calls.jsonl');
  const pluginCatalog = plugins ?? { data: [{ id: 'fixture-plugin',
    source: { path: '/fixture/plugins/source-plugin', target: '/fixture/plugins/source-plugin' },
    state: { status: 'active' }, description: 'CATALOG_CONTENT_FIXTURE' }] };
  const agentCatalog = agents ?? { data: [] };
  const skillCatalog = skills ?? { data: [] };
  const commandCatalog = commands ?? { data: [] };
  const mcpCatalog = mcps ?? { data: [
    { name: 'connected-fixture', status: { status: 'connected' } },
    { name: 'disabled-fixture', status: { status: 'disabled', error: 'MCP_ERROR_FIXTURE' } },
  ] };
  const program = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({ args, pid: process.pid,
  passwordPresent: Boolean(process.env.OPENCODE_PASSWORD),
  legacyPasswordPresent: Object.hasOwn(process.env, 'OPENCODE_SERVER_PASSWORD') }) + '\\n');
if (args[0] === '--version') { process.stdout.write('opencode v${version}\\n'); process.exit(0); }
if (args[0] === 'serve') {
  const startedAt = Date.now();
  let firstPluginRequestAt;
  const catalogs = { '/api/plugin': ${JSON.stringify(pluginCatalog)}, '/api/agent': ${JSON.stringify(agentCatalog)},
    '/api/skill': ${JSON.stringify(skillCatalog)}, '/api/command': ${JSON.stringify(commandCatalog)},
    '/api/mcp': ${JSON.stringify(mcpCatalog)} };
  const server = http.createServer((request, response) => {
    const endpoint = request.url;
    const requestAt = Date.now();
    if (endpoint === '/api/plugin' && firstPluginRequestAt === undefined) firstPluginRequestAt = requestAt;
    const authenticated = request.headers.authorization === 'Basic ' +
      Buffer.from('opencode:' + (process.env.OPENCODE_PASSWORD ?? '')).toString('base64');
    fs.appendFileSync(process.env.RECORD, JSON.stringify({ args: ['http', request.method, endpoint],
      pid: process.pid, authenticated, legacyPasswordPresent: Object.hasOwn(process.env, 'OPENCODE_SERVER_PASSWORD') }) + '\\n');
    if (${requirePrivatePassword} && !authenticated) {
      response.writeHead(401); response.end('PRIVATE_API_ERROR_FIXTURE'); return;
    }
    if (endpoint === ${JSON.stringify(failEndpoint ?? '')}) {
      response.writeHead(500); response.end('PRIVATE_API_ERROR_FIXTURE'); return;
    }
    let body = catalogs[endpoint] ?? { data: [] };
    const delayMs = (${JSON.stringify(delayedCatalogs)})[endpoint] ?? 0;
    if (Date.now() - startedAt < delayMs) body = { data: [] };
    if (${delayedLocationActivationMs} && firstPluginRequestAt !== undefined &&
        Date.now() - firstPluginRequestAt < ${delayedLocationActivationMs}) body = { data: [] };
    if (endpoint !== '/api/info') body = { location: { directory: ${JSON.stringify(catalogLocation ?? null)} ?? process.cwd() }, ...body };
    if (endpoint === ${JSON.stringify(apiErrorEndpoint ?? '')}) body = { error: { name: 'Forbidden', message: 'SENSITIVE_API_ERROR_FIXTURE' } };
    fs.appendFileSync(process.env.RECORD, JSON.stringify({ args: ['response', endpoint], at: requestAt,
      elapsedSinceLocationWarmup: firstPluginRequestAt === undefined ? null : requestAt - firstPluginRequestAt,
      returnedEntries: Array.isArray(body.data) ? body.data.length : null }) + '\\n');
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write('server listening on http://127.0.0.1:' + server.address().port + '\\n'));
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
} else { process.exit(99); }
`;
  fs.writeFileSync(path.join(f.bin, 'opencode'), program, { mode: 0o755 });
  return record;
}

function runSmokeAsync(f, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(repo, 'tests/opencode-smoke.sh'), ...args], {
      cwd: f.projectDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

function smokeCalls(record) {
  return fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitForSmokeCall(record, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(record)) {
      try {
        const calls = smokeCalls(record);
        if (calls.some(predicate)) return calls;
      } catch { /* Wait for a complete recorder line. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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
  assert.equal(same.stdout.trim().split('\n').filter(argument => argument === '-v').length, 1);
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
  await new Promise(resolve => server.listen(path.relative(process.cwd(), actual), resolve));
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

test('Meridian configuration dependency is mounted at its container-home alias', t => {
  const f = fixture(t);
  const meridianConfig = path.join(f.home, '.config/meridian');
  fs.mkdirSync(meridianConfig, { recursive: true });
  fs.writeFileSync(path.join(f.bin, 'runtime'),
    `#!/bin/sh\nprintf 'rw\\troot\\t1\\t%s\\n' '${meridianConfig}'\n`, { mode: 0o755 });
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output meridianfixture; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${meridianConfig}:${meridianConfig}:rw`), result.stdout);
  assert.ok(result.stdout.includes(`${meridianConfig}:/home/agent/.config/meridian:rw`), result.stdout);
});

test('real helper file records overlay every writable config/data alias', t => {
  const f = fixture(t);
  const configDir = path.join(f.home, 'config-store'); fs.mkdirSync(configDir);
  fs.mkdirSync(path.join(f.home, '.config'), { recursive: true });
  const configAlias = path.join(f.home, '.config/opencode'); fs.symlinkSync(configDir, configAlias);
  const configCredential = path.join(configAlias, 'credential'); fs.writeFileSync(configCredential, 'CONFIG_SECRET_FIXTURE');
  const dataDir = path.join(f.home, '.local/share/opencode'); fs.mkdirSync(dataDir, { recursive: true });
  const dataCredential = path.join(dataDir, 'credential'); fs.writeFileSync(dataCredential, 'DATA_SECRET_FIXTURE');
  fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), JSON.stringify({
    mcp: { first: { headers: { Authorization: `{file:${configCredential}}` } },
      second: { headers: { Authorization: `{file:${dataCredential}}` } } },
  }));
  useRealDependencyHelper(f);
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output files; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  const mounts = result.stdout.split('\n');
  const hasMount = (source, destination) => mounts.includes(`${source}:${destination}:ro`);
  for (const destination of [
    configCredential,
    path.join(configDir, 'credential'),
    '/home/agent/.config/opencode/credential',
  ]) assert.ok(hasMount(path.join(configDir, 'credential'), destination), `${destination}\n${result.stdout}`);
  for (const destination of [
    dataCredential,
    '/home/agent/.local/share/opencode/credential',
  ]) assert.ok(hasMount(dataCredential, destination), `${destination}\n${result.stdout}`);
  assert.doesNotMatch(result.stdout + result.stderr, /CONFIG_SECRET_FIXTURE|DATA_SECRET_FIXTURE/);
});

test('real helper mounts sibling-prefix dependencies and excludes unrelated siblings', t => {
  const f = fixture(t);
  const configExtra = path.join(f.home, '.config/opencode-extra');
  const dataExtra = path.join(f.home, '.local/share/opencode-extra');
  const unrelated = path.join(f.home, '.config/opencode-unrelated');
  for (const dir of [configExtra, dataExtra, unrelated]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(f.home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.config/opencode/opencode.json'), JSON.stringify({
    plugins: [configExtra, dataExtra],
  }));
  useRealDependencyHelper(f);
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output siblings; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${configExtra}:${configExtra}:ro`));
  assert.ok(result.stdout.includes(`${dataExtra}:${dataExtra}:ro`));
  assert.ok(!result.stdout.includes(`${unrelated}:${unrelated}:`));
});

test('real helper closure mounts nested plugin package and multilevel external links only', t => {
  const f = fixture(t);
  const configDir = path.join(f.home, '.config/opencode'); fs.mkdirSync(configDir, { recursive: true });
  const repoRoot = path.join(f.home, 'plugin-repositories');
  const packageRoot = path.join(repoRoot, 'chosen-package');
  const siblingRepo = path.join(repoRoot, 'unrelated-repository');
  const pluginFile = path.join(packageRoot, 'dist/plugin.js');
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.mkdirSync(siblingRepo, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"chosen"}');
  fs.writeFileSync(pluginFile, 'module fixture');
  fs.mkdirSync(path.join(packageRoot, 'node_modules/chosen-dependency'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'node_modules/chosen-dependency/index.js'), 'dependency fixture');
  const externalParent = path.join(f.home, 'external-plugin-repositories');
  const externalPlugin = path.join(externalParent, 'selected-plugin');
  const externalSibling = path.join(externalParent, 'unrelated-sibling');
  fs.mkdirSync(externalPlugin, { recursive: true }); fs.mkdirSync(externalSibling);
  fs.writeFileSync(path.join(externalPlugin, 'plugin.js'), 'external fixture');
  const middleLink = path.join(f.home, 'external-plugin-middle'); fs.symlinkSync(externalPlugin, middleLink);
  const firstLink = path.join(configDir, 'plugins/external-entry');
  fs.mkdirSync(path.dirname(firstLink), { recursive: true }); fs.symlinkSync(middleLink, firstLink);
  fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ plugins: [pluginFile, firstLink] }));
  useRealDependencyHelper(f);
  const result = bash(f,
    'declare -a output=(); RUNTIME=runtime; build_opencode_mounts output closure; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${packageRoot}:${packageRoot}:ro`), result.stdout);
  assert.ok(!result.stdout.includes(`${pluginFile}:${pluginFile}:ro`), result.stdout);
  assert.ok(fs.readdirSync(path.join(packageRoot, 'node_modules')).includes('chosen-dependency'));
  assert.ok(result.stdout.includes(`${externalPlugin}:${middleLink}:ro`));
  assert.ok(result.stdout.includes(`${externalPlugin}:${externalPlugin}:ro`));
  assert.ok(!result.stdout.includes(`${siblingRepo}:${siblingRepo}:`));
  assert.ok(!result.stdout.includes(`${externalSibling}:${externalSibling}:`));
});

test('fix wave I1 mount-visible project and ancestor documents retain lexical declarations and link aliases', t => {
  const f = fixture(t);
  const external = path.join(f.home, 'external'); fs.mkdirSync(external);
  const plugins = [path.join(f.projectDir, 'chosen'), path.join(f.home, 'ancestor-chosen')];
  plugins.forEach(p => fs.mkdirSync(p));
  for (const [index, defining] of [path.join(f.projectDir, 'opencode.json'), path.join(f.home, 'opencode.json')].entries()) {
    const settings = path.join(external, `settings-${index}.json`);
    const middle = path.join(external, `middle-${index}.json`);
    fs.writeFileSync(settings, JSON.stringify({ plugins: [index ? './ancestor-chosen' : './chosen'] }));
    fs.symlinkSync(settings, middle); fs.symlinkSync(middle, defining);
  }
  useRealDependencyHelper(f, true);
  const result = bash(f, 'RUNTIME=runtime; declare -a output=(); build_opencode_mounts output visible; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  for (const p of plugins) assert.ok(result.stdout.includes(`${p}:${p}:ro`), result.stdout);
  for (const index of [0, 1]) assert.ok(result.stdout.includes(`${external}/settings-${index}.json:${external}/middle-${index}.json:ro`));
  assert.ok(!result.stdout.includes(`${f.home}:${f.home}:`));
  assert.ok(!result.stdout.includes(`${external}:${external}:`));
});

test('fix wave I2 standalone explicit and auto-discovered plugin entries include adjacent modules selectively', t => {
  const f = fixture(t);
  const config = path.join(f.home, '.config/opencode'); fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
  const parents = ['explicit', 'automatic'].map(name => path.join(f.home, 'code', name));
  for (const parent of parents) {
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'plugin.js'), "import './helper.js'; throw new Error('NEVER_EXECUTE');");
    fs.writeFileSync(path.join(parent, 'helper.js'), 'adjacent fixture');
  }
  fs.mkdirSync(path.join(f.home, 'code/unrelated'));
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ plugins: [path.join(parents[0], 'plugin.js')] }));
  fs.symlinkSync(path.join(parents[1], 'plugin.js'), path.join(config, 'plugins/automatic.js'));
  useRealDependencyHelper(f, true);
  const result = bash(f, 'RUNTIME=runtime; declare -a output=(); build_opencode_mounts output adjacent; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  for (const parent of parents) assert.ok(result.stdout.includes(`${parent}:${parent}:ro`), result.stdout);
  assert.ok(!result.stdout.includes(`${f.home}/code:${f.home}/code:`));
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_EXECUTE/);
});

test('fix wave I2 multihop automatic plugin file aliases do not expand intermediate ancestors', t => {
  const f = fixture(t);
  const config = path.join(f.home, '.config/opencode'); fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
  const selected = path.join(f.home, 'code/selected'); fs.mkdirSync(selected, { recursive: true });
  const entry = path.join(selected, 'plugin.js'); fs.writeFileSync(entry, "import './helper.js';");
  fs.writeFileSync(path.join(selected, 'helper.js'), 'fixture');
  const middle = path.join(f.home, 'middle.js'); fs.symlinkSync(entry, middle);
  fs.symlinkSync(middle, path.join(config, 'plugins/automatic.js'));
  useRealDependencyHelper(f, true);
  const result = bash(f, 'RUNTIME=runtime; declare -a output=(); build_opencode_mounts output chain; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${selected}:${selected}:ro`), result.stdout);
  assert.ok(result.stdout.includes(`${entry}:${middle}:ro`), result.stdout);
  assert.ok(!result.stdout.includes(`${f.home}:${f.home}:`));
});

test('fix wave I3 regular node_modules linked dependency trees close without unrelated workspaces', t => {
  const f = fixture(t);
  const config = path.join(f.home, '.config/opencode'); fs.mkdirSync(config, { recursive: true });
  const pkg = path.join(f.home, 'package');
  const linked = path.join(f.home, 'workspace/linked');
  const nested = path.join(f.home, 'workspace/nested');
  for (const p of [pkg, linked, nested]) fs.mkdirSync(path.join(p, 'node_modules/@scope'), { recursive: true });
  fs.mkdirSync(path.join(f.home, 'workspace/unrelated'));
  fs.symlinkSync(linked, path.join(pkg, 'node_modules/@scope/linked'));
  fs.symlinkSync(nested, path.join(linked, 'node_modules/nested'));
  fs.symlinkSync(pkg, path.join(nested, 'node_modules/cycle'));
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ plugins: [pkg] }));
  useRealDependencyHelper(f, true);
  const result = bash(f, 'RUNTIME=runtime; declare -a output=(); build_opencode_mounts output linked; printf "%s\\n" "${output[@]}"');
  assert.equal(result.status, 0, result.stderr);
  for (const p of [linked, nested]) assert.ok(result.stdout.includes(`${p}:${p}:ro`), result.stdout);
  assert.ok(!result.stdout.includes(`${f.home}/workspace:${f.home}/workspace:`));
});

test('fix wave I4 full writable inventory protects package caches history project and additional aliases', t => {
  const f = fixture(t);
  const config = path.join(f.home, '.config/opencode'); fs.mkdirSync(config, { recursive: true });
  const extra = path.join(f.home, 'extra'); fs.mkdirSync(extra);
  const pairs = ['npm', 'pip', 'maven', 'gradle'].map((name, i) => [
    path.join(f.home, '.cache/agentbox/inventory', name),
    ['/home/agent/.npm', '/home/agent/.cache/pip', '/home/agent/.m2', '/home/agent/.gradle'][i],
  ]);
  pairs.push([path.join(f.home, '.agentbox/projects/inventory/history'), '/home/agent/.shell_history'],
    [f.projectDir, f.projectDir], [extra, extra]);
  for (const [source] of pairs) { fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'referenced'), 'PRIVATE_FIXTURE'); }
  fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ refs: pairs.map(([p]) => `{file:${p}/referenced}`) }));
  useRealDependencyHelper(f, true);
  const result = bash(f, 'RUNTIME=runtime; declare -a output=() dirs=("$1"); build_mount_opts output inventory opencode dirs "$PROJECT_DIR"; printf "%s\\n" "${output[@]}"', [extra]);
  assert.equal(result.status, 0, result.stderr);
  for (const [source, destination] of pairs) assert.ok(result.stdout.includes(`${source}/referenced:${destination}/referenced:ro`), result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_FIXTURE/);
});

test('failed probe restores the caller RETURN trap and removes its private temp directory', t => {
  const f = fixture(t); const parent = path.join(f.home, '.cache/agentbox/trapfixture');
  fs.writeFileSync(path.join(f.bin, 'runtime'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
  const result = bash(f,
    'RUNTIME=runtime; trap \'printf CALLER_RETURN_TRAP >&2\' RETURN; ' +
    'declare -a output=(); if build_opencode_mounts output trapfixture; then exit 91; fi; ' +
    'trap -p RETURN; trap - RETURN');
  assert.notEqual(result.status, 91);
  assert.match(result.stdout + result.stderr, /CALLER_RETURN_TRAP/);
  assert.deepEqual(fs.readdirSync(parent), ['opencode']);
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

test('managed API and run commands receive standalone after their subcommand', t => {
  const f = fixture(t);
  const capture = path.join(f.home, 'argv.bin');
  fs.writeFileSync(path.join(f.home, '.zshrc'), '');
  fs.writeFileSync(path.join(f.bin, 'opencode'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${capture}'\n`, { mode: 0o755 });
  for (const [args, expected] of [
    [['api', 'get', '/api/info'], ['api', '--standalone', 'get', '/api/info']],
    [['run', 'fixture request'], ['run', '--standalone', 'fixture request']],
  ]) {
    const result = bash(f,
      'declare -a cmd=(); build_container_cmd cmd false false opencode "$@"; "${cmd[@]}"', args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(capture).toString().split('\0').filter(Boolean), expected);
  }
});

test('OpenCode managed commands continue after a nonzero zsh rc while Claude keeps its existing gate', t => {
  const f = fixture(t);
  const capture = path.join(f.home, 'opencode-argv.bin');
  const claudeCapture = path.join(f.home, 'claude-called');
  fs.writeFileSync(path.join(f.home, '.zshrc'), 'return 1\n');
  fs.writeFileSync(path.join(f.bin, 'zsh'), '#!/bin/sh\nexec bash -c "$2"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(f.bin, 'opencode'),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${capture}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f.bin, 'claude'),
    `#!/bin/sh\nprintf called > '${claudeCapture}'\n`, { mode: 0o755 });

  const openCode = bash(f,
    'declare -a cmd=(); build_container_cmd cmd false false opencode api get /api/info; "${cmd[@]}"');
  assert.equal(openCode.status, 0, openCode.stderr);
  assert.deepEqual(fs.readFileSync(capture).toString().split('\0').filter(Boolean),
    ['api', '--standalone', 'get', '/api/info']);

  const claude = bash(f,
    'declare -a cmd=(); build_container_cmd cmd false false claude; "${cmd[@]}"');
  assert.notEqual(claude.status, 0);
  assert.equal(fs.existsSync(claudeCapture), false);
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

test('smoke rejects a version mismatch before starting its private server', t => {
  const f = fixture(t);
  const record = path.join(f.home, 'calls');
  const smoke = path.join(repo, 'tests/opencode-smoke.sh');
  assert.ok(fs.existsSync(smoke), 'OpenCode smoke checker must exist');
  fs.writeFileSync(path.join(f.bin, 'opencode'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\nprintf "%s\\n" "2.0.18"\n',
    { mode: 0o755 });
  const result = spawnSync('bash', [smoke], {
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`,
      TOOL: 'opencode', AGENTBOX_OPENCODE_VERSION: '2.0.19', RECORD: record,
      OPENCODE_CONFIG_DIR: `${f.home}/.config/opencode`,
      XDG_STATE_HOME: `${f.home}/.local/state` },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(record, 'utf8').trim(), '--version');
});

test('smoke rejects a non-OpenCode tool and a missing version selector before CLI calls', t => {
  const f = fixture(t);
  const record = path.join(f.home, 'calls');
  fs.writeFileSync(path.join(f.bin, 'opencode'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RECORD"\n', { mode: 0o755 });
  const smoke = path.join(repo, 'tests/opencode-smoke.sh');
  const wrongTool = spawnSync('bash', [smoke], {
    env: smokeEnvironment(f, record, { TOOL: 'claude' }), encoding: 'utf8',
  });
  assert.notEqual(wrongTool.status, 0);
  assert.equal(fs.existsSync(record), false);
  const missingSelectorEnv = smokeEnvironment(f, record);
  delete missingSelectorEnv.AGENTBOX_OPENCODE_VERSION;
  const missingSelector = spawnSync('bash', [smoke], {
    env: missingSelectorEnv, encoding: 'utf8',
  });
  assert.notEqual(missingSelector.status, 0);
  assert.equal(fs.existsSync(record), false);
});

test('smoke validates declared options without echoing their values or calling OpenCode', t => {
  const f = fixture(t);
  const record = path.join(f.home, 'calls');
  fs.writeFileSync(path.join(f.bin, 'opencode'), '#!/bin/sh\nprintf called >> "$RECORD"\n', { mode: 0o755 });
  const smoke = path.join(repo, 'tests/opencode-smoke.sh');
  for (const args of [['--unknown-option', 'OPTION_VALUE_FIXTURE'], ['--disabled-mcp']]) {
    const result = spawnSync('bash', [smoke, ...args], {
      env: smokeEnvironment(f, record), encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /OPTION_VALUE_FIXTURE/);
    assert.equal(fs.existsSync(record), false);
  }
});

test('smoke checks all read-only APIs and requested plugin, MCP, Meridian, and private-password contracts', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, { plugins: { data: [
    { id: 'fixture-plugin', source: { path: '/fixture/plugins/source-plugin' }, state: { status: 'active' } },
  ] }, requirePrivatePassword: true });
  const timeoutRecord = path.join(f.home, 'timeout-values');
  fs.writeFileSync(path.join(f.bin, 'timeout'),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$TIMEOUT_RECORD"\nshift\nexec "$@"\n',
    { mode: 0o755 });
  const meridianRequests = [];
  const meridian = http.createServer((request, response) => {
    meridianRequests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  await new Promise(resolve => meridian.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => meridian.close(resolve)));
  const address = meridian.address();
  const result = await runSmokeAsync(f, [
    '--require-plugin', 'fixture-plugin',
    '--require-plugin', '/fixture/plugins/source-plugin',
    '--require-mcp', 'connected-fixture',
    '--disabled-mcp', 'disabled-fixture',
    '--meridian-url', `http://127.0.0.1:${address.port}/v1/models`,
  ], smokeEnvironment(f, record, {
    OPENCODE_PASSWORD: 'OLD_PASSWORD_FIXTURE',
    OPENCODE_SERVER_PASSWORD: 'LEGACY_PASSWORD_FIXTURE',
    TIMEOUT_RECORD: timeoutRecord,
  }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  for (const endpoint of ['info', 'plugin', 'agent', 'skill', 'command', 'model', 'mcp']) {
    assert.match(result.stdout, new RegExp(`Verified API endpoint: ${endpoint}`));
  }
  assert.match(result.stdout, /Verified API endpoint: plugin \(1 entries\)/);
  assert.match(result.stdout, /Verified plugin: fixture-plugin \(active\)/);
  assert.match(result.stdout, /Verified MCP: connected-fixture \(connected\)/);
  assert.match(result.stdout, /Verified disabled MCP: disabled-fixture/);
  assert.deepEqual(meridianRequests, ['/v1/models']);
  assert.doesNotMatch(result.stdout + result.stderr,
    /CATALOG_CONTENT_FIXTURE|MCP_ERROR_FIXTURE|OLD_PASSWORD_FIXTURE|LEGACY_PASSWORD_FIXTURE/);
  const calls = smokeCalls(record);
  assert.equal(calls.filter(call => call.args[0] === 'serve').length, 1);
  const apiCalls = calls.filter(call => call.args[0] === 'http');
  assert.ok(fs.readFileSync(timeoutRecord, 'utf8').trim().split('\n')
    .every(value => Number.parseInt(value, 10) >= 60), 'API timeout should honor the 120-second deadline');
  const refreshCount = apiCalls.filter(call => call.args.at(-1) === '/api/plugin').length;
  assert.ok(refreshCount >= 2, 'catalogs should be refreshed after bounded startup readiness');
  assert.equal(apiCalls.filter(call => call.args.at(-1) === '/api/plugin').length, refreshCount,
    'plugin requests include the location warm-up');
  for (const endpoint of ['/api/agent', '/api/command', '/api/mcp', '/api/model', '/api/skill']) {
    assert.equal(apiCalls.filter(call => call.args.at(-1) === endpoint).length, refreshCount - 1,
      `${endpoint} must be refreshed together with the final snapshot`);
  }
  assert.equal(apiCalls.filter(call => call.args.at(-1) === '/api/info').length, 1);
  assert.ok(apiCalls.every(call => call.args[1] === 'GET'));
  const serveCall = calls.find(call => call.args[0] === 'serve');
  assert.equal(serveCall.passwordPresent, true);
  assert.equal(serveCall.legacyPasswordPresent, false);
  assert.ok(apiCalls.every(call => call.authenticated && !call.legacyPasswordPresent),
    'the fixture API server requires the private password on its requests');
  assert.deepEqual(fs.readdirSync(path.join(f.tmpdir, 'opencode')), [],
    'successful smoke cleanup removes its private workspace');
  assert.throws(() => process.kill(serveCall.pid, 0), { code: 'ESRCH' },
    'successful smoke cleanup stops its owned private server');
});

test('smoke waits for delayed configured catalogs and reports refreshed counts', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, {
    plugins: { data: [{ id: 'delayed-plugin', source: { path: '/fixture/delayed-plugin' },
      state: { status: 'active' } }] },
    agents: { data: [{ id: 'delayed-agent', name: 'Delayed agent' }] },
    skills: { data: [{ id: 'delayed-skill', name: 'Delayed skill' }] },
    commands: { data: [{ name: 'delayed-command' }] },
    delayedCatalogs: {
      '/api/plugin': 3500, '/api/agent': 3500, '/api/skill': 3500, '/api/command': 3500,
    },
  });
  const result = await runSmokeAsync(f, ['--require-plugin', 'delayed-plugin',
    '--require-agent', 'delayed-agent', '--require-skill', 'delayed-skill',
    '--require-command', 'delayed-command'],
    smokeEnvironment(f, record));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Verified API endpoint: plugin \(1 entries\)/);
  assert.match(result.stdout, /Verified API endpoint: agent \(1 entries\)/);
  assert.match(result.stdout, /Verified agent: delayed-agent \(present\)/);
  assert.match(result.stdout, /Verified skill: delayed-skill \(present\)/);
  assert.match(result.stdout, /Verified command: delayed-command \(present\)/);
  assert.match(result.stdout, /Verified catalog location: /);
  const calls = smokeCalls(record).filter(call => call.args[0] === 'http');
  assert.ok(calls.filter(call => call.args.at(-1) === '/api/plugin').length > 2,
    'plugin readiness must poll until its delayed activation');
  assert.ok(calls.filter(call => call.args.at(-1) === '/api/agent').length > 1,
    'agent catalog must be refreshed after delayed startup');
  assert.ok(calls.filter(call => call.args.at(-1) === '/api/skill').length > 1,
    'skill catalog must be refreshed after delayed startup');
  assert.ok(calls.filter(call => call.args.at(-1) === '/api/command').length > 1,
    'command catalog must be refreshed after delayed startup');
});

test('default smoke warms the location before waiting and makes no catalog readiness claims', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, {
    plugins: { data: [{ id: 'delayed-location-plugin', state: { status: 'active' } }] },
    agents: { data: [{ id: 'delayed-location-agent', name: 'Delayed location agent' }] },
    delayedLocationActivationMs: 1000,
  });
  const result = await runSmokeAsync(f, [], smokeEnvironment(f, record));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Catalog readiness and entry counts were not assessed/);
  assert.match(result.stdout, /plugin \(response shape and location valid; entries not assessed\)/);
  assert.doesNotMatch(result.stdout, /\(\d+ entries\)/);
  const calls = smokeCalls(record);
  const responses = calls.filter(call => call.args[0] === 'response');
  const firstPlugin = responses.find(call => call.args[1] === '/api/plugin');
  const infoRequest = responses.find(call => call.args[1] === '/api/info');
  assert.ok(firstPlugin && infoRequest && firstPlugin.at < infoRequest.at,
    'the location-scoped plugin warm-up must happen before the bounded startup wait');
  assert.equal(firstPlugin.returnedEntries, 0, 'fixture must begin with an empty location catalog');
  assert.ok(responses.some(call => call.args[1] === '/api/agent' && call.returnedEntries === 1 &&
    call.elapsedSinceLocationWarmup >= 1000),
  'the no-options check must exercise the delayed location after it activates');
});

test('smoke accepts a configured plugin directory containing its loaded entrypoint', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, { plugins: { data: [
    { id: 'directory-plugin', source: { path: '/fixture/plugins/source-plugin/index.js' },
      state: { status: 'active' } },
  ] } });
  const refreshCount = path.join(f.home, 'plugin-refresh-count');
  fs.writeFileSync(path.join(f.bin, 'timeout'), '#!/bin/sh\nshift\ncase "$*" in\n' +
    '  *"/api/plugin")\n    count=0; [ ! -f ' + JSON.stringify(refreshCount) +
    ' ] || count=$(cat ' + JSON.stringify(refreshCount) + ')\n' +
    '    count=$((count + 1)); printf \'%s\' "$count" > ' + JSON.stringify(refreshCount) +
    '\n    [ "$count" -le 3 ] || exit 124\n    ;;\nesac\nexec "$@"\n',
    { mode: 0o755 });
  const result = await runSmokeAsync(f, ['--require-plugin', '/fixture/plugins'],
    smokeEnvironment(f, record));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Verified plugin: \/fixture\/plugins \(active\)/);
});

test('smoke rejects a catalog returned for a different project location', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, { catalogLocation: '/fixture/wrong-location' });
  const result = await runSmokeAsync(f, [], smokeEnvironment(f, record));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API catalog location mismatch: \/api\/plugin/);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture\/wrong-location/);
});

test('smoke classifies API catalog errors without echoing their message', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, { apiErrorEndpoint: '/api/agent' });
  const result = await runSmokeAsync(f, [], smokeEnvironment(f, record));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr,
    /Invalid API catalog response: \/api\/agent \(location: missing, data: null, API error: Forbidden\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /SENSITIVE_API_ERROR_FIXTURE/);
});

test('smoke reports API failure without echoing service stderr or response data', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f, { failEndpoint: '/api/info' });
  const result = await runSmokeAsync(f, [], smokeEnvironment(f, record));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API request failed: \/api\/info \(exit status: 22\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_API_ERROR_FIXTURE/);
  const serveCall = smokeCalls(record).find(call => call.args[0] === 'serve');
  assert.ok(serveCall, 'the failing check must have started its owned server');
  assert.throws(() => process.kill(serveCall.pid, 0), { code: 'ESRCH' },
    'failure cleanup stops its owned private server');
  assert.deepEqual(fs.readdirSync(path.join(f.tmpdir, 'opencode')), [],
    'failure cleanup removes its private workspace');
});

test('smoke cleanup stops its owned server and removes its workspace after TERM', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f);
  const child = spawn('bash', [path.join(repo, 'tests/opencode-smoke.sh')], {
    cwd: f.projectDir, env: smokeEnvironment(f, record), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    let timer;
    const result = await Promise.race([
      closed,
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }),
    ]);
    clearTimeout(timer);
    if (!result) {
      try {
        const serveCall = smokeCalls(record).find(call => call.args[0] === 'serve');
        if (serveCall) process.kill(serveCall.pid, 'SIGTERM');
      } catch { /* The fixture may have exited before recording a server. */ }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group may already be gone. */ }
      await closed;
    }
  });

  const calls = await waitForSmokeCall(record, call =>
    call.args[0] === 'http' && call.args[1] === 'GET' && call.args[2] === '/api/plugin');
  assert.ok(calls, `the smoke check did not reach its private server\n${stdout}\n${stderr}`);
  const serveCall = calls.find(call => call.args[0] === 'serve');
  assert.ok(serveCall, 'the smoke check must have started its owned server');
  assert.equal(child.kill('SIGTERM'), true, 'the running smoke check must accept TERM');

  let timer;
  const result = await Promise.race([
    closed,
    new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }),
  ]);
  clearTimeout(timer);
  if (!result) {
    child.kill('SIGKILL');
    await closed;
  }
  assert.ok(result, `the smoke check did not exit after TERM\n${stdout}\n${stderr}`);
  assert.equal(result.status, 143, `${stdout}\n${stderr}`);
  assert.throws(() => process.kill(serveCall.pid, 0), { code: 'ESRCH' },
    'signal cleanup stops its owned private server');
  assert.deepEqual(fs.readdirSync(path.join(f.tmpdir, 'opencode')), [],
    'signal cleanup removes its private workspace');
});

test('smoke reports only requested plugin status when a readiness refresh times out', async t => {
  const f = fixture(t);
  const record = writeSmokeOpenCode(f);
  const countFile = path.join(f.home, 'plugin-refresh-count');
  fs.writeFileSync(path.join(f.bin, 'timeout'), `#!/bin/sh
shift
case "$*" in
  *"/api/plugin")
    count=0; [ ! -f '${countFile}' ] || count=$(cat '${countFile}')
    count=$((count + 1)); printf '%s' "$count" > '${countFile}'
    [ "$count" -le 2 ] || exit 124
    ;;
esac
exec "$@"
`, { mode: 0o755 });
  const result = await runSmokeAsync(f, ['--require-plugin', 'absent-plugin'],
    smokeEnvironment(f, record));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required plugin is not active: absent-plugin \(status: missing\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /CATALOG_CONTENT_FIXTURE|PRIVATE_API_ERROR_FIXTURE/);
});

test('OpenCode documentation records its sharing boundary, host networking, and rebuild contract', () => {
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const notes = fs.readFileSync(path.join(repo, 'DEVELOPMENT_NOTES.md'), 'utf8');
  for (const phrase of [
    'OpenCode V2: built-in; uses the host V2 version when installed.',
    'OpenCode shares host configuration, authentication, and session history.',
    'mounted selectively', 'Container cache persists separately', 'private container server',
    'host networking', '`-p` mappings are ignored',
    'The `--server` option conflicts with AgentBox-managed private-server execution.',
  ]) assert.ok(readme.includes(phrase), `README is missing: ${phrase}`);
  assert.ok(/OpenCode dependency helper.*selected OpenCode version changes/.test(readme),
    'README must include helper and version rebuilds');
  assert.match(readme, /Without\s+catalog requirements it reports endpoint reachability only; it does not claim\s+catalog initialization or print counts/);
  assert.match(notes, /Without catalog requirements the\s+checker is endpoint-only.*does\s+not claim catalogs initialized or print entry counts/s);
  for (const phrase of ['OpenCode V2', 'dependency helper', 'runtime/service state remains container-local', 'Herdr']) {
    assert.ok(notes.includes(phrase), `Development notes are missing: ${phrase}`);
  }
});
