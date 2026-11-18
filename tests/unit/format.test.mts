import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataFormatOf } from '../../src/format.mts';

test('a served data_format from 1 to 999 is the data format', () => {
  assert.equal(dataFormatOf(1), 1);
  assert.equal(dataFormatOf(2), 2);
  assert.equal(dataFormatOf(999), 999);
});

test('no data_format is format 1, so a config without one runs as before', () => {
  assert.equal(dataFormatOf(undefined), 1);
});

test('a data_format that is not a whole number from 1 to 999 is format 1', () => {
  for (const value of [0, -1, 1.5, '2', null, 1000, NaN, Infinity, -Infinity, true, [2], { 2: 2 }]) {
    assert.equal(dataFormatOf(value), 1, String(value));
  }
});
