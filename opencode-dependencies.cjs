const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parseArgs } = require('node:util');

let jsonc;
try {
  jsonc = require('jsonc-parser');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  jsonc = require('/home/agent/.local/lib/agentbox/node_modules/jsonc-parser');
}

function safePath(value) {
  return typeof value === 'string' ? value.replace(/[\x00\t\r\n:]/g, '?') : '<invalid path>';
}

function validatePath(value) {
  if (typeof value !== 'string' || /[\x00\t\r\n:]/.test(value)) {
    throw new Error(`Unsupported dependency path: ${safePath(value)}`);
  }
  return value;
}

function validateAbsolutePath(value) {
  validatePath(value);
  if (!path.isAbsolute(value)) throw new Error(`Unsupported dependency path: ${safePath(value)}`);
  return value;
}

function metadataFailure(value) {
  return new Error(`Filesystem metadata failed: ${safePath(value)}`);
}

function lstatPath(value) {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw metadataFailure(value);
  }
}

function readlinkPath(value) {
  try {
    return fs.readlinkSync(value);
  } catch {
    throw metadataFailure(value);
  }
}

function resolveLocal(value, base, home, packageEntry = false) {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('file:')) {
    try {
      value = fileURLToPath(value);
    } catch {
      throw new Error('Invalid file URL');
    }
  }
  else if (/^https?:\/\//.test(value)) return undefined;
  else if (packageEntry && !/^(\/|~\/|\.\.?\/)/.test(value)) return undefined;
  if (value.startsWith('~/')) value = path.join(home, value.slice(2));
  return validatePath(path.resolve(base, value));
}

/** Collect only explicit filesystem references from a parsed configuration object. */
function collectConfig(document, source, context) {
  validateAbsolutePath(source);
  validateAbsolutePath(context.home);
  validateAbsolutePath(context.projectDir);
  const output = [];
  const add = (value, base, role, mode = 'ro', packageEntry = false) => {
    let dependency;
    try {
      dependency = resolveLocal(value, base, context.home, packageEntry);
    } catch (error) {
      if (error.message === 'Invalid file URL') throw new Error(`Invalid configuration: ${safePath(source)}`);
      throw error;
    }
    if (dependency) output.push({ path: dependency, mode, role, required: true });
  };
  const base = path.dirname(source);
  if (document.plugins === null || document.plugin === null) throw new Error(`Invalid configuration: ${source}`);
  const entries = document.plugins ?? document.plugin ?? [];
  if (!Array.isArray(entries)) throw new Error(`Invalid configuration: ${source}`);
  for (const entry of entries) {
    if (entry == null) throw new Error(`Invalid configuration: ${source}`);
    const value = typeof entry === 'string' ? entry
      : Array.isArray(entry) ? entry[0]
        : entry && typeof entry === 'object' ? entry.package ?? entry.path : undefined;
    if (typeof entry !== 'string' && !Array.isArray(entry) && typeof entry !== 'object') {
      throw new Error(`Invalid configuration: ${source}`);
    }
    if (Array.isArray(entry) && typeof entry[0] !== 'string') throw new Error(`Invalid configuration: ${source}`);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (entry.package === undefined && entry.path === undefined ||
          entry.package !== undefined && typeof entry.package !== 'string' ||
          entry.path !== undefined && typeof entry.path !== 'string') throw new Error(`Invalid configuration: ${source}`);
    }
    if (typeof value === 'string' && value.startsWith('/usr/lib/meridian/')) {
      add('/usr/lib/meridian', base, 'plugin');
      add(path.join(context.home, '.config/meridian'), base, 'root', 'rw');
    } else {
      add(value, base, 'plugin', 'ro', true);
    }
  }
  const skills = Array.isArray(document.skills) ? document.skills : document.skills?.paths ?? [];
  if (!Array.isArray(skills) || document.skills !== undefined &&
      !Array.isArray(document.skills) && (!document.skills || typeof document.skills !== 'object' ||
        document.skills.paths !== undefined && !Array.isArray(document.skills.paths))) {
    throw new Error(`Invalid configuration: ${source}`);
  }
  for (const skill of skills) {
    if (typeof skill !== 'string') throw new Error(`Invalid configuration: ${source}`);
    add(skill, context.projectDir, 'skills');
  }
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

function collectLinkChain(linkPath, emit) {
  const visited = new Set();
  let current = validateAbsolutePath(path.resolve(linkPath));
  while (!visited.has(current)) {
    visited.add(current);
    const metadata = lstatPath(current);
    if (!metadata?.isSymbolicLink()) return;
    const target = validateAbsolutePath(path.resolve(path.dirname(current), readlinkPath(current)));
    emit({ path: target, mode: 'ro', role: 'symlink', required: true });
    current = target;
  }
}

