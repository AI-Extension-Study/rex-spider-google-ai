import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { DateString } from '@bric/rex-types/types';

import { LIST_NUMBER_KEYS, type ListEntry, parseListPage } from '../../src/list.mts';
import { type AimTurn, type DetailOptions, type ParsedThread, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { redactGoogleAiMode } from '../../src/redact.mts';
import { parseTurns } from '../../src/turns.mts';
import { CREATED_S, MARKERS, MSTK, MTID, UPDATED_S, assistantTurn, listEntry, numberedTurns, rawEntry, thread, userTurn } from './fixtures.mts';
import { threadHtml } from './thread-fixtures.mts';

type Json = Record<string, unknown>;

// Text no output may hold. The space keeps it out of every id form, so a
// test that finds it in an output finds a form that let text through.
const MARK = 'LEAK MARKER';
// Text in the id form of the mtid and of the scaffold's name and platform, so
// those three are the only places it can go out.
const ID_MARK = 'idform-marker-0123';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const redact = (event: unknown): Json => redactGoogleAiMode(event as Json);

// What the extension uploads: rex-content-processing walks the processor's
// output and copies each object's own keys into a plain one, so a DateString
// goes out as {value, originalValue}, originalValue included.
function walked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walked);
  if (Object.prototype.toString.call(value) !== '[object Object]') return value;
  return Object.fromEntries(Object.keys(value as object).map((key) => [key, walked((value as Json)[key])]));
}
const wire = (value: unknown): string => JSON.stringify(walked(value));

const NAME = 'rex-conversation';
const PLATFORM = 'google-ai-mode';
const TEN = ['3', '11', '13', '17', '18', '23', '25', '26', '27', '30'];
const SUMMARY_KEYS = ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'metadata'];
const DETAIL_KEYS = ['name', 'platform', 'identifier', 'format_version', 'is_summary', 'date', 'started', 'ended', 'turns', 'turns_complete', 'metadata'];
const TURN_KEYS = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments'];
const ENVELOPE = ['generatorId', '_pdk_trace_context', 'passive-data-metadata'];
const CREATED_ISO = '2025-11-16T13:33:20Z';

// An mstk of the length the shortest one in the URL captures had (135
// characters and more), so the old crawler's <mstk>_<mtid> is past 64.
const OLD_MSTK = MSTK.repeat(5);
const oldEntry = (): unknown[] => rawEntry({ 0: [OLD_MSTK, MTID], 22: [['mtid', MTID], ['csuir', '1'], ['mstk', OLD_MSTK], ['udm', '50']] });
// A point as the old crawler sent it: the raw 31-position entry as its
// metadata, keyed by <[0][0]>_<[0][1]>, with no format_version.
function oldPoint(entry: unknown[]): Json {
  const ids = entry[0] as unknown[];
  return {
    name: NAME, date: UPDATED_S * 1000, identifier: `${String(ids?.[0])}_${String(ids?.[1])}`, turns: [], platform: PLATFORM,
    started: new DateString(CREATED_S), ended: new DateString(UPDATED_S), metadata: entry,
  };
}

// The title hash hashTitle gives (record.test.mts pins it): the SHA-256 of
// the title, or null for none. Made here without a promise, since this
// repo's target has no top-level await.
const titleHash = (entry: ListEntry): string | null => (entry.title === null ? null : sha256(entry.title));
const summaryOf = (entry: ListEntry): Json => buildSummaryRecord(entry, titleHash(entry)) as unknown as Json;
const detailOf = (entry: ListEntry, parsed: ParsedThread, options?: DetailOptions): Json => buildDetailRecord(entry, titleHash(entry), parsed, options) as unknown as Json;

const SMALL: AimTurn[] = [userTurn(12, 3), assistantTurn(840, 131, 6), userTurn(25, 5), assistantTurn(1203, 188, 0)];
const parsed = (...specs: object[]): ParsedThread => parseTurns(threadHtml(specs));

// Every shape of record the builders make from the fixtures.
const RECORDS: ReadonlyArray<[string, Json]> = [
  ['summary of a titled entry', summaryOf(listEntry())],
  ['summary of an untitled entry', summaryOf(listEntry({ 1: null }))],
  ['summary of an entry never updated', summaryOf(listEntry({ 6: null }))],
  ['summary whose list numbers are out of range', summaryOf(listEntry({ 3: 1000, 13: -1, 17: 1.5, 27: 'two', 30: 999 }))],
  ['summary at fractional seconds', summaryOf(listEntry({ 5: [CREATED_S + 0.25, 0], 6: [UPDATED_S + 0.5, 0] }))],
  ['summary of an entry whose [6] is before its [5]', summaryOf(listEntry({ 6: [CREATED_S - 42, 263_669_000] }))],
  ['detail of an entry whose [6] is before its [5]', detailOf(listEntry({ 6: [CREATED_S - 42, 263_669_000] }), thread(SMALL))],
  ['detail of a two-question thread', detailOf(listEntry(), thread(SMALL))],
  ['detail of five parsed turn blocks', detailOf(listEntry(), parsed({}, {}, {}, {}, {}))],
  ['detail whose first question has no heading', detailOf(listEntry(), parsed({ heading: null }, {}))],
  ['detail whose answer has no main column', detailOf(listEntry(), parsed({ mainId: null }))],
  ['detail whose answer has two controls blocks', detailOf(listEntry(), parsed({ controls: 2 }))],
  ['detail of a thread with no turn blocks', detailOf(listEntry(), parsed())],
  ['detail cut to the newest four turns', detailOf(listEntry(), thread(numberedTurns(10)), { maxTurns: 4 })],
  ['detail of an untitled entry with null counts and no block count', detailOf(listEntry({ 1: null }), thread([userTurn(null, null), assistantTurn(null, null, null)], true, -1))],
];
const recordOf = (what: string): Json => (RECORDS.find(([name]) => name.includes(what)) ?? assert.fail(`no record ${what}`))[1];
const SUMMARY = recordOf('summary of a titled entry');
const DETAIL = recordOf('two-question thread');
const scaffoldOf = (record: Json): Json => ({ date: record.date, name: NAME, platform: PLATFORM, identifier: record.identifier });

