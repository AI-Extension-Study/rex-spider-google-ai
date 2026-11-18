import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { BACKOFF_KEY, MODE_KEY, READS_KEY, keyKind, legacyKeyId, memoKey, uploadKeyId } from '../../src/keys.mts';
import { type ListEntry, parseListPage } from '../../src/list.mts';

// Synthetic ids in the captured forms: an mtid of 22 characters, an mstk of
// 30 and more, both [A-Za-z0-9_-].
const MTID = 'AbCdEfGhIjKlMnOpQrSt_1';
const MSTK = 'Mstk-0123456789_abcdefghijKLMNO';

const CREATED_S = 1_763_300_000; // 2025-11-16T13:33:20Z
const UPDATED_S = 1_763_303_600; // an hour later

// rex-spider's fetchUploadKey: the key it stores and looks up for the id and
// time a spider hands to checkIfAlreadyTransmitted and logTransmitted
// (rex-spider src/service-worker.mts:332-336, at 774e813, the commit the lock
// pins). It is private, and its module loads rex-core, which does not load
// under Node, so the test applies the same formula.
const transmitted = (id: string, updated: DateString) => `rex-spider-google-ai-conversation-upload-${id}-${Math.round(updated.timestamp())}`;

test('the three key ids: the bare mtid in summary mode, mtid-detail in detail mode, mstk_mtid as the old spider wrote it', () => {
  assert.equal(uploadKeyId(MTID, true, 1), MTID);
  assert.equal(uploadKeyId(MTID, false, 1), `${MTID}-detail`);
  assert.equal(legacyKeyId({ mstk: MSTK, mtid: MTID }), `${MSTK}_${MTID}`);
  assert.equal(uploadKeyId('t1', true, 1), 't1');
  assert.equal(uploadKeyId('t1', false, 1), 't1-detail');
  assert.equal(legacyKeyId({ mstk: 'k1', mtid: 't1' }), 'k1_t1');
});

// Format 1 keeps the ids above; a later format adds -f<n> to both, so every
// thread is unsent under it in both modes.
test('the key ids of a data format: format 1 keeps today\'s ids, a later one adds -f<n> in both modes', () => {
  assert.equal(uploadKeyId('c', true, 1), 'c');
  assert.equal(uploadKeyId('c', false, 1), 'c-detail');
  assert.equal(uploadKeyId('c', true, 2), 'c-f2');
  assert.equal(uploadKeyId('c', false, 2), 'c-detail-f2');
  assert.equal(uploadKeyId(MTID, true, 3), `${MTID}-f3`);
  assert.equal(uploadKeyId(MTID, false, 999), `${MTID}-detail-f999`);
});

test('the upload key rex-spider builds under format 2 differs from both of format 1\'s and from the old form', () => {
  const updated = new DateString(UPDATED_S);
  const two = [transmitted(uploadKeyId(MTID, true, 2), updated), transmitted(uploadKeyId(MTID, false, 2), updated)];
  assert.deepEqual(two, [`rex-spider-google-ai-conversation-upload-${MTID}-f2-1763303600000`, `rex-spider-google-ai-conversation-upload-${MTID}-detail-f2-1763303600000`]);
  const one = [uploadKeyId(MTID, true, 1), uploadKeyId(MTID, false, 1), legacyKeyId({ mstk: MSTK, mtid: MTID })].map((id) => transmitted(id, updated));
  assert.equal(new Set([...one, ...two]).size, 5);
});

// A format that is not a whole number from 1 to 999 is a wiring mistake: it
// throws rather than give format 1's key, which would read a thread sent
// under format 1 as sent under the format the pass runs.
test('a data format that is not a whole number from 1 to 999 is refused', () => {
  for (const format of [0, -1, 1.5, 1000, NaN, Infinity, undefined, null, '2', '1']) {
    for (const summary of [true, false]) {
      assert.throws(() => uploadKeyId(MTID, summary, format as unknown as number), TypeError, `${String(format)}, summary ${summary}`);
    }
  }
});

test('the upload key rex-spider builds differs between the two modes and the old form for one thread at one time', () => {
  const updated = new DateString(UPDATED_S);
  assert.equal(transmitted(uploadKeyId(MTID, true, 1), updated), `rex-spider-google-ai-conversation-upload-${MTID}-1763303600000`);
  assert.equal(transmitted(uploadKeyId(MTID, false, 1), updated), `rex-spider-google-ai-conversation-upload-${MTID}-detail-1763303600000`);
  assert.equal(transmitted(legacyKeyId({ mstk: MSTK, mtid: MTID }), updated), `rex-spider-google-ai-conversation-upload-${MSTK}_${MTID}-1763303600000`);
});

