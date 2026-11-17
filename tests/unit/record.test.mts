import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { LIST_NUMBER_KEYS, type ListEntry } from '../../src/list.mts';
import { type AimRecord, type AimTurn, type DetailOptions, FORMAT_VERSION, MAX_TURNS, type ParsedThread, TURNS_JSON_LIMIT, buildDetailRecord, buildSummaryRecord, hashTitle } from '../../src/record.mts';
import { ANSWER_MARKER, CREATED_S, MARKERS, MSTK, MTID, TITLE, TITLE_HASH, UPDATED_S, URL_MARKER, assistantTurn, listEntry, numberedTurns, thread, userTurn } from './fixtures.mts';

type Json = Record<string, unknown>;

// A deterministic SHA-256 in lowercase hex, as rex-core's sha256 answers.
const sha256 = async (text: string): Promise<string> => createHash('sha256').update(text, 'utf8').digest('hex');

const CREATED_ISO = '2025-11-16T13:33:20Z';
const UPDATED_ISO = '2025-11-16T14:33:20Z';

const RECORD_KEYS = ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'metadata'];
const DETAIL_RECORD_KEYS = ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'turns_complete', 'metadata'];
const TURN_KEYS = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments'];

const LIST_NUMBERS = { 3: 0, 11: 0, 13: 4, 17: 1, 18: 0, 23: 1, 25: 0, 26: 0, 27: 2, 30: 0 };

// The record as it is uploaded: its JSON, each DateString as its instant.
const uploaded = (record: unknown): Json => JSON.parse(JSON.stringify(record)) as Json;

// No marker planted in the list entry is in the record's JSON. Every record
// a test builds goes through it.
function clean(record: AimRecord): AimRecord {
  const text = JSON.stringify(record);
  for (const marker of MARKERS) {
    assert.equal(text.includes(marker), false, `the record holds ${marker}`);
  }
  return record;
}

async function summaryOf(entry: ListEntry): Promise<AimRecord> {
  return clean(buildSummaryRecord(entry, await hashTitle(entry.title, sha256)));
}

async function detailOf(entry: ListEntry, parsed: ParsedThread, options?: DetailOptions): Promise<AimRecord> {
  return clean(buildDetailRecord(entry, await hashTitle(entry.title, sha256), parsed, options));
}

// A two-question thread: each question and its answer.
const SMALL = [userTurn(12, 3), assistantTurn(840, 131, 6), userTurn(25, 5), assistantTurn(1203, 188, 0)];

test('the format version is 1 and the caps are 1,000 turns and 512 KB of JSON', () => {
  assert.equal(FORMAT_VERSION, 1);
  assert.equal(MAX_TURNS, 1000);
  assert.equal(TURNS_JSON_LIMIT, 512 * 1024);
});

test('hashTitle gives the title\'s SHA-256 in lowercase hex', async () => {
  assert.equal(await hashTitle(TITLE, sha256), TITLE_HASH);
  assert.equal(await hashTitle(listEntry().title, sha256), TITLE_HASH);
});

test('hashTitle is null for no title or an empty one, and does not call the hash', async () => {
  let calls = 0;
  const counting = async (text: string) => {
    calls += 1;
    return sha256(text);
  };
  assert.equal(await hashTitle(null, counting), null);
  assert.equal(await hashTitle('', counting), null);
  assert.equal(calls, 0);
});

test('hashTitle is null when the hash rejects, throws, or answers with anything but 64 lowercase hex digits', async () => {
  const answers: ((text: string) => Promise<string>)[] = [
    async () => {
      throw new Error('no digest');
    },
    () => {
      throw new Error('thrown before a promise');
    },
    async (text) => text,
    async () => TITLE_HASH.toUpperCase(),
    async () => TITLE_HASH.slice(1),
    async () => `${TITLE_HASH}0`,
    async () => ` ${TITLE_HASH}`,
    async () => '',
    async () => 42 as unknown as string,
    async () => null as unknown as string,
  ];
  for (const [index, hash] of answers.entries()) {
    assert.equal(await hashTitle(TITLE, hash), null, `answer ${index}`);
  }
});