// The output's form, checked apart from the redactor's own tables: a record
// with exactly its keys, each in its form, or a scaffold.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORD = /^[a-z][a-z0-9-]{0,63}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isCount = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const SCAFFOLD_FORMS: Readonly<Record<string, (value: unknown) => boolean>> = {
  date: (value) => typeof value === 'number' && Number.isFinite(value),
  name: (value) => typeof value === 'string' && WORD.test(value),
  platform: (value) => typeof value === 'string' && WORD.test(value),
  identifier: (value) => typeof value === 'string' && ID.test(value),
  generatorId: (value) => typeof value === 'string' && WORD.test(value),
  _pdk_trace_context: (value) => value !== undefined,
  'passive-data-metadata': (value) => value !== undefined,
};
function assertInForm(out: Json, what: string): void {
  if (typeof out.is_summary !== 'boolean') {
    for (const [key, value] of Object.entries(out)) {
      assert.ok(Object.prototype.hasOwnProperty.call(SCAFFOLD_FORMS, key) && SCAFFOLD_FORMS[key](value), `${what}: the scaffold's ${key}`);
    }
    return;
  }
  assert.deepEqual(Object.keys(out).filter((key) => !ENVELOPE.includes(key)), out.is_summary ? SUMMARY_KEYS : DETAIL_KEYS, `${what}: keys`);
  assert.deepEqual([out.name, out.platform, out.format_version], [NAME, PLATFORM, 1], `${what}: name, platform, format_version`);
  assert.ok(out.identifier === null || (typeof out.identifier === 'string' && ID.test(out.identifier)), `${what}: identifier`);
  for (const key of ['started', 'ended']) {
    const date = out[key];
    assert.ok(date instanceof DateString && /^number:\d+(\.\d+)?$/.test(date.originalValue) && Object.keys(date).length === 2, `${what}: ${key}`);
  }
  assert.equal(out.date, ((out.is_summary ? out.ended : out.started) as DateString).timestamp(), `${what}: date`);
  assert.ok(Array.isArray(out.turns), `${what}: turns`);
  if (out.is_summary) {
    assert.deepEqual(out.turns, [], `${what}: a summary's turns`);
  } else {
    assert.equal(typeof out.turns_complete, 'boolean', `${what}: turns_complete`);
  }
  for (const turn of out.turns as Json[]) {
    assert.deepEqual(Object.keys(turn), TURN_KEYS, `${what}: turn keys`);
    assert.deepEqual([turn.identifier, turn.parent, turn.when, turn.on_current_branch, turn.search_result_count, turn.attachments], [null, null, null, true, null, null], `${what}: fixed turn keys`);
    assert.ok(['user', 'assistant', 'unrecognised'].includes(turn.speaker as string), `${what}: speaker`);
    assert.ok(isCount(turn.text_chars) && isCount(turn.text_words) && isCount(turn.citation_count), `${what}: counts`);
  }
  const metadata = out.metadata as Json;
  assert.deepEqual(Object.keys(metadata), ['title_hash', 'created_at', 'updated_at', 'list_numbers', ...(out.is_summary ? [] : ['turn_blocks'])], `${what}: metadata keys`);
  assert.ok(metadata.title_hash === null || (typeof metadata.title_hash === 'string' && /^[0-9a-f]{64}$/.test(metadata.title_hash)), `${what}: title_hash`);
  for (const key of ['created_at', 'updated_at']) {
    assert.ok(metadata[key] === null || (typeof metadata[key] === 'string' && UTC.test(metadata[key])), `${what}: ${key}`);
  }
  const numbers = metadata.list_numbers as Json;
  assert.deepEqual(Object.keys(numbers), TEN, `${what}: list_numbers keys`);
  assert.ok(Object.values(numbers).every((value) => value === null || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 999)), `${what}: list_numbers values`);
  assert.ok(out.is_summary || isCount(metadata.turn_blocks), `${what}: turn_blocks`);
}

test('every record the builders make on the fixtures comes back equal: as built, as the walker leaves its times, and with each instant as its string', () => {
  assert.equal(RECORDS.length, 15, 'Test setup invalid: a fixture record is missing');
  const details = RECORDS.map(([, record]) => record).filter((record) => record.is_summary === false);
  assert.ok(
    details.some((record) => record.turns_complete === false) && details.some((record) => record.turns_complete === true)
      && details.some((record) => (record.metadata as Json).turn_blocks === null) && details.some((record) => (record.turns as Json[]).some((turn) => turn.text_chars === null))
      && RECORDS.some(([, record]) => (record.metadata as Json).title_hash === null) && RECORDS.some(([, record]) => Object.values((record.metadata as Json).list_numbers as Json).includes(null)),
    'Test setup invalid: the fixtures lack an incomplete or complete detail, a null block count, a null count, a null title hash or a null list number',
  );
  for (const [what, record] of RECORDS) {
    const started = record.started as DateString;
    const ended = record.ended as DateString;
    const forms: Array<[string, Json]> = [
      ['as built', record],
      ['as the walker leaves it', { ...record, started: { ...started }, ended: { ...ended } }],
      ['with each instant as its string', {
        ...record, started: { value: started.toJSON(), originalValue: started.originalValue }, ended: { value: ended.toJSON(), originalValue: ended.originalValue },
      }],
    ];
    for (const [form, event] of forms) {
      const out = redact(event);
      assert.deepEqual(plain(out), plain(record), `${what}, ${form}`);
      // What goes out, in order, each time's originalValue included.
      assert.equal(wire(out), wire(record), `${what}, ${form}: as uploaded`);
      assert.ok(out.started instanceof DateString && out.ended instanceof DateString, `${what}, ${form}: a time is not a DateString`);
      assertInForm(out, `${what}, ${form}`);
    }
  }
});

// started is the earlier of [5] and [6] (record.mts), so on such an entry
// started, ended and updated_at are all [6] and created_at alone is [5].
test('a record of an entry whose [6] is before its [5] comes back whole: started and ended [6], the detail dated by [6], created_at [5]', () => {
  const earlyIso = '2025-11-16T13:32:38Z';
  for (const what of ['summary of an entry whose [6]', 'detail of an entry whose [6]']) {
    const record = recordOf(what);
    const out = redact(record);
    assert.equal(wire(out), wire(record), what);
    const sent = plain(out);
    assert.deepEqual([sent.date, sent.started, sent.ended], [(CREATED_S - 42) * 1000, earlyIso, earlyIso], what);
    assert.deepEqual([(sent.metadata as Json).created_at, (sent.metadata as Json).updated_at], [CREATED_ISO, earlyIso], what);
    assertInForm(out, what);
  }
});

