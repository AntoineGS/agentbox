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
    return mount;
  }
  function resolve(value, seen = new Set(), followFinal = true) {
    if (seen.has(value)) throw Object.assign(new Error('cycle'), { code: 'ELOOP' });
    seen.add(value);
    const mount = mapped(value);
    const parts = value.slice(mount.destination.length).split('/').filter(Boolean);
    let source = mount.source;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) source = path.join(source, parts[index]);
      if (original.lstatSync(source).isSymbolicLink() && (followFinal || index < parts.length - 1)) {
        const destination = path.join(mount.destination, ...parts.slice(0, index + 1));
        const target = path.resolve(path.dirname(destination), original.readlinkSync(source));
        return resolve(path.join(target, ...parts.slice(index + 1)), seen, followFinal);
      }
    }
    return source;
  }
  fs.lstatSync = value => original.lstatSync(resolve(value, new Set(), false));
  fs.readlinkSync = value => original.readlinkSync(resolve(value, new Set(), false));
  fs.statSync = value => original.statSync(resolve(value));
  fs.realpathSync = value => resolve(value);
  fs.readdirSync = (value, options) => original.readdirSync(resolve(value), options);
  fs.readFileSync = (value, options) => original.readFileSync(resolve(value), options);
};