test('the summary record of a list entry: every key and value', async () => {
  const record = await summaryOf(listEntry());
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'google-ai-mode',
    identifier: MTID,
    format_version: 1,
    is_summary: true,
    date: UPDATED_S * 1000,
    started: CREATED_ISO,
    ended: UPDATED_ISO,
    turns: [],
    metadata: { title_hash: TITLE_HASH, created_at: CREATED_ISO, updated_at: UPDATED_ISO, list_numbers: LIST_NUMBERS },
  });
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  assert.equal('turns_complete' in record, false);
  assert.deepEqual(Object.keys(record.metadata), ['title_hash', 'created_at', 'updated_at', 'list_numbers']);
  assert.deepEqual(Object.keys(record.metadata.list_numbers), [...LIST_NUMBER_KEYS]);
  assert.equal(typeof record.date, 'number');
  assert.ok(record.started instanceof DateString && record.ended instanceof DateString);
});

test('a summary\'s date is its ended in epoch ms, and started and ended are the list\'s created and updated', async () => {
  const entry = listEntry();
  const record = await summaryOf(entry);
  assert.equal(record.date, entry.updated.timestamp());
  assert.equal(record.started, entry.created);
  assert.equal(record.ended, entry.updated);
});

test('a summary of an entry with no update time ends at its creation time', async () => {
  const record = await summaryOf(listEntry({ 6: null }));
  const sent = uploaded(record);
  assert.equal(sent.date, CREATED_S * 1000);
  assert.equal(sent.ended, CREATED_ISO);
  assert.deepEqual(sent.metadata, { title_hash: TITLE_HASH, created_at: CREATED_ISO, updated_at: CREATED_ISO, list_numbers: LIST_NUMBERS });
});

test('a summary of an entry with no title, or an empty one, has a null title hash', async () => {
  for (const title of [null, '', 7, ['SECRET-TITLE']]) {
    const record = await summaryOf(listEntry({ 1: title }));
    assert.equal(record.metadata.title_hash, null, JSON.stringify(title));
  }
});

test('a title hash handed in that is not a SHA-256 in lowercase hex goes out as null, so the title itself never does', () => {
  const entry = listEntry();
  for (const handed of [TITLE, entry.title, TITLE_HASH.toUpperCase(), TITLE_HASH.slice(2), '']) {
    assert.equal(clean(buildSummaryRecord(entry, handed)).metadata.title_hash, null, handed ?? 'null');
    assert.equal(clean(buildDetailRecord(entry, handed, thread(SMALL))).metadata.title_hash, null, handed ?? 'null');
  }
  assert.equal(clean(buildSummaryRecord(entry, TITLE_HASH)).metadata.title_hash, TITLE_HASH);
});

test('list_numbers keeps an integer from 0 to 999 and nulls anything else, text included', async () => {
  const entry = listEntry({ 3: 999, 11: 1000, 13: 'NUMBER-MARKER', 17: 1.5, 18: -1, 23: ['NUMBER-MARKER'], 25: { 0: 1 }, 26: true, 27: null });
  const record = await summaryOf(entry);
  assert.deepEqual(record.metadata.list_numbers, { 3: 999, 11: null, 13: null, 17: null, 18: null, 23: null, 25: null, 26: null, 27: null, 30: 0 });
  assert.equal(JSON.stringify(record).includes('NUMBER-MARKER'), false);
});

test('list_numbers has exactly the ten keys whatever the entry\'s numbers hold', async () => {
  const entry: ListEntry = { ...listEntry(), numbers: { 3: 5, 99: 1, extra: 2 } as Record<string, number | null> };
  const record = await summaryOf(entry);
  assert.deepEqual(record.metadata.list_numbers, { 3: 5, 11: null, 13: null, 17: null, 18: null, 23: null, 25: null, 26: null, 27: null, 30: null });
});

// The list already nulls these, so only an entry that skips the list shows
// the record's own check.
test('the record checks list numbers itself: out of range, fractional or text at one of the ten keys goes out as null', async () => {
  const numbers = { ...listEntry().numbers, 3: 1000, 11: -1, 13: 1.5, 17: 'NUMBER-MARKER', 18: 0, 23: 999 } as unknown as Record<string, number | null>;
  const entry: ListEntry = { ...listEntry(), numbers };
  for (const record of [await summaryOf(entry), await detailOf(entry, thread(SMALL))]) {
    assert.deepEqual(record.metadata.list_numbers, { 3: null, 11: null, 13: null, 17: null, 18: 0, 23: 999, 25: 0, 26: 0, 27: 2, 30: 0 });
    assert.equal(JSON.stringify(record).includes('NUMBER-MARKER'), false);
  }
});

