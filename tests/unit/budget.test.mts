import assert from 'node:assert/strict';
import { test } from 'node:test';

import { READ_BUDGET, readsInWindow, withRead } from '../../src/budget.mts';
import { CLOCK_SKEW_MS } from '../../src/mode.mts';

const NOW = Date.UTC(2026, 10, 20, 12);
const MINUTE = 60_000;
const WINDOW = READ_BUDGET.windowMs;

test('the read budget is 15 thread reads in any 60 minutes', () => {
  assert.deepEqual(READ_BUDGET, { reads: 15, windowMs: 3_600_000 });
});

test('a read counts while it is less than the window old, and not once it is the window old', () => {
  assert.equal(readsInWindow([], NOW, READ_BUDGET), 0);
  assert.equal(readsInWindow([NOW - WINDOW], NOW, READ_BUDGET), 0);
  assert.equal(readsInWindow([NOW - WINDOW + 1], NOW, READ_BUDGET), 1);
  assert.equal(readsInWindow([NOW, NOW - MINUTE, NOW - 2 * WINDOW, NOW - WINDOW - 1], NOW, READ_BUDGET), 2);
  assert.equal(readsInWindow(Array.from({ length: 15 }, (_, k) => NOW - k * MINUTE), NOW, READ_BUDGET), 15);
});

// A clock that went back leaves times ahead of it. Up to a day ahead they
// still count, so no read is made uncounted; further ahead, as the mode
// record's start (mode.mts), a clock that ran fast wrote them, and they are
// dropped rather than block the reads until the clock catches up.
test('a read time ahead of the clock counts up to a day ahead, and is dropped past that', () => {
  assert.equal(CLOCK_SKEW_MS, 24 * 60 * MINUTE);
  assert.equal(readsInWindow([NOW + MINUTE], NOW, READ_BUDGET), 1);
  assert.equal(readsInWindow([NOW + CLOCK_SKEW_MS], NOW, READ_BUDGET), 1);
  assert.equal(readsInWindow([NOW + CLOCK_SKEW_MS + 1], NOW, READ_BUDGET), 0);
});

test('a read time is added to the stored ones, which keep the newest 15, oldest first, and none more than a day ahead', () => {
  // NOW - 1 minute back to NOW - 20 minutes, newest first, as given.
  const older = Array.from({ length: 20 }, (_, k) => NOW - (k + 1) * MINUTE);
  const given = [NOW + CLOCK_SKEW_MS + 1, ...older];
  const next = withRead(given, NOW, READ_BUDGET);
  assert.deepEqual(next, [...older.slice(0, 14).reverse(), NOW]);
  assert.equal(given.length, 21, 'the stored times were changed in place');
  assert.deepEqual(withRead([], NOW, READ_BUDGET), [NOW]);
  assert.deepEqual(withRead([NOW + CLOCK_SKEW_MS, NOW - 2 * WINDOW], NOW, READ_BUDGET), [NOW - 2 * WINDOW, NOW, NOW + CLOCK_SKEW_MS]);
});

test('a budget of another count keeps that many', () => {
  const budget = { reads: 3, windowMs: WINDOW };
  assert.deepEqual(withRead([NOW - 4, NOW - 3, NOW - 2, NOW - 1], NOW, budget), [NOW - 2, NOW - 1, NOW]);
});