test('a point that is not a format 1 record of this platform, or whose top level is of the wrong form, keeps only the scaffold', () => {
  const scaffold = scaffoldOf(SUMMARY);
  const ended = SUMMARY.ended as DateString;
  const msEnded = new DateString(UPDATED_S * 1000);
  const early = new DateString(5);
  const cases: Array<[string, Json, Json]> = [
    ['no format_version', { ...SUMMARY, format_version: undefined }, scaffold],
    ['format_version 2', { ...SUMMARY, format_version: 2 }, scaffold],
    ['format_version as text', { ...SUMMARY, format_version: '1' }, scaffold],
    ['another platform', { ...SUMMARY, platform: 'chatgpt' }, { ...scaffold, platform: 'chatgpt' }],
    ['no platform', { ...SUMMARY, platform: undefined }, { date: SUMMARY.date, name: NAME, identifier: MTID }],
    ['another name', { ...SUMMARY, name: 'rex-other' }, { ...scaffold, name: 'rex-other' }],
    ['no is_summary', { ...SUMMARY, is_summary: undefined }, scaffold],
    ['is_summary as text', { ...SUMMARY, is_summary: 'true' }, scaffold],
    ['turns that are not a list', { ...SUMMARY, turns: {} }, scaffold],
    ['no turns', { ...SUMMARY, turns: undefined }, scaffold],
    ['a summary with a turn', { ...SUMMARY, turns: [SMALL[0]] }, scaffold],
    ['a summary with turns_complete', { ...SUMMARY, turns_complete: true }, scaffold],
    ['a summary with turns_complete false', { ...SUMMARY, turns_complete: false }, scaffold],
    ['metadata that is a list', { ...SUMMARY, metadata: [] }, scaffold],
    ['metadata that is the raw entry', { ...SUMMARY, metadata: rawEntry() }, scaffold],
    ['metadata null', { ...SUMMARY, metadata: null }, scaffold],
    ['no metadata', { ...SUMMARY, metadata: undefined }, scaffold],
    ['no started', { ...SUMMARY, started: undefined }, scaffold],
    ['no ended', { ...SUMMARY, ended: undefined }, scaffold],
    ['ended as a string', { ...SUMMARY, ended: ended.toJSON() }, scaffold],
    ['ended as epoch seconds', { ...SUMMARY, ended: UPDATED_S }, scaffold],
    ['ended of text', { ...SUMMARY, ended: { value: null, originalValue: `other:${MARK}` } }, scaffold],
    ['ended from an ISO string, which the builders never make', { ...SUMMARY, ended: new DateString(ended.toJSON()) }, scaffold],
    ['ended from epoch ms', { ...SUMMARY, ended: msEnded, date: msEnded.timestamp() }, { ...scaffold, date: msEnded.timestamp() }],
    ['ended before 2001', { ...SUMMARY, ended: early, date: early.timestamp() }, { ...scaffold, date: early.timestamp() }],
    ['ended from a Date', { ...SUMMARY, ended: new DateString(new Date(ended.timestamp())) }, scaffold],
    ['ended whose originalValue is negative', { ...SUMMARY, ended: { value: ended.value, originalValue: `number:-${UPDATED_S}` } }, scaffold],
    ['ended whose originalValue is in exponent form', { ...SUMMARY, ended: { value: ended.value, originalValue: 'number:1.7633036e9' } }, scaffold],
    ['ended whose originalValue carries text', { ...SUMMARY, ended: { value: ended.value, originalValue: `number:${UPDATED_S} ${MARK}` } }, scaffold],
    ['ended whose value is another instant', { ...SUMMARY, ended: { value: new DateString(CREATED_S).value, originalValue: ended.originalValue } }, scaffold],
    ['ended whose value is another instant as a string', { ...SUMMARY, ended: { value: CREATED_ISO, originalValue: ended.originalValue } }, scaffold],
    ['ended whose value only looks like an instant', { ...SUMMARY, ended: { value: { toString: () => ended.toJSON() }, originalValue: ended.originalValue } }, scaffold],
    ['ended with another own key', { ...SUMMARY, ended: { ...ended, note: 1 } }, scaffold],
    ['ended with no value', { ...SUMMARY, ended: { originalValue: ended.originalValue } }, scaffold],
    ['started of text', { ...SUMMARY, started: { value: null, originalValue: `other:${MARK}` } }, scaffold],
    ['a date that is not ended', { ...SUMMARY, date: (SUMMARY.date as number) + 1 }, { ...scaffold, date: (SUMMARY.date as number) + 1 }],
    ['a summary dated by its start', { ...SUMMARY, date: (SUMMARY.started as DateString).timestamp() }, { ...scaffold, date: (SUMMARY.started as DateString).timestamp() }],
    ['a date as text', { ...SUMMARY, date: String(SUMMARY.date) }, { name: NAME, platform: PLATFORM, identifier: MTID }],
  ];
  const detailScaffold = scaffoldOf(DETAIL);
  const endedMs = (DETAIL.ended as DateString).timestamp();
  cases.push(
    ['a detail with no is_summary', { ...DETAIL, is_summary: undefined }, detailScaffold],
    ['a detail with no turns_complete', { ...DETAIL, turns_complete: undefined }, detailScaffold],
    ['a detail whose turns_complete is text', { ...DETAIL, turns_complete: 'true' }, detailScaffold],
    ['a detail whose turns are not a list', { ...DETAIL, turns: { 0: SMALL[0] } }, detailScaffold],
    ['a detail dated by its end', { ...DETAIL, date: endedMs }, { ...detailScaffold, date: endedMs }],
    ['a detail whose metadata is a list', { ...DETAIL, metadata: [DETAIL.metadata] }, detailScaffold],
    ['the old crawler\'s point', oldPoint(oldEntry()), { date: UPDATED_S * 1000, name: NAME, platform: PLATFORM }],
    ['the old crawler\'s point marked as format 1', { ...oldPoint(oldEntry()), format_version: 1, is_summary: true }, { date: UPDATED_S * 1000, name: NAME, platform: PLATFORM }],
  );
  // Every case runs before the test fails, so one break shows each case it lets through.
  const wrong = cases.filter(([, event, expected]) => !isDeepStrictEqual(redact(event), expected)).map(([what]) => what);
  assert.deepEqual(wrong, []);
});