test('the detail record of a list entry and its thread: every key and value', async () => {
  const record = await detailOf(listEntry(), thread(SMALL));
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'google-ai-mode',
    identifier: MTID,
    format_version: 1,
    is_summary: false,
    date: CREATED_S * 1000,
    started: CREATED_ISO,
    ended: UPDATED_ISO,
    turns: [
      { identifier: null, parent: null, speaker: 'user', when: null, on_current_branch: true, text_chars: 12, text_words: 3, citation_count: 0, search_result_count: null, attachments: null },
      { identifier: null, parent: null, speaker: 'assistant', when: null, on_current_branch: true, text_chars: 840, text_words: 131, citation_count: 6, search_result_count: null, attachments: null },
      { identifier: null, parent: null, speaker: 'user', when: null, on_current_branch: true, text_chars: 25, text_words: 5, citation_count: 0, search_result_count: null, attachments: null },
      { identifier: null, parent: null, speaker: 'assistant', when: null, on_current_branch: true, text_chars: 1203, text_words: 188, citation_count: 0, search_result_count: null, attachments: null },
    ],
    turns_complete: true,
    metadata: { title_hash: TITLE_HASH, created_at: CREATED_ISO, updated_at: UPDATED_ISO, list_numbers: LIST_NUMBERS, turn_blocks: 2 },
  });
  assert.deepEqual(Object.keys(record), DETAIL_RECORD_KEYS);
  assert.deepEqual(Object.keys(record.metadata), ['title_hash', 'created_at', 'updated_at', 'list_numbers', 'turn_blocks']);
  for (const turn of record.turns) {
    assert.deepEqual(Object.keys(turn), TURN_KEYS);
  }
  assert.ok(record.started instanceof DateString && record.ended instanceof DateString);
});

test('a detail record\'s date is its started in epoch ms, not its ended', async () => {
  const entry = listEntry();
  const record = await detailOf(entry, thread(SMALL));
  assert.equal(record.date, entry.created.timestamp());
  assert.notEqual(record.date, entry.updated.timestamp());
});

// On threads begun from an AI Overview follow-up ([27] is 2, as in the
// fixture), the list's [6] can be seconds to minutes before its [5]. A record
// starts at the earlier of the two so it never ends before it starts, and
// created_at and updated_at keep the entry's own two times.
const EARLY_S = CREATED_S - 42;
const EARLY_ISO = '2025-11-16T13:32:38Z';
const updatedEarly = (seconds = EARLY_S): ListEntry => listEntry({ 6: [seconds, 263_669_000] });

test('a summary of an entry updated before it was created starts and ends at [6], and its metadata keeps [5] and [6]', async () => {
  const record = await summaryOf(updatedEarly());
  assert.deepEqual(uploaded(record), {
    name: 'rex-conversation',
    platform: 'google-ai-mode',
    identifier: MTID,
    format_version: 1,
    is_summary: true,
    date: EARLY_S * 1000,
    started: EARLY_ISO,
    ended: EARLY_ISO,
    turns: [],
    metadata: { title_hash: TITLE_HASH, created_at: CREATED_ISO, updated_at: EARLY_ISO, list_numbers: LIST_NUMBERS },
  });
  // The redactor rebuilds each time from its seconds.
  assert.deepEqual([record.started.originalValue, record.ended.originalValue], [`number:${EARLY_S}`, `number:${EARLY_S}`]);
});

test('a detail of an entry updated before it was created starts and ends at [6] and is dated by [6], and its metadata keeps [5] and [6]', async () => {
  const record = await detailOf(updatedEarly(), thread(SMALL));
  const sent = uploaded(record);
  assert.deepEqual([sent.date, sent.started, sent.ended], [EARLY_S * 1000, EARLY_ISO, EARLY_ISO]);
  assert.deepEqual(sent.metadata, { title_hash: TITLE_HASH, created_at: CREATED_ISO, updated_at: EARLY_ISO, list_numbers: LIST_NUMBERS, turn_blocks: 2 });
  assert.deepEqual(Object.keys(record), DETAIL_RECORD_KEYS);
  assert.deepEqual([record.started.originalValue, record.ended.originalValue], [`number:${EARLY_S}`, `number:${EARLY_S}`]);
});

