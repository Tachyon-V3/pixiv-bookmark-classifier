'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
for (const args of [
  ['--check', 'pixiv-bookmark-analyzer-prototype.user.js'],
  ...['prototype', 'classification', 'append', 'flow', 'append-flow', 'i18n'].map(name => [`tests/test-${name}.cjs`]),
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All offline checks passed. No live Pixiv requests were made.');