test('a list time at the edges of 2001 to 2286: a started and ended from 1e9 to 1e10 - 1 seconds come back equal, either one second outside cuts the record to the scaffold, and a [5] past it with [6] before it goes out as created_at', () => {
  // [5] and [6] as the list sends them, seconds and nanoseconds. started is
  // the earlier of the two and ended is [6], so a detail (dated by started)
  // and a summary (dated by ended) check each edge on both times.
  const at = (created: number, updated: number) => listEntry({ 5: [created, 0], 6: [updated, 0] });
  const middle = 1.5e9;
  const check = (label: string, record: Json, kept: boolean): void => {
    const out = redact(record);
    if (kept) {
      assert.equal(wire(out), wire(record), label);
    } else {
      assert.deepEqual(out, scaffoldOf(record), label);
    }
  };
  const cases: Array<[string, ListEntry, boolean]> = [
    ['both at 1e9', at(1e9, 1e9), true],
    ['both at 1e10 - 1', at(1e10 - 1, 1e10 - 1), true],
    ['[5] at 1e9, [6] at 1e10 - 1', at(1e9, 1e10 - 1), true],
    ['[5] at 1e9 - 1', at(1e9 - 1, middle), false],
    ['[6] at 1e9 - 1, which started is too', at(middle, 1e9 - 1), false],
    ['[6] at 1e10', at(middle, 1e10), false],
    ['both at 1e10', at(1e10, 1e10), false],
    // started is [6], so [5] goes out only as created_at, which keeps a UTC
    // time with a four-digit year.
    ['[5] at 1e10 and [6] before it', at(1e10, middle), true],
  ];
  for (const [what, entry, kept] of cases) {
    for (const record of [summaryOf(entry), detailOf(entry, thread(SMALL))]) {
      check(`${what}, is_summary ${String(record.is_summary)}`, record, kept);
    }
  }
  // started is never after ended in a record the builders make, so neither
  // a start past 2286 nor an end before 2001 comes alone from them. Those two
  // edges are checked on records changed by hand, each next to the same
  // change one second inside, which comes back equal, so the cut is the
  // bound's.
  const handMade: Array<[string, 'started' | 'ended', number, boolean]> = [
    ['started at 1e10 - 1', 'started', 1e10 - 1, true],
    ['started at 1e10', 'started', 1e10, false],
    ['ended at 1e9', 'ended', 1e9, true],
    ['ended at 1e9 - 1', 'ended', 1e9 - 1, false],
  ];
  for (const [what, key, seconds, kept] of handMade) {
    for (const built of [summaryOf(at(middle, middle)), detailOf(at(middle, middle), thread(SMALL))]) {
      const record: Json = { ...built, [key]: new DateString(seconds) };
      record.date = ((record.is_summary ? record.ended : record.started) as DateString).timestamp();
      check(`by hand, ${what}, is_summary ${String(record.is_summary)}`, record, kept);
    }
  }
});

test('the scaffold keeps each field only in its form, and the PDK envelope keys as they come, on a record too', () => {
  const event = { name: 'Rex Conversation', platform: PLATFORM, identifier: MARK, date: 'today', generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 }, 'passive-data-metadata': { timestamp: 2 }, title: MARK };
  assert.deepEqual(redact(event), { platform: PLATFORM, generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 }, 'passive-data-metadata': { timestamp: 2 } });
  assert.deepEqual(redact({ name: NAME, platform: MARK, generatorId: MARK, date: Number.NaN }), { name: NAME });
  assert.deepEqual(redact({ name: NAME, platform: PLATFORM, date: Number.POSITIVE_INFINITY, identifier: MTID }), { name: NAME, platform: PLATFORM, identifier: MTID });
  // A lowercase word of up to 64 characters is kept, and one of 65 is not.
  for (const key of ['name', 'platform', 'generatorId']) {
    assert.deepEqual(redact({ [key]: 'a'.repeat(64) }), { [key]: 'a'.repeat(64) }, `${key} of 64 characters`);
    assert.deepEqual(redact({ [key]: 'a-'.repeat(32) }), { [key]: 'a-'.repeat(32) }, `${key} of 64 characters with hyphens`);
    assert.deepEqual(redact({ [key]: 'a'.repeat(65) }), {}, `${key} of 65 characters`);
  }
  for (const record of [SUMMARY, DETAIL]) {
    const out = redact({ ...record, generatorId: 'rex-conversation', _pdk_trace_context: { bundle_id: 1 }, 'passive-data-metadata': { timestamp: 2 } });
    assert.deepEqual([out.generatorId, out._pdk_trace_context, out['passive-data-metadata'], out.is_summary], ['rex-conversation', { bundle_id: 1 }, { timestamp: 2 }, record.is_summary]);
    assert.deepEqual(plain(redact({ ...record, generatorId: 'Rex Conversation' })), plain(record), 'a generatorId out of form is left out');
  }
});

// Text glued to a value otherwise in form, before or after it, or after a
// space or a newline: each form is anchored at both ends, so none is kept.
const riders = (value: string): string[] => [`${MARK}${value}`, `${value}${MARK}`, `${value} ${MARK}`, `${value}\n${MARK}`, `${value}\n`];

test('the identifier is kept in id form up to 64 characters; anything else reads null in a record and is left out of the scaffold', () => {
  const longest = 'a'.repeat(64);
  assert.equal(redact({ ...SUMMARY, identifier: longest }).identifier, longest);
  assert.equal(redact({ ...DETAIL, identifier: 'A-z_0' }).identifier, 'A-z_0');
  const odd: unknown[] = ['a'.repeat(65), '', `${MTID}.`, `${MTID}Ä`, ...riders(MTID), `${OLD_MSTK}_${MTID}`, 7, null, undefined, [MTID], { id: MTID }];
  for (const identifier of odd) {
    for (const record of [SUMMARY, DETAIL]) {
      const out = redact({ ...record, identifier });
      assert.equal(out.is_summary, record.is_summary, `${JSON.stringify(identifier)}: the record was cut`);
      assert.equal(out.identifier, null, JSON.stringify(identifier));
      assert.deepEqual(plain(out), { ...plain(record), identifier: null }, JSON.stringify(identifier));
      assert.deepEqual(redact({ ...record, format_version: undefined, identifier }), { date: record.date, name: NAME, platform: PLATFORM }, JSON.stringify(identifier));
    }
  }
});

test('an unknown key at any level is dropped, and the record comes back as it was without it', () => {
  // Keys named like Object's own are read only as the value's own keys.
  const extra = { 'content*': MARK, title: MARK, constructor: MARK, toString: MARK, ...Object.fromEntries([['__proto__', { title: MARK }]]) };
  const metadata = DETAIL.metadata as Json;
  const planted = {
    ...DETAIL, ...extra, mstk: MSTK, user_agent: 'Browser', title_hash: 'f'.repeat(64),
    turns: (DETAIL.turns as Json[]).map((turn) => ({ ...turn, ...extra, 'metadata*': { text: MARK }, content_type: 'text', model_slug: 'gemini', nodes: 1 })),
    metadata: {
      ...metadata, ...extra, mstk: MSTK, 14: MARK, 22: [['mstk', MSTK]], is_starred: true,
      list_numbers: { ...(metadata.list_numbers as Json), ...extra, 0: 5, 14: 7, 22: 1, 31: 2, '03': 4, ' 3': 4 },
    },
  };
  assert.ok(Object.prototype.hasOwnProperty.call(planted, '__proto__'), 'Test setup invalid: __proto__ is not an own key');
  assert.equal(wire(redact(planted)), wire(DETAIL));
  const summaryMetadata = SUMMARY.metadata as Json;
  const summary = {
    ...SUMMARY, ...extra, user_agent: 'Browser',
    metadata: { ...summaryMetadata, ...extra, turn_blocks: 2, snippet: MARK, id: MTID, list_numbers: { ...(summaryMetadata.list_numbers as Json), 1: 1 } },
  };
  assert.equal(wire(redact(summary)), wire(SUMMARY), 'a summary keeps no turn_blocks');
});

