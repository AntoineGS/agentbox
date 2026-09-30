const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover, collectConfig } = require('../opencode-dependencies.cjs');

function tree(t) {
  const fixtureRoot = process.env.AGENTBOX_TEST_TMPDIR || '/tmp/opencode';
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(fixtureRoot, 'agentbox-discovery-'));
  const configDir = path.join(home, '.config/opencode');
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectDir);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, configDir, projectDir, scanRoots: [configDir] };
}

const source = ctx => path.join(ctx.configDir, 'opencode.json');

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
  const result = collectConfig({ plugins: ['./local-plugin'], skills: ['./local-skills'] }, source(ctx), ctx);
  assert.ok(result.some(r => r.path === path.join(ctx.configDir, 'local-plugin')));
  assert.ok(result.some(r => r.path === path.join(ctx.projectDir, 'local-skills')));
});

test('disabled debugger shell strings are never evaluated or mounted as paths', t => {
  const ctx = tree(t);
  const sentinel = path.join(ctx.home, 'must-not-exist');
  const result = collectConfig({ mcp: { dbg: { enabled: false, type: 'local',
    command: ['bash', '-c', `touch ${sentinel}; exec /private/debugger`] } } }, source(ctx), ctx);
  assert.equal(fs.existsSync(sentinel), false);
  assert.ok(!result.some(r => r.path === '/private/debugger'));
});

test('native, legacy, tuple, and CLI plugin declarations preserve local paths', t => {
  const ctx = tree(t);
  for (const document of [
    { plugins: [{ package: "./plugin with 'quote'" }] },
    { plugin: [["./plugin with 'quote'", { enabled: true }]] },
    { plugins: ["./plugin with 'quote'"] },
    { plugins: [{ path: "./plugin with 'quote'" }] },
  ]) {
    const result = collectConfig(document, path.join(ctx.configDir, 'cli.json'), ctx);
    assert.ok(result.some(r => r.path === path.join(ctx.configDir, "plugin with 'quote'")));
  }
});

test('package plugin declarations ignore npm, Git, and HTTP packages but accept file URLs', t => {
  const ctx = tree(t);
  const file = path.join(ctx.configDir, 'plugin with spaces');
  for (const packageName of ['npm:package-name', 'package-name', 'git+https://example.test/p.git', 'https://example.test/p']) {
    assert.equal(collectConfig({ plugins: [packageName] }, source(ctx), ctx).length, 0);
  }
  assert.ok(collectConfig({ plugins: [new URL(`file://${file}`).href] }, source(ctx), ctx)
    .some(record => record.path === file));
});

test('invalid file URLs fail without echoing configuration values', t => {
  const ctx = tree(t);
  assert.throws(() => collectConfig({ plugins: ['file://SENSITIVE_VALUE.invalid/path'] }, source(ctx), ctx), error =>
    error.message.includes(source(ctx)) && !error.message.includes('SENSITIVE_VALUE'));
});

test('legacy skills.paths and global compatible skill roots are discovered', t => {
  const ctx = tree(t);
  const legacy = collectConfig({ skills: { paths: ['./skills'] } }, source(ctx), ctx);
  assert.ok(legacy.some(record => record.path === path.join(ctx.projectDir, 'skills') && record.role === 'skills'));
  for (const relative of ['.claude/skills', '.agents/skills']) fs.mkdirSync(path.join(ctx.home, relative), { recursive: true });
  assert.ok(discover(ctx).some(record => record.path === path.join(ctx.home, '.claude/skills') && !record.required));
  assert.ok(discover(ctx).some(record => record.path === path.join(ctx.home, '.agents/skills') && !record.required));
});

test('ancestor project config and Meridian path declarations are collected as data', t => {
  const ctx = tree(t);
  const ancestor = path.join(ctx.home, 'opencode.json');
  const projectPlugin = path.join(ctx.home, 'ancestor-plugin');
  const meridian = path.join(ctx.home, '.config/meridian');
  fs.mkdirSync(meridian, { recursive: true });
  fs.writeFileSync(ancestor, JSON.stringify({ plugin: ['./ancestor-plugin'] }));
  fs.writeFileSync(path.join(meridian, 'plugins.json'), JSON.stringify({ plugins: [{ path: './meridian-plugin' }] }));
  const result = discover({ ...ctx, scanRoots: [ctx.configDir, meridian] });
  assert.ok(result.some(record => record.path === projectPlugin && record.role === 'plugin'));
  assert.ok(result.some(record => record.path === path.join(meridian, 'meridian-plugin') && record.role === 'plugin'));
});

