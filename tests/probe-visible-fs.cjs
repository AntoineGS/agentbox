const fs = require('node:fs');
const path = require('node:path');

// Model bind destinations, not the unrestricted fixture host filesystem.
module.exports = function restrictToMounts(mounts) {
  const original = Object.fromEntries(['lstatSync', 'statSync', 'realpathSync', 'readlinkSync',
    'readdirSync', 'readFileSync'].map(name => [name, fs[name].bind(fs)]));
  mounts.sort((a, b) => b.destination.length - a.destination.length);
  function mapped(value) {
    const mount = mounts.find(m => value === m.destination || value.startsWith(m.destination + '/'));
    if (!mount) throw Object.assign(new Error('not mounted'), { code: 'ENOENT' });
    return mount.source + value.slice(mount.destination.length);
  }
  function resolve(value, seen = new Set()) {
    if (seen.has(value)) throw Object.assign(new Error('cycle'), { code: 'ELOOP' });
    seen.add(value);
    const source = mapped(value);
    if (original.lstatSync(source).isSymbolicLink()) {
      return resolve(path.resolve(path.dirname(value), original.readlinkSync(source)), seen);
    }
    return source;
  }
  fs.lstatSync = value => original.lstatSync(mapped(value));
  fs.readlinkSync = value => original.readlinkSync(mapped(value));
  fs.statSync = value => original.statSync(resolve(value));
  fs.realpathSync = value => resolve(value);
  fs.readdirSync = (value, options) => original.readdirSync(resolve(value), options);
  fs.readFileSync = (value, options) => original.readFileSync(resolve(value), options);
};