test('[6] before [5] by a second or by minutes: started is [6] whatever the gap, and ended stays [6]', async () => {
  for (const gap of [1, 59, 600, 86_400]) {
    const entry = updatedEarly(CREATED_S - gap);
    for (const record of [await summaryOf(entry), await detailOf(entry, thread(SMALL))]) {
      const what = `${gap} s, is_summary ${String(record.is_summary)}`;
      assert.equal(record.started.timestamp(), (CREATED_S - gap) * 1000, what);
      assert.equal(record.ended.timestamp(), (CREATED_S - gap) * 1000, what);
      assert.equal(record.date, (CREATED_S - gap) * 1000, what);
      assert.equal(record.metadata.created_at, new DateString(CREATED_S).toJSON(), what);
    }
  }
});

// Less than a millisecond apart, epoch ms cannot tell the two apart; the
// record still starts at the earlier.
test('[6] before [5] by less than a millisecond: started is still [6]', async () => {
  const entry = listEntry({ 5: [CREATED_S + 0.0008, 0], 6: [CREATED_S + 0.0002, 0] });
  assert.equal(entry.created.timestamp(), entry.updated.timestamp(), 'Test setup invalid: the two times differ in epoch ms');
  for (const record of [await summaryOf(entry), await detailOf(entry, thread(SMALL))]) {
    assert.equal(record.started.originalValue, `number:${CREATED_S + 0.0002}`, String(record.is_summary));
    assert.equal(uploaded(record).started, uploaded(record).ended, String(record.is_summary));
  }
});

test('an entry with no [6] starts and ends at [5], summary and detail', async () => {
  const entry = listEntry({ 6: null });
  for (const record of [await summaryOf(entry), await detailOf(entry, thread(SMALL))]) {
    const sent = uploaded(record);
    assert.deepEqual([sent.date, sent.started, sent.ended], [CREATED_S * 1000, CREATED_ISO, CREATED_ISO], String(record.is_summary));
    assert.deepEqual([record.started.originalValue, record.ended.originalValue], [`number:${CREATED_S}`, `number:${CREATED_S}`]);
    assert.deepEqual([record.metadata.created_at, record.metadata.updated_at], [CREATED_ISO, CREATED_ISO]);
  }
});

// The 0.4 ms case shares [5]'s epoch ms, so a comparison in ms cannot order
// the two, and its ISO text (20.0004...Z) sorts before [5]'s (20Z), so a
// comparison of the text orders them the wrong way.
test('[6] after [5], by 0.4 ms, a second or the fixture\'s hour, or equal to it: started is [5] and ended [6], as before', async () => {
  const cases: Array<[string, ListEntry, number]> = [
    ['an hour after', listEntry(), UPDATED_S],
    ['a second after', listEntry({ 6: [CREATED_S + 1, 0] }), CREATED_S + 1],
    ['0.4 ms after', listEntry({ 6: [CREATED_S + 0.0004, 0] }), CREATED_S + 0.0004],
    ['equal', listEntry({ 6: [CREATED_S, 0] }), CREATED_S],
  ];
  const close = cases[2][1];
  assert.equal(close.created.timestamp(), close.updated.timestamp(), 'Test setup invalid: the 0.4 ms case differs in epoch ms');
  assert.ok(close.updated.toJSON() < close.created.toJSON(), 'Test setup invalid: the 0.4 ms case\'s text does not sort before [5]\'s');
  for (const [what, entry, ended] of cases) {
    const summary = await summaryOf(entry);
    const detail = await detailOf(entry, thread(SMALL));
    for (const record of [summary, detail]) {
      assert.equal(record.started.originalValue, `number:${CREATED_S}`, what);
      assert.equal(record.ended.originalValue, `number:${ended}`, what);
      assert.deepEqual([record.metadata.created_at, record.metadata.updated_at], [new DateString(CREATED_S).toJSON(), new DateString(ended).toJSON()], what);
    }
    assert.equal(summary.date, new DateString(ended).timestamp(), what);
    assert.equal(detail.date, CREATED_S * 1000, what);
  }
});

