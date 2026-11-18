// Run by the test:unit script before node --test, on the same glob. node
// --test passes on a glob that matches no file, so a renamed or moved test
// folder would leave CI green with no unit test run. This fails instead.
// Exit 1: no file matches. Exit 2: no glob given.
import { globSync } from 'node:fs';
import process from 'node:process';

const [pattern] = process.argv.slice(2);
if (pattern === undefined) {
  console.error('usage: node tests/require-unit-tests.mjs <glob>');
  process.exit(2);
}
if (globSync(pattern).length === 0) {
  console.error(`no unit test file matches ${pattern}`);
  process.exit(1);
}