// The old spider's key must be rebuilt to the millisecond, or every thread it
// sent looks unsent and goes out again whatever its age. Each case below reads
// list JSON through parseListPage, as the pass will, and builds the key from
// legacyKeyId and the entry's updated. The old spider's key is built from the
// same JSON the way it built it (089c890, src/service-worker.mts): the id
// `${[0][0]}_${[0][1]}` (:96), the time new DateString([6][0]) (:109), or
// new DateString([5][0]) when [6] is null (:100), handed to
// checkIfAlreadyTransmitted and logTransmitted (:161, :295). [0][0] equals
// [22]'s mstk on every entry the capture read, and the list reads the mstk
// from [22].
function rawEntry(updated: [number, number] | null): unknown[] {
  const at: unknown[] = new Array(31).fill(null);
  at[0] = [MSTK, MTID];
  at[1] = 'A TITLE';
  at[5] = [CREATED_S, 741_739_000];
  at[6] = updated;
  at[22] = [['mtid', MTID], ['csuir', '1'], ['mstk', MSTK], ['udm', '50']];
  return at;
}

function readEntry(raw: unknown[]): ListEntry {
  const page = parseListPage(`)]}'\n\n${JSON.stringify([[raw], null, 1])}`);
  assert.ok(page !== null && page.entries.length === 1, 'Test setup invalid: the list did not read the entry');
  return page.entries[0];
}

test('a thread the old spider sent keeps the key it stored, to the millisecond, built from the list entry', () => {
  const entry = readEntry(rawEntry([UPDATED_S, 263_669_000]));
  const old = transmitted(`${MSTK}_${MTID}`, new DateString(UPDATED_S));
  assert.equal(old, `rex-spider-google-ai-conversation-upload-${MSTK}_${MTID}-${UPDATED_S * 1000}`);
  assert.equal(transmitted(legacyKeyId(entry), entry.updated), old);
});

test('a thread with no update time keeps the old key too: the time is the creation time, as the old spider read it', () => {
  const entry = readEntry(rawEntry(null));
  const old = transmitted(`${MSTK}_${MTID}`, new DateString(CREATED_S));
  assert.equal(old, `rex-spider-google-ai-conversation-upload-${MSTK}_${MTID}-${CREATED_S * 1000}`);
  assert.equal(transmitted(legacyKeyId(entry), entry.updated), old);
});

test('the mode record, the back-off, the read times and the memos sit under the spider\'s namespace', () => {
  assert.equal(MODE_KEY, 'rex-spider-google-ai-mode');
  assert.equal(BACKOFF_KEY, 'rex-spider-google-ai-backoff');
  assert.equal(READS_KEY, 'rex-spider-google-ai-read-times');
  assert.equal(memoKey(MTID, 1), `rex-spider-google-ai-detail-memo-${MTID}`);
});

// A failed read's memo is the data format's own, as the upload keys are, so
// a memo written under format 1 does not hold a thread back under format 2.
test('the memo key of a data format: format 1 keeps today\'s key, a later one adds -f<n>', () => {
  assert.equal(memoKey(MTID, 1), `rex-spider-google-ai-detail-memo-${MTID}`);
  assert.equal(memoKey(MTID, 2), `rex-spider-google-ai-detail-memo-${MTID}-f2`);
  assert.equal(memoKey(MTID, 999), `rex-spider-google-ai-detail-memo-${MTID}-f999`);
  for (const format of [0, -1, 1.5, 1000, NaN, undefined, null, '2']) {
    assert.throws(() => memoKey(MTID, format as unknown as number), TypeError, String(format));
  }
  assert.equal(keyKind(memoKey(MTID, 2)), 'rex-spider-google-ai-detail-memo');
});

test('every key id needs its ids', () => {
  assert.throws(() => memoKey('', 1), TypeError);
  assert.throws(() => uploadKeyId('', true, 1), TypeError);
  assert.throws(() => legacyKeyId({ mstk: '', mtid: MTID }), TypeError);
  assert.throws(() => legacyKeyId({ mstk: MSTK, mtid: '' }), TypeError);
});

test('an id that is not a string is refused at run time too', () => {
  assert.throws(() => memoKey(123 as unknown as string, 1), TypeError);
  assert.throws(() => uploadKeyId(null as unknown as string, false, 1), TypeError);
  assert.throws(() => legacyKeyId({ mstk: undefined as unknown as string, mtid: MTID }), TypeError);
  assert.throws(() => legacyKeyId({ mstk: MSTK, mtid: 7 as unknown as string }), TypeError);
});

test('what may be logged of a key is its kind, never a thread id', () => {
  assert.equal(keyKind(MODE_KEY), 'rex-spider-google-ai-mode');
  assert.equal(keyKind(BACKOFF_KEY), 'rex-spider-google-ai-backoff');
  assert.equal(keyKind(READS_KEY), 'rex-spider-google-ai-read-times');
  assert.equal(keyKind(memoKey(MTID, 1)), 'rex-spider-google-ai-detail-memo');
  assert.equal(keyKind(`rex-spider-google-ai-conversation-upload-${MTID}-1763303600000`), 'other key');
  assert.equal(keyKind(`rex-spider-google-ai-conversation-upload-${MSTK}_${MTID}-1763303600000`), 'other key');
  assert.equal(keyKind(`rex-spider-google-ai-conversation-upload-${MTID}-detail-f2-1763303600000`), 'other key');
});