test('turn_blocks is the thread\'s block count, which need not be half the turns', async () => {
  const record = await detailOf(listEntry(), thread(SMALL.slice(0, 3), false, 3));
  assert.equal(record.metadata.turn_blocks, 3);
  assert.equal(record.turns.length, 3);
});

test('turns_complete is the thread\'s complete when nothing is cut', async () => {
  assert.equal((await detailOf(listEntry(), thread(SMALL, true))).turns_complete, true);
  assert.equal((await detailOf(listEntry(), thread(SMALL, false))).turns_complete, false);
  const none = await detailOf(listEntry(), thread([], false, 0));
  assert.deepEqual([none.turns, none.turns_complete, none.metadata.turn_blocks], [[], false, 0]);
});

test('turns_complete is true only when the thread\'s complete is true itself, not missing or merely truthy', async () => {
  for (const complete of [undefined, null, 1, 'true']) {
    const record = await detailOf(listEntry(), { turns: SMALL, blocks: 2, complete: complete as unknown as boolean });
    assert.equal(record.turns_complete, false, String(complete));
  }
});

test('1,000 turns are all kept and leave the turns complete', async () => {
  const record = await detailOf(listEntry(), thread(numberedTurns(1000)));
  assert.equal(record.turns.length, 1000);
  assert.equal(record.turns_complete, true);
});

test('1,001 turns keep the newest 1,000, in order, and leave the turns incomplete', async () => {
  const record = await detailOf(listEntry(), thread(numberedTurns(1001)));
  assert.equal(record.turns.length, 1000);
  assert.deepEqual(record.turns.map((turn) => turn.text_chars), Array.from({ length: 1000 }, (_, index) => index + 1));
  assert.equal(record.turns[0].speaker, 'assistant');
  assert.equal(record.turns_complete, false);
  assert.equal(record.metadata.turn_blocks, 501);
});

test('1,000 turns of the largest counts stay under 512 KB of JSON, so at the defaults only the turn cap cuts', async () => {
  const big = Number.MAX_SAFE_INTEGER;
  const turns = Array.from({ length: 1000 }, () => assistantTurn(big, big, big));
  const record = await detailOf(listEntry(), thread(turns));
  assert.equal(record.turns.length, 1000);
  assert.ok(JSON.stringify(record.turns).length < TURNS_JSON_LIMIT);
  assert.equal(record.turns_complete, true);
});

// Each of these turns is 232 characters of JSON, 233 with its comma, so 512
// KB holds 2 + 233 * 2,250 - 1 = 524,251 characters of them and not 2,251.
test('the default JSON cap is 512 KB: with the turn cap raised, 3,000 turns of the largest counts keep the newest 2,250', async () => {
  const big = Number.MAX_SAFE_INTEGER;
  const base = big - 3000;
  const turns = Array.from({ length: 3000 }, (_, index) => assistantTurn(base + index, big, big));
  assert.ok(turns.every((turn) => JSON.stringify(turn).length === 232), 'Test setup invalid: a turn is not 232 characters');
  const record = await detailOf(listEntry(), thread(turns), { maxTurns: 5000 });
  assert.equal(record.turns.length, 2250);
  assert.deepEqual(record.turns.map((turn) => turn.text_chars), Array.from({ length: 2250 }, (_, index) => base + 750 + index));
  assert.equal(JSON.stringify(record.turns).length, 524_251);
  assert.ok(524_251 + 233 > TURNS_JSON_LIMIT);
  assert.equal(record.turns_complete, false);
});

test('the JSON cap keeps the newest turns whose JSON fits and leaves the turns incomplete', async () => {
  const turns = numberedTurns(10);
  const fits = JSON.stringify(turns.slice(-4)).length;
  const cut = await detailOf(listEntry(), thread(turns), { turnsJsonLimit: fits });
  assert.deepEqual(cut.turns.map((turn) => turn.text_chars), [6, 7, 8, 9]);
  assert.ok(JSON.stringify(cut.turns).length <= fits);
  assert.equal(cut.turns_complete, false);

  const short = await detailOf(listEntry(), thread(turns), { turnsJsonLimit: fits - 1 });
  assert.deepEqual(short.turns.map((turn) => turn.text_chars), [7, 8, 9]);
  assert.equal(short.turns_complete, false);

  const whole = await detailOf(listEntry(), thread(turns), { turnsJsonLimit: JSON.stringify(turns).length });
  assert.equal(whole.turns.length, 10);
  assert.equal(whole.turns_complete, true);
});

