import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// node --test passes on a glob that matches no file, so a renamed test folder
// would leave CI green. test:unit runs tests/require-unit-tests.mjs on the
// same glob first, and it fails when no file matches.
const GUARD = 'tests/require-unit-tests.mjs';
const UNIT_GLOB = "'tests/unit/**/*.test.mts'";

const guard = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', GUARD, ...args], { encoding: 'utf8' });

test('the guard fails on a glob that matches no file, and passes on the unit tests\' glob', () => {
  const none = guard('tests/no-such-folder/**/*.test.mts');
  assert.equal(none.status, 1, none.stderr);
  assert.match(none.stderr, /no unit test file/);
  const some = guard('tests/unit/**/*.test.mts');
  assert.equal(some.status, 0, some.stderr);
});

test('the guard fails when it is given no glob', () => {
  assert.equal(guard().status, 2);
});

test('test:unit runs the guard on the glob it hands node --test, before the tests', () => {
  const script = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts['test:unit'];
  const [first, second, ...rest] = script.split(' && ');
  assert.deepEqual(rest, [], script);
  assert.ok(first.includes(GUARD) && first.endsWith(UNIT_GLOB), script);
  assert.ok(second.includes('--test') && second.endsWith(UNIT_GLOB), script);
});