test('project and ancestor config symlinks contribute their external target chains', t => {
  const ctx = tree(t);
  const external = path.join(ctx.home, 'external-configs');
  fs.mkdirSync(external);
  const settings = path.join(external, 'settings.json');
  const settingsLink = path.join(external, 'settings-link.json');
  fs.writeFileSync(settings, JSON.stringify({ plugins: ['./resolved-from-config'] }));
  fs.symlinkSync(settings, settingsLink);
  fs.symlinkSync(settingsLink, path.join(ctx.projectDir, 'opencode.json'));

  const ancestorSettings = path.join(external, 'ancestor.json');
  fs.writeFileSync(ancestorSettings, '{}');
  fs.symlinkSync(ancestorSettings, path.join(ctx.home, 'opencode.json'));

  const result = discover(ctx);
  assert.ok(result.some(record => record.path === settingsLink && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === settings && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === ancestorSettings && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === path.join(ctx.projectDir, 'resolved-from-config')));
});

test('config symlink cycles and dangling targets terminate as path-only records', t => {
  const ctx = tree(t);
  const a = path.join(ctx.projectDir, 'opencode.json');
  const b = path.join(ctx.home, 'config-b.json');
  fs.symlinkSync(b, a);
  fs.symlinkSync(a, b);
  const dangling = path.join(ctx.projectDir, 'opencode.jsonc');
  const absent = path.join(ctx.home, 'not-created.json');
  fs.symlinkSync(absent, dangling);
  const result = discover(ctx);
  assert.ok(result.some(record => record.path === b && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === a && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === absent && record.role === 'symlink'));
});

test('file scan roots are terminal and file-link chains are inspected without reading contents', t => {
  const ctx = tree(t);
  const external = path.join(ctx.home, 'file-roots');
  fs.mkdirSync(external);
  const terminal = path.join(external, 'credential');
  const middle = path.join(external, 'credential-link');
  const start = path.join(ctx.projectDir, 'credential-link');
  fs.writeFileSync(terminal, 'DO_NOT_READ_TOKEN');
  fs.symlinkSync(terminal, middle);
  fs.symlinkSync(middle, start);
  const result = discover({ ...ctx, scanRoots: [ctx.configDir, terminal, start] });
  assert.ok(result.some(record => record.path === middle && record.role === 'symlink'));
  assert.ok(result.some(record => record.path === terminal && record.role === 'symlink'));
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_READ_TOKEN/);
});

test('input and source delimiter paths fail safely before config reads', t => {
  const ctx = tree(t);
  const unsafeConfig = `${ctx.configDir}\nINJECTED`;
  assert.throws(() => discover({ ...ctx, configDir: unsafeConfig }), error =>
    error.message.startsWith('Unsupported dependency path: ') && !error.message.includes('\n'));
  assert.throws(() => collectConfig({}, `${source(ctx)}\tINJECTED`, ctx), error =>
    error.message.startsWith('Unsupported dependency path: ') && !error.message.includes('\t'));
});

test('malformed JSONC and metadata failures report fixed categories with sanitized paths', t => {
  const ctx = tree(t);
  const unsafeConfig = `${ctx.configDir}\nBAD`;
  fs.mkdirSync(unsafeConfig);
  fs.writeFileSync(path.join(unsafeConfig, 'opencode.json'), '{"secret":"PRIVATE", broken}');
  assert.throws(() => discover({ ...ctx, configDir: unsafeConfig }), error =>
    error.message.startsWith('Unsupported dependency path: ') && !error.message.includes('\n') && !error.message.includes('PRIVATE'));

  const parentFile = path.join(ctx.home, 'not-a-directory');
  fs.writeFileSync(parentFile, 'metadata fixture');
  const invalidRoot = path.join(parentFile, 'child');
  assert.throws(() => discover({ ...ctx, scanRoots: [ctx.configDir, invalidRoot] }), error =>
    error.message.startsWith('Filesystem metadata failed: ') && error.message.includes(invalidRoot));
  const cli = path.resolve(__dirname, '../opencode-dependencies.cjs');
  const result = spawnSync(process.execPath, [cli, '--home', ctx.home, '--config', ctx.configDir,
    '--project', ctx.projectDir, '--scan', invalidRoot], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith(`Filesystem metadata failed: ${invalidRoot}\n`));
});

test('a package directory that is itself a symlink is emitted without traversal', t => {
  const ctx = tree(t);
  const external = path.join(ctx.home, 'package-target');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(ctx.configDir, 'node_modules'));
  const result = discover(ctx);
  assert.ok(result.some(record => record.path === external && record.role === 'symlink'));
});

test('optional skill roots are emitted when absent', t => {
  const ctx = tree(t);
  const result = discover(ctx);
  assert.ok(result.some(record => record.path === path.join(ctx.home, '.claude/skills') && record.required === false));
});

test('invalid JSONC reports only its source path, not embedded values', t => {
  const ctx = tree(t);
  const file = path.join(ctx.configDir, 'opencode.jsonc');
  fs.writeFileSync(file, '{"apiKey":"SENSITIVE_VALUE", broken}');
  assert.throws(() => discover(ctx), error => error.message.includes(file) && !error.message.includes('SENSITIVE_VALUE'));
});