test('list_numbers keeps exactly its ten keys, in order, each an integer from 0 to 999, else null', () => {
  assert.deepEqual([...LIST_NUMBER_KEYS], TEN, 'the list module and this test name other keys');
  const numbers = {
    0: 1, 1: 2, 2: 3, 3: 0, 11: 999, 13: 1000, 17: -1, 18: 1.5, 23: '1', 25: null, 26: true, 27: 2, 30: Number.NaN, 31: 4, 22: 5, x: 6, [MARK]: 7,
  };
  const out = (redact({ ...SUMMARY, metadata: { ...(SUMMARY.metadata as Json), list_numbers: numbers } }).metadata as Json).list_numbers;
  assert.equal(JSON.stringify(out), JSON.stringify({ 3: 0, 11: 999, 13: null, 17: null, 18: null, 23: null, 25: null, 26: null, 27: 2, 30: null }));
  const nulls = JSON.stringify(Object.fromEntries(TEN.map((key) => [key, null])));
  for (const odd of [undefined, null, 7, MARK, [], rawEntry(), Object.create({ 3: 1, 27: 2 }), { 25: [0], 26: { 0: 1 } }]) {
    for (const record of [SUMMARY, DETAIL]) {
      const kept = redact({ ...record, metadata: { ...(record.metadata as Json), list_numbers: odd } });
      assert.equal(kept.is_summary, record.is_summary, 'the record was cut');
      assert.equal(JSON.stringify((kept.metadata as Json).list_numbers), nulls, Array.isArray(odd) ? 'a list' : String(odd));
    }
  }
});

test('a metadata or turn value out of its form reads null, and a turn\'s fixed keys hold their one value whatever came', () => {
  const metadata = DETAIL.metadata as Json;
  const [user, reply] = DETAIL.turns as Json[];
  const out = redact({
    ...DETAIL,
    turns: [
      { ...user, identifier: MTID, parent: 'node-1', when: CREATED_ISO, text_chars: -1, text_words: 1.5, citation_count: '3', search_result_count: 3, attachments: 0 },
      { ...reply, identifier: MARK, text_chars: Number.NaN, text_words: Number.POSITIVE_INFINITY, citation_count: Number.MAX_SAFE_INTEGER + 2, search_result_count: MARK, attachments: [MARK] },
      { ...user, text_chars: Number.MAX_SAFE_INTEGER, text_words: 0, citation_count: true },
    ],
    metadata: { ...metadata, title_hash: 'F'.repeat(64), created_at: CREATED_S, updated_at: `${CREATED_ISO}[u-ca=iso8601]`, turn_blocks: -1 },
  });
  assert.equal(out.turns_complete, true, 'a turn was dropped');
  const nulls = { identifier: null, parent: null, when: null, search_result_count: null, attachments: null };
  assert.deepEqual(out.turns, [
    { ...user, ...nulls, text_chars: null, text_words: null, citation_count: null },
    { ...reply, ...nulls, text_chars: null, text_words: null, citation_count: null },
    { ...user, ...nulls, text_chars: Number.MAX_SAFE_INTEGER, text_words: 0, citation_count: null },
  ]);
  const kept = out.metadata as Json;
  assert.deepEqual([kept.title_hash, kept.created_at, kept.updated_at, kept.turn_blocks], [null, null, null, null]);
  for (const blocks of [1.5, '2', Number.NaN, Number.MAX_SAFE_INTEGER + 2, null, true]) {
    assert.equal((redact({ ...DETAIL, metadata: { ...metadata, turn_blocks: blocks } }).metadata as Json).turn_blocks, null, String(blocks));
  }
  assert.equal((redact({ ...DETAIL, metadata: { ...metadata, turn_blocks: 0 } }).metadata as Json).turn_blocks, 0);
});

test('a title hash or a time with text riding on it, or in another form than the builders write, reads null', () => {
  // Temporal reads each of these; only the shape and the builders' exact
  // writing stop them.
  const times = [...riders(CREATED_ISO), `${CREATED_ISO}[x=marker]`, '2025-11-16T13:33:20.500Z', '2025-11-16T13:33:20.000Z', '2025-11-16T13:33:20+00:00', '2025-11-16T13:33:20.5+00:00',
    '2025-11-16 13:33:20Z', '2025-11-16t13:33:20z', '2025-13-16T13:33:20Z', '2025-11-16T24:00:00Z', '+002025-11-16T13:33:20Z', '2025-11-16T13:33Z', CREATED_S, null,
    // No zone: a local time, which names no instant.
    '2025-11-16T13:33:20', '2025-11-16T13:33:20.5',
    // Temporal writes these back exactly; only the four-digit year stops them.
    '+010000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z'];
  for (const record of [SUMMARY, DETAIL]) {
    for (const time of times) {
      const kept = redact({ ...record, metadata: { ...(record.metadata as Json), created_at: time, updated_at: time } }).metadata as Json;
      assert.deepEqual([kept.created_at, kept.updated_at], [null, null], JSON.stringify(time));
    }
    for (const time of [CREATED_ISO, '2025-11-16T13:33:20.5Z', '2025-11-16T13:33:20.123456789Z']) {
      const kept = redact({ ...record, metadata: { ...(record.metadata as Json), created_at: time } }).metadata as Json;
      assert.equal(kept.created_at, time, 'a time the builders could write was lost');
    }
    for (const digest of [...riders('f'.repeat(64)), 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), `${'f'.repeat(63)}g`, 7]) {
      assert.equal((redact({ ...record, metadata: { ...(record.metadata as Json), title_hash: digest } }).metadata as Json).title_hash, null, JSON.stringify(digest));
    }
  }
});

test('a speaker other than user or assistant reads unrecognised, the builder\'s unchecked one included', () => {
  const [user, reply] = DETAIL.turns as Json[];
  for (const speaker of ['system', 'tool', 'User', 'ASSISTANT', ' user', 'user ', '', MARK, ID_MARK, 'unrecognised']) {
    const out = redact({ ...DETAIL, turns: [{ ...user, speaker }, reply] });
    assert.deepEqual([(out.turns as Json[]).map((turn) => turn.speaker), out.turns_complete], [['unrecognised', 'assistant'], true], JSON.stringify(speaker));
  }
  // The builder copies the parser's speaker without a check.
  const record = detailOf(listEntry(), thread([{ ...userTurn(4, 1), speaker: `system ${MARK}` as 'user' }, assistantTurn(9, 2, 0)]));
  assert.ok(wire(record).includes(MARK), 'Test setup invalid: the builder checks the speaker now');
  const out = redact(record);
  assert.deepEqual((out.turns as Json[]).map((turn) => turn.speaker), ['unrecognised', 'assistant']);
  assert.equal(wire(out).includes(MARK), false);
});

