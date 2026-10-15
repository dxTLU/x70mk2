'use strict';

const fs = require('fs');
const path = require('path');

class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Real path of `p`, or of its nearest existing ancestor joined with the missing tail. */
function realish(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Map a (root name, relative path) pair from a project to an absolute path inside one of the
 * configured fsRoots. Rejects absolute paths, `..` escapes and symlinks pointing outside the root.
 */
function resolveIn(roots, rootName, rel) {
  const root = roots[rootName];
  if (!root) throw new BridgeError('EROOT', `Unknown root ${JSON.stringify(rootName)}; configured: ${Object.keys(roots).join(', ')}`);
  rel = String(rel ?? '').replace(/\\/g, '/');
  if (rel.includes('\0')) throw new BridgeError('EPATH', 'Path contains a NUL byte');
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new BridgeError('EPATH', 'Paths are relative to the root');
  fs.mkdirSync(root, { recursive: true });
  const target = path.resolve(root, rel);
  if (!inside(target, root)) throw new BridgeError('EPATH', 'Path escapes its root');
  const realRoot = fs.realpathSync.native(root);
  if (!inside(realish(target), realRoot)) throw new BridgeError('EPATH', 'Path escapes its root via a link');
  return target;
}

module.exports = { BridgeError, resolveIn, inside };
