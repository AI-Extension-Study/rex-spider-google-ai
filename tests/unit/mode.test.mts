import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import type { ListEntry } from '../../src/list.mts';
import { CLOCK_SKEW_MS, RESEND_WINDOW_MS, type Transmitted, dueState, resendSince } from '../../src/mode.mts';
import { type HandleMessage, type ModeRecord, type Read, type Write, createStore } from '../../src/store.mts';

const DAY = 24 * 60 * 60 * 1000;
const SWITCH = Date.UTC(2026, 10, 20);

function modeStore(stored: Read<ModeRecord>, write: Write = { ok: true, unanswered: false }) {
  const writes: ModeRecord[] = [];
  return {
    writes,
    store: {
      mode: {
        get: async () => stored,
        set: async (record: ModeRecord) => {
          writes.push(record);
          return write;
        },
      },
    },
  };
}

const read = (value: ModeRecord | null, flags: Partial<Read<ModeRecord>> = {}): Read<ModeRecord> => ({ value, unanswered: false, malformed: false, ...flags });

test('the re-send window is 90 days', () => {
  assert.equal(RESEND_WINDOW_MS, 7_776_000_000);
});

test('with no record, as on the first pass after an update, the served mode starts now', async () => {
  const fake = modeStore(read(null));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
});

