'use strict';
/**
 * Development helper (not part of the runtime): reports exported names that are
 * never referenced anywhere else, which is usually a sign of dead code.
 *
 *   npm run audit
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const exportRe = /module\.exports = \{([\s\S]*?)\n\};/g;

let issues = 0;
for (const [file, src] of sources) {
  let match;
  exportRe.lastIndex = 0;
  while ((match = exportRe.exec(src))) {
    const names = match[1]
      .split(',')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'))
      .map((line) => line.split(':')[0].trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    for (const name of names) {
      let uses = 0;
      for (const [otherFile, otherSrc] of sources) {
        if (otherFile === file) continue;
        if (new RegExp(`\\b${name}\\b`).test(otherSrc)) uses += 1;
      }
      // Enum-like constant objects are referenced through their container.
      if (uses === 0 && !/^[A-Z_]+$/.test(name)) {
        console.log(`${path.relative(root, file)} -> exported but never imported elsewhere: ${name}`);
        issues += 1;
      }
    }
  }
}
console.log(issues === 0 ? 'no orphan exports found' : `${issues} orphan export(s)`);