test('a turn that is not an object, has no speaker string, or is not on the current branch is dropped, and the turns read incomplete', () => {
  const [user, reply] = DETAIL.turns as Json[];
  const without = (turn: Json, key: string): Json => Object.fromEntries(Object.entries(turn).filter(([name]) => name !== key));
  const speechless = without(user, 'speaker');
  const branchless = without(reply, 'on_current_branch');
  const odd: Array<[string, unknown]> = [
    ['text', MARK], ['a list', [MARK]], ['null', null], ['a number', 7], ['true', true], ['a turn whose keys are all inherited', Object.create(user)],
    ['no speaker', speechless], ['a speaker that is null', { ...user, speaker: null }], ['a speaker that is a number', { ...user, speaker: 1 }],
    ['a speaker in a list', { ...user, speaker: ['user'] }], ['a speaker in an object', { ...user, speaker: { role: 'user' } }],
    ['no on_current_branch', branchless], ['off the current branch', { ...reply, on_current_branch: false }], ['on_current_branch null', { ...reply, on_current_branch: null }],
    ['on_current_branch as text', { ...reply, on_current_branch: 'true' }], ['on_current_branch 1', { ...reply, on_current_branch: 1 }],
  ];
  for (const [what, turn] of odd) {
    const out = redact({ ...DETAIL, turns: [user, turn, reply] });
    assert.equal(out.is_summary, false, `${what}: the record was cut`);
    assert.deepEqual([plain(out.turns), out.turns_complete], [[plain(user), plain(reply)], false], what);
    assert.equal(wire(out).includes(MARK), false, what);
  }
  const out = redact({ ...DETAIL, turns: [MARK, null] });
  assert.deepEqual([out.turns, out.turns_complete], [[], false]);
  // A hole is a place no turn came from.
  const sparse: unknown[] = [user];
  sparse[2] = reply;
  const holed = redact({ ...DETAIL, turns: sparse });
  assert.deepEqual([plain(holed.turns), holed.turns_complete], [[plain(user), plain(reply)], false]);
});

test('every metadata key is written, null where the record has none, in the builders\' order', () => {
  const numbers = Object.fromEntries(TEN.map((key) => [key, null]));
  for (const record of [SUMMARY, DETAIL]) {
    const metadata = redact({ ...record, metadata: {} }).metadata as Json;
    const expected = { title_hash: null, created_at: null, updated_at: null, list_numbers: numbers, ...(record.is_summary ? {} : { turn_blocks: null }) };
    assert.equal(JSON.stringify(metadata), JSON.stringify(expected), `is_summary ${String(record.is_summary)}`);
    assert.deepEqual(Object.keys(metadata), Object.keys(record.metadata as Json));
  }
});

// A copy with the marker in every leaf: after each string, in place of each
// null, in each empty list and empty object, and after a DateString's
// originalValue. Numbers and flags stay.
function markLeaves(value: unknown): unknown {
  if (typeof value === 'string') return `${value}${MARK}`;
  if (value === null) return MARK;
  if (value instanceof DateString) return Object.assign(Object.create(DateString.prototype), { value: value.value, originalValue: `${value.originalValue}${MARK}` });
  if (Array.isArray(value)) return value.length === 0 ? [MARK] : value.map(markLeaves);
  if (typeof value === 'object') return Object.keys(value).length === 0 ? { text: MARK } : Object.fromEntries(Object.entries(value).map(([key, held]) => [key, markLeaves(held)]));
  return value;
}

// A copy to change: objects and lists copied, a DateString as one, its
// Temporal instant shared, since an instant never changes.
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof DateString) return Object.assign(Object.create(DateString.prototype), { value: value.value, originalValue: value.originalValue });
  if (Object.prototype.toString.call(value) !== '[object Object]') return value;
  return Object.fromEntries(Object.entries(value as Json).map(([key, held]) => [key, copy(held)]));
}

// Each place one departure can go: every key of every object and list in a
// point, a DateString's two included, and one key more on each.
function placesOf(value: unknown, path: string[] = []): string[][] {
  if (!Array.isArray(value) && !(value instanceof DateString) && Object.prototype.toString.call(value) !== '[object Object]') return [];
  const keys = Object.keys(value as object);
  return [[...path, Array.isArray(value) ? String(value.length) : `${MARK}_key`], ...keys.flatMap((key) => [[...path, key], ...placesOf((value as Json)[key], [...path, key])])];
}

const valueAt = (point: unknown, path: readonly string[]): unknown => path.reduce((at: unknown, key) => (at as Json | undefined)?.[key], point);

type Probe = (() => unknown) | 'delete' | 'throws';
function departed(point: Json, path: readonly string[], probe: Probe): Json {
  const event = copy(point) as Json;
  const target = path.slice(0, -1).reduce((at: Json, key) => at[key] as Json, event);
  const key = path[path.length - 1];
  if (probe === 'delete') delete target[key];
  else if (probe === 'throws') Object.defineProperty(target, key, { enumerable: true, get: () => { throw new Error(MARK); } });
  else target[key] = probe();
  return event;
}

test('a marker planted in any one field of a record, at a key more on any object, or in all of them at once never goes out', () => {
  let kept = 0;
  for (const [what, record] of RECORDS) {
    for (const path of placesOf(record)) {
      const out = redact(departed(record, path, () => {
        const held = valueAt(record, path);
        return typeof held === 'string' ? `${held}${MARK}` : MARK;
      }));
      assert.equal(wire(out).includes(MARK), false, `${what}: ${path.join('.')}`);
      assertInForm(out, `${what}: ${path.join('.')}`);
      kept += typeof out.is_summary === 'boolean' ? 1 : 0;
    }
    const all = markLeaves(record);
    assert.ok(wire(all).includes(MARK), 'Test setup invalid: no marker planted');
    assert.equal(wire(redact(all)).includes(MARK), false, `${what}: every leaf`);
  }
  assert.ok(kept > 300, `Test setup invalid: only ${kept} marked records were kept as records`);
});