test('a record of the served mode keeps its start and is not written again', async () => {
  const fake = modeStore(read({ mode: 'detail', since: SWITCH - 5 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH - 5 * DAY);
  assert.deepEqual(fake.writes, []);
});

test('a record of the other mode, or a malformed one, is replaced by the served mode from now', async () => {
  for (const stored of [read({ mode: 'summary', since: SWITCH - 50 * DAY }), read(null, { malformed: true })]) {
    const fake = modeStore(stored);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
    assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  }
});

test('a start more than a day ahead of now, written under a clock that ran fast, is replaced by now', async () => {
  assert.equal(CLOCK_SKEW_MS, 86_400_000);
  const fake = modeStore(read({ mode: 'detail', since: SWITCH + 365 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  const close = modeStore(read({ mode: 'detail', since: SWITCH + DAY }));
  assert.equal(await resendSince(close.store, 'detail', SWITCH), SWITCH + DAY);
  assert.deepEqual(close.writes, []);
  const past = modeStore(read({ mode: 'detail', since: SWITCH + DAY + 1 }));
  assert.equal(await resendSince(past.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(past.writes, [{ mode: 'detail', since: SWITCH }]);
});

test('a record that could not be read, or a new one that could not be written, gives no start this pass', async () => {
  const unread = modeStore(read(null, { unanswered: true }));
  assert.equal(await resendSince(unread.store, 'detail', SWITCH), null);
  assert.deepEqual(unread.writes, []);
  for (const failed of [{ ok: false, unanswered: true }, { ok: false, unanswered: false }]) {
    const fake = modeStore(read({ mode: 'summary', since: 1 }), failed);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), null, JSON.stringify(failed));
  }
});

// Synthetic ids in the captured forms (list.test.mts).
const MTID = 'AbCdEfGhIjKlMnOpQrSt_1';
const MSTK = 'Mstk-0123456789_abcdefghijKLMNO';
const SUMMARY = MTID;
const DETAIL = `${MTID}-detail`;
const LEGACY = `${MSTK}_${MTID}`;

// The upload keys a browser holds, as rex-spider's checkIfAlreadyTransmitted
// sees them: an id and the time to the millisecond.
function keys(...held: [string, number][]): Transmitted {
  const set = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  return async (id: string, ended: DateString) => set.has(`${id} ${Math.round(ended.timestamp())}`);
}

// A list entry updated at ms, as list.mts builds one: whole seconds give the
// DateString of the seconds, as the list makes it; any other ms an instant
// read from its ISO string, exact to the millisecond, for the boundary. It was
// created a day earlier, so a key looked up at the creation time misses.
function entry(ms: number, ids: { mtid?: string; mstk?: string } = {}): ListEntry {
  const updated = ms % 1000 === 0 ? new DateString(ms / 1000) : new DateString(new Date(ms).toISOString());
  assert.equal(updated.timestamp(), ms, 'Test setup invalid: the instant is not exact to the millisecond');
  const created = new DateString(Math.floor(ms / 1000) - 24 * 60 * 60);
  return { mtid: ids.mtid ?? MTID, mstk: ids.mstk ?? MSTK, title: null, created, updated, numbers: {} };
}

test('a thread sent in the served mode at this time is sent, in either mode, whatever else it holds', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await dueState(keys([DETAIL, ended]), entry(ended), 'detail', SWITCH), 'sent');
  assert.equal(await dueState(keys([SUMMARY, ended]), entry(ended), 'summary', SWITCH), 'sent');
  // Every re-sent thread holds both modes' keys, and an old one its legacy key too.
  const all = keys([SUMMARY, ended], [DETAIL, ended], [LEGACY, ended]);
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await dueState(all, entry(ended), served, SWITCH), 'sent', served);
    assert.equal(await dueState(all, entry(ended), served, null), 'sent', `${served}, no start`);
  }
});

test('a thread with no key in either mode and no legacy key is due, however long before the switch it was last used', async () => {
  for (const daysBefore of [0, 3, 120, 400]) {
    const ended = SWITCH - daysBefore * DAY;
    for (const served of ['detail', 'summary'] as const) {
      assert.equal(await dueState(keys(), entry(ended), served, SWITCH), 'due', `${served}, ${daysBefore} days before`);
    }
  }
});

test('keys at another time, or another thread\'s keys, do not count: the thread got a turn since, or was never sent', async () => {
  const ended = SWITCH - 10 * DAY;
  const earlier = ended - 1000;
  assert.equal(await dueState(keys([DETAIL, earlier], [SUMMARY, earlier], [LEGACY, earlier]), entry(ended), 'detail', SWITCH), 'due');
  // A new turn changes the mstk, so the entry's legacy id is no longer the one stored.
  assert.equal(await dueState(keys([`Mstk-OLD3456789_abcdefghijKLMNO_${MTID}`, ended]), entry(ended), 'detail', SWITCH), 'due');
  assert.equal(await dueState(keys([`${MSTK}_AbCdEfGhIjKlMnOpQrSt_2`, ended], ['AbCdEfGhIjKlMnOpQrSt_2', ended]), entry(ended), 'detail', SWITCH), 'due');
});

// What the old key or the other mode's key holds, as one case each: the
// served mode, and the keys the browser holds for the thread at its time.
const OTHER_MODE_CASES: [string, 'detail' | 'summary', string][] = [
  ['only the legacy key, served detail', 'detail', LEGACY],
  ['only the legacy key, served summary (the summary key changed too)', 'summary', LEGACY],
  ['only the summary key, served detail', 'detail', SUMMARY],
  ['only the detail key, served summary', 'summary', DETAIL],
];

test('only the legacy key or the other mode\'s key, last used within 90 days before the switch: due again', async () => {
  for (const [name, served, id] of OTHER_MODE_CASES) {
    for (const daysBefore of [0, 2, 81, 90]) {
      const ended = SWITCH - daysBefore * DAY;
      assert.equal(await dueState(keys([id, ended]), entry(ended), served, SWITCH), 'due', `${name}, ${daysBefore} days before`);
    }
  }
});

test('only the legacy key or the other mode\'s key, last used more than 90 days before the switch: sent, it keeps its record', async () => {
  for (const [name, served, id] of OTHER_MODE_CASES) {
    for (const ended of [SWITCH - 90 * DAY - 1000, SWITCH - 142 * DAY]) {
      assert.equal(await dueState(keys([id, ended]), entry(ended), served, SWITCH), 'sent', name);
    }
  }
});

test('the 90 days end at the millisecond: updated 1 ms inside the boundary or at it, due; 1 ms before it, sent', async () => {
  // A start with a millisecond part, as Date.now() gives, so a rule that cut
  // times to whole seconds would show here too.
  const since = SWITCH + 456;
  const boundary = since - 90 * DAY;
  assert.equal(boundary, since - RESEND_WINDOW_MS);
  const cases: [number, 'due' | 'sent'][] = [[boundary + 1, 'due'], [boundary, 'due'], [boundary - 1, 'sent']];
  for (const [name, served, id] of OTHER_MODE_CASES) {
    for (const [ms, need] of cases) {
      assert.equal(await dueState(keys([id, ms]), entry(ms), served, since), need, `${name}, ${ms - boundary} ms from the boundary`);
    }
  }
});

test('with no start this pass, a thread with the legacy key or the other mode\'s key is held back, not sent; a new one is still due', async () => {
  const ended = SWITCH - 3 * DAY;
  const old = SWITCH - 100 * DAY;
  for (const [name, served, id] of OTHER_MODE_CASES) {
    assert.equal(await dueState(keys([id, ended]), entry(ended), served, null), 'held', name);
    assert.equal(await dueState(keys([id, old]), entry(old), served, null), 'held', `${name}, 100 days before`);
    assert.equal(await dueState(keys(), entry(ended), served, null), 'due', `${served}, no key`);
  }
});

test('a mode record rex-core does not answer for holds legacy and other-mode threads back this pass, and new threads still go', async () => {
  // Only the mode record's read goes unanswered here: rex-core does not
  // handle it, as while its database is not open. The upload-key lookups are
  // a stand-in that answers, so the test can show what a null start does to a
  // thread sent before and to a new one.
  const asked: string[] = [];
  const handleMessage = ((message: { messageType: string; key: string }) => {
    asked.push(`${message.messageType} ${message.key}`);
    return false;
  }) as unknown as HandleMessage;
  const store = createStore(handleMessage, { deadlineMs: 20, log: () => {} });
  const since = await resendSince(store, 'detail', SWITCH);
  assert.equal(since, null);
  // The null comes from the read itself: no write was tried.
  assert.deepEqual(asked, ['fetchValue rex-spider-google-ai-mode']);
  const ended = SWITCH - 3 * DAY;
  const NEW = 'AbCdEfGhIjKlMnOpQrSt_9';
  const held = keys([LEGACY, ended], [SUMMARY, ended - 1000]);
  assert.equal(await dueState(held, entry(ended), 'detail', since), 'held');
  assert.equal(await dueState(keys([SUMMARY, ended]), entry(ended), 'detail', since), 'held');
  assert.equal(await dueState(held, entry(ended, { mtid: NEW }), 'detail', since), 'due');
});

test('the update itself: a browser with only the old spider\'s keys, served either mode, re-sends exactly the last 90 days', async () => {
  for (const served of ['detail', 'summary'] as const) {
    const fake = modeStore(read(null));
    const since = await resendSince(fake.store, served, SWITCH);
    assert.equal(since, SWITCH);
    // Three threads the old spider sent, and one it never saw.
    const threads: [string, string, number][] = [
      ['AbCdEfGhIjKlMnOpQrSt_a', 'Mstk-a', SWITCH - 2 * DAY],
      ['AbCdEfGhIjKlMnOpQrSt_b', 'Mstk-b', SWITCH - 80 * DAY],
      ['AbCdEfGhIjKlMnOpQrSt_c', 'Mstk-c', SWITCH - 142 * DAY],
    ];
    const held = keys(...threads.map(([mtid, mstk, ended]): [string, number] => [`${mstk}_${mtid}`, ended]));
    const due: string[] = [];
    for (const [mtid, mstk, ended] of [...threads, ['AbCdEfGhIjKlMnOpQrSt_d', 'Mstk-d', SWITCH - 200 * DAY] as [string, string, number]]) {
      if ((await dueState(held, entry(ended, { mtid, mstk }), served, since)) === 'due') due.push(mtid);
    }
    assert.deepEqual(due, ['AbCdEfGhIjKlMnOpQrSt_a', 'AbCdEfGhIjKlMnOpQrSt_b', 'AbCdEfGhIjKlMnOpQrSt_d'], served);
  }
});

test('a key lookup that fails fails dueState, so the caller never reads it as never sent', async () => {
  const failing: Transmitted = async () => {
    throw new Error('lookup deadline');
  };
  await assert.rejects(dueState(failing, entry(SWITCH - DAY), 'detail', SWITCH), /lookup deadline/);
  // A lookup that fails only for the legacy key fails too.
  const legacyFails: Transmitted = async (id) => {
    if (id === LEGACY) throw new Error('legacy lookup deadline');
    return false;
  };
  await assert.rejects(dueState(legacyFails, entry(SWITCH - DAY), 'detail', SWITCH), /legacy lookup deadline/);
});