function walkDirectory(root, emit, visitedDirectories) {
  let canonical;
  try {
    canonical = fs.realpathSync(root);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return;
    throw metadataFailure(root);
  }
  if (visitedDirectories.has(canonical)) return;
  visitedDirectories.add(canonical);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    throw metadataFailure(root);
  }
  for (const entry of entries) {
    const name = validateAbsolutePath(path.join(root, entry.name));
    if (entry.isSymbolicLink()) {
      collectLinkChain(name, emit);
    } else if (entry.isDirectory() && !['.git', 'node_modules', '.cache'].includes(entry.name)) {
      walkDirectory(name, emit, visitedDirectories);
    }
  }
}

function scanLinks(root, emit, visitedDirectories = new Set()) {
  validateAbsolutePath(root);
  const metadata = lstatPath(root);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) {
    collectLinkChain(root, emit);
    let targetMetadata;
    try {
      targetMetadata = fs.statSync(root);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return;
      throw metadataFailure(root);
    }
    if (targetMetadata.isDirectory()) walkDirectory(root, emit, visitedDirectories);
  } else if (metadata.isDirectory()) {
    walkDirectory(root, emit, visitedDirectories);
  }
}

function parseDocument(source) {
  validateAbsolutePath(source);
  let text;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch {
    throw new Error(`Invalid configuration: ${safePath(source)}`);
  }
  const errors = [];
  let result;
  try {
    result = jsonc.parse(text, errors, { allowTrailingComma: true });
  } catch {
    throw new Error(`Invalid configuration: ${safePath(source)}`);
  }
  if (errors.length || !result || Array.isArray(result) || typeof result !== 'object') {
    throw new Error(`Invalid configuration: ${safePath(source)}`);
  }
  return result;
}

/** Discover the absolute paths and access modes required by an OpenCode installation. */
function discover(context) {
  if (!context || typeof context !== 'object' || !Array.isArray(context.scanRoots ?? [])) {
    throw new Error('Invalid discovery arguments.');
  }
  for (const input of [context.home, context.configDir, context.projectDir, ...(context.scanRoots ?? [])]) {
    validateAbsolutePath(input);
  }
  const records = [];
  const roots = new Set(context.scanRoots ?? []);
  const documents = new Set();
  const add = record => records.push(record);
  roots.add(context.configDir);
  add({ path: context.configDir, mode: 'rw', role: 'root', required: true });
  for (const relative of ['.claude/skills', '.agents/skills']) {
    const root = path.join(context.home, relative);
    add({ path: root, mode: 'ro', role: 'skills', required: false });
    if (lstatPath(root)) roots.add(root);
  }
  for (const name of ['opencode.json', 'opencode.jsonc', 'cli.json']) documents.add(path.join(context.configDir, name));
  for (let directory = context.projectDir; ; directory = path.dirname(directory)) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      documents.add(path.join(directory, name));
      documents.add(path.join(directory, '.opencode', name));
    }
    const root = path.join(directory, '.opencode');
    if (lstatPath(root)) {
      roots.add(root);
      add({ path: root, mode: 'ro', role: 'root', required: true });
    }
    if (path.dirname(directory) === directory) break;
  }
  const meridian = path.join(context.home, '.config/meridian');
  if (roots.has(meridian)) documents.add(path.join(meridian, 'plugins.json'));
  for (const root of roots) scanLinks(root, add);
  for (const source of documents) {
    const metadata = lstatPath(source);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) collectLinkChain(source, add);
    let targetMetadata;
    try {
      targetMetadata = fs.statSync(source);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') continue;
      throw metadataFailure(source);
    }
    if (targetMetadata.isFile()) records.push(...collectConfig(parseDocument(source), source, context));
    else if (!targetMetadata.isSymbolicLink()) throw new Error(`Invalid configuration: ${safePath(source)}`);
  }
  const normalized = records.map(record => ({ ...record, path: resolveLocal(record.path, context.projectDir, context.home) }));
  const mountedRoots = normalized.filter(record => record.role === 'root').map(record => record.path);
  const unique = new Map();
  for (const record of normalized) {
    if (record.role === 'symlink' && mountedRoots.some(root => record.path === root || record.path.startsWith(`${root}${path.sep}`))) continue;
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

module.exports = { discover, collectConfig };

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      home: { type: 'string' }, config: { type: 'string' }, project: { type: 'string' },
      scan: { type: 'string', multiple: true, default: [] },
    } });
    if (![values.home, values.config, values.project, ...values.scan].every(value =>
      typeof value === 'string' && path.isAbsolute(value))) throw new Error('Invalid discovery arguments.');
    const records = discover({ home: values.home, configDir: values.config, projectDir: values.project, scanRoots: values.scan });
    for (const record of records) {
      process.stdout.write([record.mode, record.role, Number(record.required), record.path].join('\t') + '\n');
    }
  } catch (error) {
    const known = /^(Invalid configuration: |Unsupported dependency path: |Filesystem metadata failed: )/.test(error.message);
    process.stderr.write((known ? error.message : 'OpenCode dependency discovery failed.') + '\n');
    process.exitCode = 1;
  }
}