test('duplicate paths are normalized and deduplicated without widening credential mounts', t => {
  const ctx = tree(t);
  const credential = path.join(ctx.home, 'secret');
  fs.writeFileSync(source(ctx), JSON.stringify({ plugins: ['./plugin', path.join(ctx.configDir, 'plugin')],
    mcp: { one: `{file:${credential}}`, collision: `{file:${ctx.configDir}}` } }));
  const result = discover(ctx);
  const plugins = result.filter(record => record.path === path.join(ctx.configDir, 'plugin'));
  assert.equal(plugins.length, 1);
  assert.deepEqual(result.find(record => record.path === credential), { path: credential, mode: 'ro', role: 'file', required: true });
  assert.deepEqual(result.find(record => record.path === ctx.configDir), { path: ctx.configDir, mode: 'ro', role: 'file', required: true });
});

test('rejects tab, newline, NUL, and colon dependency paths', t => {
  const ctx = tree(t);
  for (const value of ['./bad\npath', './bad\tpath', './bad\0path', './bad:path']) {
    assert.throws(() => collectConfig({ plugins: [value] }, source(ctx), ctx), /Unsupported dependency path/);
  }
});

test('malformed plugin and skill types identify source without values', t => {
  const ctx = tree(t);
  for (const document of [
    { plugins: 'SECRET_PLUGIN' }, { plugins: null }, { plugins: [null] }, { plugins: [{}] },
    { skills: { paths: 'SECRET_SKILL' } },
  ]) {
    assert.throws(() => collectConfig(document, source(ctx), ctx), error =>
      error.message.includes(source(ctx)) && !/SECRET_(PLUGIN|SKILL)/.test(error.message));
  }
});

test('nested external symlinks are discovered without following a directory cycle', t => {
  const ctx = tree(t);
  const nested = path.join(ctx.configDir, 'plugins/nested');
  const externalParent = path.join(ctx.home, 'external-repositories');
  const external = path.join(externalParent, 'selected-plugin');
  const sibling = path.join(externalParent, 'unrelated-repository');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(sibling);
  fs.symlinkSync(external, path.join(ctx.home, 'external-link-two'));
  fs.symlinkSync(path.join(ctx.home, 'external-link-two'), path.join(nested, 'dependency'));
  fs.symlinkSync(ctx.configDir, path.join(nested, 'cycle'));
  const result = discover(ctx);
  assert.ok(result.some(r => r.path === path.join(ctx.home, 'external-link-two') && r.role === 'symlink'));
  assert.ok(result.some(r => r.path === external && r.role === 'symlink'));
  assert.ok(!result.some(r => r.path === sibling));
  assert.ok(!result.some(r => r.path === ctx.home));
  assert.ok(!result.some(r => r.path === ctx.configDir && r.role === 'symlink'));
});

test('nested plugin files and package symlinks are discovered without reading package contents', t => {
  const ctx = tree(t);
  const packageRoot = path.join(ctx.home, 'plugin-repository', 'selected-package');
  const sibling = path.join(ctx.home, 'plugin-repository', 'unrelated-package');
  const plugin = path.join(packageRoot, 'dist/plugin.js');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"fixture-only"}');
  fs.writeFileSync(plugin, 'do not execute');
  const linkedDependencies = path.join(ctx.home, 'external-node-modules');
  fs.mkdirSync(linkedDependencies);
  fs.symlinkSync(linkedDependencies, path.join(packageRoot, 'node_modules'));
  fs.writeFileSync(source(ctx), JSON.stringify({ plugins: [plugin] }));
  const result = discover({ ...ctx, scanRoots: [ctx.configDir, packageRoot] });
  assert.ok(result.some(record => record.path === plugin && record.role === 'plugin'));
  assert.ok(result.some(record => record.path === linkedDependencies && record.role === 'symlink'));
  assert.ok(!result.some(record => record.path === sibling));
  assert.doesNotMatch(JSON.stringify(result), /do not execute|fixture-only/);
});

test('CLI emits four path-only TSV fields and rejects malformed config safely', t => {
  const ctx = tree(t);
  const cli = path.resolve(__dirname, '../opencode-dependencies.cjs');
  const args = ['--home', ctx.home, '--config', ctx.configDir, '--project', ctx.projectDir, '--scan', ctx.configDir];
  fs.writeFileSync(path.join(ctx.configDir, 'opencode.json'), JSON.stringify({ mcp: { api: { headers: { Authorization: 'Bearer SECRET' } } } }));
  const success = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.ok(success.stdout.trim().split('\n').every(line => line.split('\t').length === 4));
  assert.doesNotMatch(success.stdout, /SECRET|Bearer/);
  fs.writeFileSync(path.join(ctx.configDir, 'opencode.json'), '{broken SECRET}');
  const failure = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.notEqual(failure.status, 0);
  assert.equal(failure.stdout, '');
  assert.doesNotMatch(failure.stderr, /SECRET/);
});