test('no text gets through from the old crawler\'s raw 31-position entry, as its own point, as a record\'s metadata or as its list numbers', () => {
  const raw = markLeaves(oldEntry()) as unknown[];
  assert.equal(raw.length, 31, 'Test setup invalid: the raw entry does not have 31 positions');
  const asKeys = Object.fromEntries(raw.map((value, position) => [String(position), value]));
  const points: Array<[string, Json, boolean]> = [
    ['the old crawler\'s point, marked in every position', oldPoint(raw), false],
    ['the old crawler\'s point, its identifier and times marked too', markLeaves(oldPoint(oldEntry())) as Json, false],
    ['the old point with format_version 1', { ...oldPoint(raw), format_version: 1, is_summary: true }, false],
    ['a summary whose metadata is the raw entry', { ...SUMMARY, metadata: raw }, false],
    ['a summary whose metadata holds the raw entry\'s positions', { ...SUMMARY, metadata: { ...(SUMMARY.metadata as Json), ...asKeys } }, true],
    ['a detail whose list_numbers are the raw entry\'s positions', { ...DETAIL, metadata: { ...(DETAIL.metadata as Json), list_numbers: asKeys } }, true],
    ['a detail whose list_numbers are the raw entry', { ...DETAIL, metadata: { ...(DETAIL.metadata as Json), list_numbers: raw } }, true],
    ['a detail whose turns hold the raw entry', { ...DETAIL, turns: [...(DETAIL.turns as Json[]), raw, { ...(DETAIL.turns as Json[])[0], 'metadata*': raw, 'content*': MARK }] }, true],
  ];
  for (const [what, point, isRecord] of points) {
    assert.ok(wire(point).includes(MARK), `Test setup invalid: ${what} carries no marker`);
    const out = redact(point);
    const text = wire(out);
    for (const marker of [MARK, ...MARKERS]) {
      assert.equal(text.includes(marker), false, `${what}: ${marker}`);
    }
    assertInForm(out, what);
    // Kept as a record where it is one, so the text was dropped from a record that went out.
    assert.equal(typeof out.is_summary === 'boolean', isRecord, what);
  }
  // Each position alone, in the old crawler's point.
  for (let position = 0; position < 31; position += 1) {
    const entry = oldEntry();
    entry[position] = markLeaves(entry[position] ?? null);
    assert.equal(wire(redact(oldPoint(entry))).includes(MARK), false, `position ${position}`);
  }
});

test('it never throws: a field that throws, a proxy, or no object at all gives the scaffold or nothing, and nothing is printed', (t) => {
  const printed: string[] = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => printed.push(args.map(String).join(' ')));
  }
  const hostile = new Proxy({}, Object.fromEntries(['get', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((trap) => [trap, () => { throw new Error(MARK); }])));
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const throwing = (record: Json, key: string): Json => {
    const event = { ...record };
    Object.defineProperty(event, key, { enumerable: true, get: () => { throw new Error(MARK); } });
    return event;
  };
  assert.deepEqual(redact(throwing(SUMMARY, 'metadata')), scaffoldOf(SUMMARY));
  // An identifier that cannot be read is out of its form: the record goes, with identifier null.
  assert.deepEqual(plain(redact(throwing(SUMMARY, 'identifier'))), { ...plain(SUMMARY), identifier: null });
  assert.deepEqual(redact({ ...DETAIL, turns: new Proxy(DETAIL.turns as Json[], { get: () => { throw new Error(MARK); } }) }), scaffoldOf(DETAIL));
  assert.deepEqual(redact({ ...DETAIL, turns: [hostile] }), scaffoldOf(DETAIL));
  assert.deepEqual(redact({ ...DETAIL, metadata: { ...(DETAIL.metadata as Json), list_numbers: hostile } }), scaffoldOf(DETAIL));
  assert.deepEqual(redact({ ...SUMMARY, ended: hostile }), scaffoldOf(SUMMARY));
  assert.deepEqual(redact({ ...SUMMARY, ended: revocable.proxy }), scaffoldOf(SUMMARY));
  for (const value of [hostile, revocable.proxy, null, undefined, 42, MARK, [SUMMARY], Object.create(SUMMARY)]) {
    assert.deepEqual(redact(value), {});
  }
  assert.deepEqual(printed, []);
});

// A seeded generator (mulberry32), so every run makes the same departures.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROBES: ReadonlyArray<[string, Probe]> = [
  ['deleted', 'delete'], ['a getter that throws', 'throws'], ['undefined', () => undefined], ['null', () => null], ['an empty string', () => ''],
  ['text', () => `${MARK} text`], ['the marker', () => MARK], ['id-form text', () => ID_MARK], ['zero', () => 0], ['minus one', () => -1], ['a fraction', () => 1.5],
  ['not a number', () => Number.NaN], ['infinity', () => Number.POSITIVE_INFINITY], ['an unsafe integer', () => Number.MAX_SAFE_INTEGER + 2], ['1000', () => 1000],
  ['true', () => true], ['false', () => false], ['an empty object', () => ({})], ['an object holding text', () => ({ text: MARK, 'content*': MARK })],
  ['an empty list', () => []], ['a list holding text', () => [MARK, { title: MARK }]], ['the marked raw entry', () => markLeaves(rawEntry())],
  ['an impossible time', () => '2025-13-16T13:33:20Z'], ['another instant', () => '2026-01-01T00:00:00Z'], ['epoch seconds', () => CREATED_S], ['epoch ms', () => CREATED_S * 1000],
  ['the mtid', () => MTID], ['the old identifier', () => `${OLD_MSTK}_${MTID}`], ['a speaker', () => 'assistant'], ['unrecognised', () => 'unrecognised'],
  ['a digest', () => 'f'.repeat(64)], ['a digest in capitals', () => 'F'.repeat(64)], ['the turn form', () => ({ ...SMALL[0], 'content*': MARK })],
  ['a DateString of text', () => Object.assign(Object.create(DateString.prototype), { value: null, originalValue: `other:${MARK}` })],
  ['a DateString of another instant', () => new DateString(CREATED_S + 1)], ['an instant look-alike', () => ({ toString: () => '2026-01-01T00:00:00Z', toJSON: () => MARK })],
];

