'use strict';
/**
 * Development helper (not part of the runtime): reports imported bindings that
 * are never used in a file.
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

let issues = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const requireRe = /^const \{([\s\S]*?)\} = require\(/gm;
  let match;
  while ((match = requireRe.exec(src))) {
    const names = match[1]
      .split(',')
      .map((part) => part.trim().split(':').pop().trim())
      .filter(Boolean);
    for (const name of names) {
      const uses = src.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (uses <= 1) {
        console.log(`${path.relative(root, file)} -> unused import: ${name}`);
        issues += 1;
      }
    }
  }
  // Also flag top-level single requires assigned but never used.
  const singleRe = /^const (\w+) = require\(/gm;
  while ((match = singleRe.exec(src))) {
    const name = match[1];
    const uses = src.split(new RegExp(`\\b${name}\\b`)).length - 1;
    if (uses <= 1) {
      console.log(`${path.relative(root, file)} -> unused import: ${name}`);
      issues += 1;
    }
  }
}
console.log(issues === 0 ? 'no unused imports found' : `${issues} unused import(s)`);