// A turn that does not fit ends the cut, so the record never skips it and
// keeps an older one, which would leave a gap in the turns.
test('the JSON cap stops at the first turn that does not fit, and keeps no older turn past it', async () => {
  const turns = [userTurn(1, 1), assistantTurn(123_456_789, 1, 0), userTurn(2, 1)];
  const limit = JSON.stringify([userTurn(1, 1), userTurn(2, 1)]).length;
  const record = await detailOf(listEntry(), thread(turns), { turnsJsonLimit: limit });
  assert.deepEqual(record.turns.map((turn) => turn.text_chars), [2]);
  assert.equal(record.turns_complete, false);
});

test('a newest turn alone over the JSON cap leaves no turns', async () => {
  const record = await detailOf(listEntry(), thread(SMALL), { turnsJsonLimit: 10 });
  assert.deepEqual([record.turns, record.turns_complete], [[], false]);
});

test('a smaller turn cap keeps that many of the newest', async () => {
  const record = await detailOf(listEntry(), thread(numberedTurns(6)), { maxTurns: 2 });
  assert.deepEqual(record.turns.map((turn) => turn.text_chars), [4, 5]);
  assert.equal(record.turns_complete, false);
});

test('each turn goes out with exactly the standard keys, its fixed keys at their only value, whatever the parser handed in', async () => {
  const planted = {
    content: 'SECRET-TITLE answer text', identifier: `${MSTK}-turn`, parent: 'URL-MARKER-2', when: '2025-11-16T13:33:20Z', on_current_branch: false,
    search_result_count: 4, attachments: 2, speaker: 'assistant', text_chars: 5, text_words: 1, citation_count: 1, title: 'ANSWER-MARKER-14',
  } as unknown as AimTurn;
  const record = await detailOf(listEntry(), thread([userTurn(3, 1), planted]));
  assert.deepEqual(uploaded(record).turns, [
    { identifier: null, parent: null, speaker: 'user', when: null, on_current_branch: true, text_chars: 3, text_words: 1, citation_count: 0, search_result_count: null, attachments: null },
    { identifier: null, parent: null, speaker: 'assistant', when: null, on_current_branch: true, text_chars: 5, text_words: 1, citation_count: 1, search_result_count: null, attachments: null },
  ]);
});

test('a count that is not a whole number of at least 0 goes out as null; null stays null', async () => {
  const odd = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '7' as unknown as number];
  for (const value of odd) {
    const [turn] = (await detailOf(listEntry(), thread([assistantTurn(value, value, value)]))).turns;
    assert.deepEqual([turn.text_chars, turn.text_words, turn.citation_count], [null, null, null], String(value));
  }
  const [kept] = (await detailOf(listEntry(), thread([assistantTurn(0, null, 0)]))).turns;
  assert.deepEqual([kept.text_chars, kept.text_words, kept.citation_count], [0, null, 0]);
  const blocks = await detailOf(listEntry(), { turns: [], blocks: -1, complete: true });
  assert.equal(blocks.metadata.turn_blocks, null);
});

test('a detail record does not change the thread it was built from', async () => {
  const turns = numberedTurns(1001);
  const before = JSON.stringify(turns);
  await detailOf(listEntry(), thread(turns));
  assert.equal(JSON.stringify(turns), before);
});

test('no record holds the title, the mstk, the answer text at [14], the URL at [2] or any other text of the entry', async () => {
  const entries = [listEntry(), listEntry({ 6: null }), listEntry({ 2: [URL_MARKER, 'TEXT-MARKER-24'], 14: [[ANSWER_MARKER]], 30: 'TEXT-MARKER-24' })];
  for (const entry of entries) {
    const title = await hashTitle(entry.title, sha256);
    for (const record of [buildSummaryRecord(entry, title), buildDetailRecord(entry, title, thread(SMALL)), buildDetailRecord(entry, title, thread(numberedTurns(1001)))]) {
      const text = JSON.stringify(record);
      for (const marker of MARKERS) {
        assert.equal(text.includes(marker), false, `${marker} in a ${record.is_summary ? 'summary' : 'detail'} record`);
      }
      assert.equal(text.includes(TITLE_HASH), true, 'the title goes out as its hash');
    }
  }
});