test('2,000 single-field departures from records the builders make: none throws, none lets text out, every output is in form, nothing is printed', (t) => {
  const printed: string[] = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => printed.push(args.map(String).join(' ')));
  }
  const random = seeded(20261116);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const bases = [SUMMARY, recordOf('never updated'), DETAIL, recordOf('five parsed'), recordOf('null counts')].map((record): [Json, string[][]] => [record, placesOf(record)]);
  const outcomes = { kept: 0, cut: 0 };
  for (let n = 0; n < 2000; n += 1) {
    const [record, places] = pick(bases);
    const path = pick(places);
    const [probe, value] = pick(PROBES);
    const what = `${String(record.is_summary)}: ${path.join('.')} ${probe}`;
    let out: Json = {};
    assert.doesNotThrow(() => { out = redact(departed(record, path, value)); }, what);
    const text = wire(out);
    assert.equal(text.includes(MARK) || text.includes(MSTK), false, what);
    // Id-form text goes out only where an id form holds it: the identifier,
    // or the scaffold's name or platform.
    if (text.includes(ID_MARK)) {
      assert.ok(path.length === 1 && ['identifier', 'name', 'platform'].includes(path[0]) && out[path[0]] === ID_MARK, what);
    }
    assertInForm(out, what);
    outcomes[typeof out.is_summary === 'boolean' ? 'kept' : 'cut'] += 1;
  }
  assert.deepEqual(printed, []);
  // Both ways out were taken, so the departures reached the record checks and the field forms alike.
  assert.ok(outcomes.kept > 500 && outcomes.cut > 100, JSON.stringify(outcomes));
  t.diagnostic(`${outcomes.kept} kept as records, ${outcomes.cut} cut to the scaffold`);
});

// Values JSON can carry, each in or out of a form the list or a record holds.
const RAW_VALUES: readonly unknown[] = [
  null, 0, -1, 1.5, 5, 999, 1000, CREATED_S, CREATED_S + 0.5, UPDATED_S + 0.123, CREATED_S * 1000, true, false, '', 'x', MARK, MTID, ID_MARK, 'f'.repeat(64),
  [], [MARK], [CREATED_S, 0], [UPDATED_S + 0.25, 7], [UPDATED_S + 3600, 0], [0, 0], [-5, 0], [CREATED_S * 1000, 0], [null, 0], {}, { text: MARK }, [['mstk', MSTK]],
  [MSTK, MTID], [MSTK, ID_MARK], [MSTK, MARK], ['mstk', MSTK],
];

function departRaw(raw: unknown[], random: () => number): unknown[] {
  const event = JSON.parse(JSON.stringify(raw)) as unknown[];
  for (let n = 1 + Math.floor(random() * 3); n > 0; n -= 1) {
    const places = placesOf(event);
    const path = places[Math.floor(random() * places.length)];
    const target = path.slice(0, -1).reduce((at: Json, key) => at[key] as Json, event as unknown as Json);
    const key = path[path.length - 1];
    if (random() < 0.1) delete target[key];
    // A copy, so a later departure never writes into the constant.
    else target[key] = structuredClone(RAW_VALUES[Math.floor(random() * RAW_VALUES.length)]);
  }
  return JSON.parse(JSON.stringify(event)) as unknown[];
}

const entryOf = (raw: unknown[]): ListEntry | null => parseListPage(`)]}'\n\n${JSON.stringify([[raw], null, 1])}`)?.entries[0] ?? null;
// The seconds a list time was built from, as its originalValue writes them.
const secondsOf = (date: unknown): number => Number((date as DateString).originalValue.slice('number:'.length));
const inYears = (date: unknown): boolean => secondsOf(date) >= 1e9 && secondsOf(date) < 1e10;

test('2,000 seeded departures of a raw list entry: a record whose started and ended are in 2001 to 2286 comes back equal but for a created_at past a four-digit year, which reads null; any other is cut to the scaffold', (t) => {
  const random = seeded(20261117);
  const turns = parsed({}, { heading: null });
  const tally = { records: 0, none: 0, cut: 0, nulled: 0 };
  for (let n = 0; n < 2000; n += 1) {
    const raw = departRaw(rawEntry(), random);
    const entry = entryOf(raw);
    if (entry === null) {
      tally.none += 1;
      continue;
    }
    for (const record of [summaryOf(entry), detailOf(entry, turns)]) {
      tally.records += 1;
      const what = `departure ${n}, is_summary ${String(record.is_summary)}: ${JSON.stringify(raw)}`;
      const out = redact(record);
      if (inYears(record.started) && inYears(record.ended)) {
        // started is the earlier of [5] and [6], so a [5] past 2286 goes out
        // only as created_at, which reads null when its year is not four
        // digits.
        const metadata = record.metadata as Json;
        const createdAt = UTC.test(String(metadata.created_at)) ? metadata.created_at : null;
        tally.nulled += createdAt === null ? 1 : 0;
        assert.equal(wire(out), wire({ ...record, metadata: { ...metadata, created_at: createdAt } }), what);
      } else {
        tally.cut += 1;
        assert.deepEqual(out, scaffoldOf(record), what);
      }
      // A departure can put a marker at [0][1], which the builder then sends
      // as the mtid; any other marker in the output came from the case.
      for (const marker of [MARK, ...MARKERS].filter((text) => !String(record.identifier).includes(text))) {
        assert.equal(wire(out).includes(marker), false, `${what}: ${marker}`);
      }
    }
  }
  t.diagnostic(`${tally.records} records, ${tally.cut} of them cut for a time, ${tally.nulled} kept with created_at null; ${tally.none} departures gave no entry`);
  assert.ok(tally.records > 2000 && tally.cut > 20 && tally.nulled > 0 && tally.none > 100, JSON.stringify(tally));
});

// Every module a source loads: import or export ... from, with either quote,
// with or without a semicolon or attributes; a bare import for its side
// effects; and import() and require(), listed by name.
function modulesLoaded(source: string): string[] {
  const named = [...source.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])(.+?)\1/gm)].map((match) => match[2]);
  const bare = [...source.matchAll(/^\s*import\s*(['"])(.+?)\1/gm)].map((match) => match[2]);
  const dynamic = [...source.matchAll(/\b(import|require)\s*\(/g)].map((match) => `${match[1]}()`);
  return [...named, ...bare, ...dynamic];
}

test('the redactor imports nothing but rex-types, so the extension can carry a copy of it', () => {
  const sample = [
    "import { a } from './a.mts';", 'import { b } from "./b.mts";', "import c from './c.mts';", "import * as d from './d.mts';", "import { e } from './e.mts'",
    "import f from './f.json' with { type: 'json' };", "export { g } from './g.mts';", "export * from './h.mts';", "import './i.mts';", "const j = await import('./j.mts');",
    "const k = require('./k.cjs');", "import type { l } from './l.mts';",
  ].join('\n');
  assert.deepEqual(
    modulesLoaded(sample),
    ['./a.mts', './b.mts', './c.mts', './d.mts', './e.mts', './f.json', './g.mts', './h.mts', './l.mts', './i.mts', 'import()', 'require()'],
    'Test setup invalid: the scan misses a way to load a module',
  );
  const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
  assert.deepEqual(modulesLoaded(source('keep.mts')), ['@bric/rex-types/types']);
  assert.deepEqual(modulesLoaded(source('redact.mts')), ['@bric/rex-types/types', './keep.mts']);
});
