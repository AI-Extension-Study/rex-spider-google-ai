import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { type Answer, type Client, RequestError } from '../../src/client.mts';
import { LIST_NUMBER_KEYS, type ListEntry, MAX_PAGES, PAGE_SIZE, listUrl, parseListPage, walkList } from '../../src/list.mts';

// Synthetic ids in the captured forms: an mtid of 22 characters, an mstk of
// 30 and more, a cursor of 30 and more, all [A-Za-z0-9_-].
const MTID = 'AbCdEfGhIjKlMnOpQrSt_1';
const MSTK = 'Mstk-0123456789_abcdefghijKLMNO';
const CURSOR_1 = 'Cursor-AAAAAAAAAAAAAAAAAAAAAAAAA1';
const CURSOR_2 = 'Cursor-AAAAAAAAAAAAAAAAAAAAAAAAA2';

const CREATED_S = 1_763_300_000; // 2025-11-16T13:33:20Z
const UPDATED_S = 1_763_303_600; // an hour later

// A list entry with the 31 positions the capture found, values in their
// captured forms ([5] and [6] are seconds and nanoseconds, [22] the four
// [key, value] pairs). Text positions hold made-up strings.
function entry(changes: Record<number, unknown> = {}, ids: { mtid?: string; mstk?: string; updated?: number } = {}): unknown[] {
  const mtid = ids.mtid ?? MTID;
  const mstk = ids.mstk ?? MSTK;
  const at: unknown[] = new Array(31).fill(null);
  at[0] = [mstk, mtid];
  at[1] = 'TITLE-MARKER synthetic title';
  at[3] = 0;
  at[5] = [CREATED_S, 741_739_000];
  at[6] = [ids.updated ?? UPDATED_S, 263_669_000];
  at[10] = 'FOLLOW-UP-MARKER';
  at[11] = 0;
  at[12] = 'FOLLOW-UP-MARKER';
  at[17] = 1;
  at[18] = 0;
  at[20] = 'QUESTION-MARKER';
  at[21] = 'TITLE-MARKER';
  at[22] = [['mtid', mtid], ['csuir', '1'], ['mstk', mstk], ['udm', '50']];
  at[23] = 1;
  at[24] = 'TEXT-MARKER';
  at[25] = 0;
  at[26] = 0;
  at[27] = 2;
  at[30] = 0;
  for (const [position, value] of Object.entries(changes)) {
    at[Number(position)] = value;
  }
  return at;
}

const body = (outer: unknown) => `)]}'\n\n${JSON.stringify(outer)}`;
// A page as the capture saw it: the entries, then null, 1, null, null and the
// cursor on every page but the last, which is the entries, null and 1.
const page = (entries: unknown[], cursor: string | null = null) => body(cursor === null ? [entries, null, 1] : [entries, null, 1, null, null, cursor]);
const LAST_EMPTY = body([null, null, 1]);
const SIGNED_OUT = ")]}'\n\n[]";

function only(text: string): ListEntry {
  const parsed = parseListPage(text);
  assert.ok(parsed !== null, 'the page did not parse');
  assert.equal(parsed.entries.length, 1, `expected one entry, malformed ${parsed.malformed}`);
  return parsed.entries[0];
}

test('the page size is 20 and the list number keys are the fixed set', () => {
  assert.equal(PAGE_SIZE, 20);
  assert.deepEqual([...LIST_NUMBER_KEYS], ['3', '11', '13', '17', '18', '23', '25', '26', '27', '30']);
});

test('listUrl(null) is the first page in the exact form', () => {
  assert.equal(listUrl(null), 'https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=%5Bnull%2C20%2C0%2Cnull%2Cnull%5D&msc=gwsclient');
});

test('listUrl(cursor) puts the cursor last in reqpld', () => {
  const url = listUrl(CURSOR_1);
  assert.equal(url, `https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=%5Bnull%2C20%2C0%2Cnull%2C%22${CURSOR_1}%22%5D&msc=gwsclient`);
  assert.deepEqual(JSON.parse(new URL(url).searchParams.get('reqpld') ?? ''), [null, 20, 0, null, CURSOR_1]);
});

test('a signed-out answer parses to no entries and no cursor', () => {
  assert.deepEqual(parseListPage(SIGNED_OUT), { entries: [], cursor: null, malformed: 0 });
});

test('the last page, [null, null, 1], parses to no entries and no cursor', () => {
  assert.deepEqual(parseListPage(LAST_EMPTY), { entries: [], cursor: null, malformed: 0 });
});

test('a page without the guard, or with the guard and no JSON, is null', () => {
  assert.equal(parseListPage(''), null);
  assert.equal(parseListPage(JSON.stringify([[entry()], null, 1])), null);
  assert.equal(parseListPage('<html><body>sign in</body></html>'), null);
  assert.equal(parseListPage(")]}'"), null);
  assert.equal(parseListPage(")]}'\n\n[[1,2"), null);
  assert.equal(parseListPage(` )]}'\n\n[]`), null);
});

test('a page whose outer value or entry list is not a list is null', () => {
  assert.equal(parseListPage(body({ threads: [] })), null);
  assert.equal(parseListPage(body('text')), null);
  assert.equal(parseListPage(body(null)), null);
  assert.equal(parseListPage(body(['not a list', null, 1])), null);
  assert.equal(parseListPage(body([{ 0: entry() }, null, 1])), null);
});

test('the cursor comes from outer[5]', () => {
  const parsed = parseListPage(page([entry()], CURSOR_1));
  assert.equal(parsed?.cursor, CURSOR_1);
  assert.equal(parseListPage(page([entry()]))?.cursor, null);
  assert.equal(parseListPage(body([[entry()], null, 1, null, null, null]))?.cursor, null);
  assert.equal(parseListPage(body([[entry()], null, 1, null, null, '']))?.cursor, null);
});

test('a page whose cursor is not an id-form string is null, so a changed layout cannot end the walk early as whole', () => {
  for (const cursor of [42, ['x'], 'has space', 'semi;colon', 'x'.repeat(1025), true]) {
    assert.equal(parseListPage(body([[entry()], null, 1, null, null, cursor])), null, `cursor ${JSON.stringify(cursor).slice(0, 20)}`);
  }
  assert.equal(parseListPage(body([[entry()], null, 1, null, null, 'x'.repeat(1024)]))?.cursor, 'x'.repeat(1024));
});

test('a 31-position entry gives mtid from [0][1], mstk from [22], and the title', () => {
  const got = only(page([entry()]));
  assert.equal(got.mtid, MTID);
  assert.equal(got.mstk, MSTK);
  assert.equal(got.title, 'TITLE-MARKER synthetic title');
});

test('mstk is read from [22] as a map, whatever the order of its pairs', () => {
  const orders = [
    [['mtid', MTID], ['csuir', '1'], ['mstk', MSTK], ['udm', '50']],
    [['mstk', MSTK], ['udm', '50'], ['mtid', MTID], ['csuir', '1']],
    [['udm', '50'], ['csuir', '1'], ['mtid', MTID], ['mstk', MSTK]],
  ];
  for (const pairs of orders) {
    // [0][0] is set to another value so the test shows mstk is not read from it.
    assert.equal(only(page([entry({ 0: ['Other-mstk-value', MTID], 22: pairs })])).mstk, MSTK);
  }
});

test('created is DateString([5][0]) and updated DateString([6][0]): seconds only, as the old spider read them', () => {
  const got = only(page([entry()]));
  assert.ok(got.created instanceof DateString);
  assert.ok(got.updated instanceof DateString);
  assert.equal(got.created.timestamp(), CREATED_S * 1000);
  assert.equal(got.updated.timestamp(), UPDATED_S * 1000);
  // The upload keys of the old spider were built from these, so they must
  // match a DateString made from the seconds alone, nanoseconds left out.
  assert.equal(JSON.stringify(got.created), JSON.stringify(new DateString(CREATED_S)));
  assert.equal(JSON.stringify(got.updated), JSON.stringify(new DateString(UPDATED_S)));
  assert.equal(got.created.originalValue, `number:${CREATED_S}`);
  assert.equal(got.updated.originalValue, `number:${UPDATED_S}`);
  assert.equal(JSON.stringify(got.updated), '"2025-11-16T14:33:20Z"');
});

test('updated is DateString([5][0]) when [6] is null', () => {
  const got = only(page([entry({ 6: null })]));
  assert.equal(got.updated.timestamp(), CREATED_S * 1000);
  assert.equal(got.updated.originalValue, `number:${CREATED_S}`);
});

test('numbers has exactly the list number keys, each an integer from 0 to 999 or null', () => {
  const got = only(page([entry({ 3: 0, 11: 999, 13: null, 17: 1, 18: 1000, 23: -1, 25: 2.5, 26: '3', 27: 2, 30: true })]));
  assert.deepEqual(Object.keys(got.numbers), [...LIST_NUMBER_KEYS]);
  assert.deepEqual(got.numbers, { 3: 0, 11: 999, 13: null, 17: 1, 18: null, 23: null, 25: null, 26: null, 27: 2, 30: null });
});

test('numbers is null at a list number position holding a list or an object', () => {
  const got = only(page([entry({ 17: [1], 27: { 0: 1 } })]));
  assert.equal(got.numbers['17'], null);
  assert.equal(got.numbers['27'], null);
});

test('numbers keys are the same on an entry shorter than 31 positions, null past its end', () => {
  const short = entry().slice(0, 25);
  const got = only(page([short]));
  assert.deepEqual(Object.keys(got.numbers), [...LIST_NUMBER_KEYS]);
  assert.equal(got.numbers['23'], 1);
  assert.equal(got.numbers['27'], null);
  assert.equal(got.numbers['30'], null);
});

test('title is null unless [1] is a non-empty string', () => {
  for (const title of ['', null, 5, ['x'], { x: 1 }]) {
    assert.equal(only(page([entry({ 1: title })])).title, null, JSON.stringify(title));
  }
});

test('an entry with a non-id mtid is skipped and counted in malformed', () => {
  const bad = [
    entry({ 0: [MSTK, 'has space'] }),
    entry({ 0: [MSTK, ''] }),
    entry({ 0: [MSTK, 'x'.repeat(65)] }),
    entry({ 0: [MSTK, 12345] }),
    entry({ 0: [MSTK] }),
    entry({ 0: null }),
    entry({ 0: 'not a list' }),
  ];
  const parsed = parseListPage(page([entry({}, { mtid: 'First_mtid-000000000001' }), ...bad, entry({}, { mtid: 'Last_mtid-0000000000002' })]));
  assert.ok(parsed !== null);
  assert.deepEqual(
    parsed.entries.map((item) => item.mtid),
    ['First_mtid-000000000001', 'Last_mtid-0000000000002'],
  );
  assert.equal(parsed.malformed, bad.length);
  // 64 characters is still an id.
  assert.equal(only(page([entry({}, { mtid: 'm'.repeat(64) })])).mtid, 'm'.repeat(64));
});

test('an entry whose mstk is missing or out of form is skipped and counted', () => {
  const pairs = (mstk: unknown) => [['mtid', MTID], ['csuir', '1'], ['mstk', mstk], ['udm', '50']];
  const bad = [
    entry({ 22: [['mtid', MTID], ['csuir', '1'], ['udm', '50']] }),
    entry({ 22: pairs('has space') }),
    entry({ 22: pairs('') }),
    entry({ 22: pairs('x'.repeat(1025)) }),
    entry({ 22: pairs(7) }),
    entry({ 22: [['mstk', MSTK], ['mstk', 'Another-mstk-value-0000000000']] }),
    entry({ 22: null }),
    entry({ 22: 'mstk' }),
    entry({ 22: [null, 'x', ['mstk']] }),
  ];
  const parsed = parseListPage(page([...bad, entry()]));
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.entries.map((item) => item.mtid), [MTID]);
  assert.equal(parsed.malformed, bad.length);
  assert.equal(only(page([entry({}, { mstk: 'k'.repeat(1024) })])).mstk, 'k'.repeat(1024));
});

test('an entry whose [5][0] or [6][0] is not a number is skipped and counted, never thrown', () => {
  const bad = [
    entry({ 5: null }),
    entry({ 5: [] }),
    entry({ 5: ['1763300000', 0] }),
    entry({ 5: [null, 0] }),
    entry({ 5: 1_763_300_000 }),
    entry({ 6: [] }),
    entry({ 6: ['1763303600', 0] }),
    entry({ 6: 1_763_303_600 }),
    entry({ 6: 'yesterday' }),
    // A number DateString cannot hold as an instant throws in its constructor.
    entry({ 5: [1e20, 0] }),
    entry({ 6: [-1e20, 0] }),
  ];
  const parsed = parseListPage(page([...bad, entry()]));
  assert.ok(parsed !== null);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.malformed, bad.length);
});

test('an entry that is not a list is skipped and counted', () => {
  const parsed = parseListPage(page([null, 'entry', 7, { 0: 1 }, entry()]));
  assert.ok(parsed !== null);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.malformed, 4);
});

test('an entry keeps nothing but the six fields: no text, no mstk from [0][0], no other position', () => {
  const got = only(page([entry()]));
  assert.deepEqual(Object.keys(got).sort(), ['created', 'mstk', 'mtid', 'numbers', 'title', 'updated']);
  const shown = JSON.stringify({ ...got, title: null });
  for (const marker of ['FOLLOW-UP-MARKER', 'QUESTION-MARKER', 'TEXT-MARKER', 'TITLE-MARKER']) {
    assert.ok(!shown.includes(marker), `the entry carries ${marker}`);
  }
});

// The walk, against a client that answers each list URL from a table.

const answer = (text: string, status = 200, headers: Record<string, string> = {}): Answer => ({ status, url: 'https://www.google.com/httpservice/web/AimThreadsService/ListThreads', headers, text });

type Reply = Answer | Error;

function fakeClient(pages: Record<string, Reply>, events: string[]): Client {
  return {
    async get(url) {
      events.push(`get ${url}`);
      const reply = pages[url];
      if (reply === undefined) {
        throw new Error(`no page for ${url}`);
      }
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
}

const always = async () => true;
const paced = (events: string[]) => async () => {
  events.push('pace');
};

const id = (n: number) => `Thread_${String(n).padStart(15, '0')}`;
// Entries numbered from `from`, newest first: entry n was updated n minutes
// before UPDATED_S.
const entries = (from: number, count: number) => Array.from({ length: count }, (_unused, k) => entry({}, { mtid: id(from + k), updated: UPDATED_S - 60 * (from + k) }));

test('the walk reads page after page by cursor, with pace() between requests and not before the first', async () => {
  const events: string[] = [];
  const client = fakeClient(
    {
      [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)),
      [listUrl(CURSOR_1)]: answer(page(entries(20, 20), CURSOR_2)),
      [listUrl(CURSOR_2)]: answer(LAST_EMPTY),
    },
    events,
  );
  const got = await walkList(client, always, paced(events));
  assert.deepEqual(events, [`get ${listUrl(null)}`, 'pace', `get ${listUrl(CURSOR_1)}`, 'pace', `get ${listUrl(CURSOR_2)}`]);
  assert.equal(got.outcome, 'whole');
  assert.equal(got.malformed, 0);
  assert.equal(got.answer, null);
  assert.deepEqual(got.entries.map((item) => item.mtid), Array.from({ length: 40 }, (_unused, k) => id(k)));
});

test('a last page that holds entries and no cursor ends the walk whole', async () => {
  const events: string[] = [];
  const client = fakeClient({ [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)), [listUrl(CURSOR_1)]: answer(page(entries(20, 3))) }, events);
  const got = await walkList(client, always, paced(events));
  assert.equal(got.outcome, 'whole');
  assert.equal(got.entries.length, 23);
  assert.equal(events.filter((event) => event.startsWith('get')).length, 2);
});

test('a signed-out answer ends the walk whole with no entries after one request', async () => {
  const events: string[] = [];
  const got = await walkList(fakeClient({ [listUrl(null)]: answer(SIGNED_OUT) }, events), always, paced(events));
  assert.deepEqual(got, { entries: [], outcome: 'whole', malformed: 0, answer: null });
  assert.deepEqual(events, [`get ${listUrl(null)}`]);
});

test('the walk stops at the first entry inWindow rejects, asking it with the update time in epoch ms', async () => {
  const events: string[] = [];
  const asked: number[] = [];
  // Entries 0 to 19 on page 1, 20 to 39 on page 2; the window ends at entry 24.
  const cutoff = (UPDATED_S - 60 * 24) * 1000;
  const inWindow = async (ms: number) => {
    asked.push(ms);
    return ms >= cutoff;
  };
  const client = fakeClient(
    {
      [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)),
      [listUrl(CURSOR_1)]: answer(page(entries(20, 20), CURSOR_2)),
      [listUrl(CURSOR_2)]: answer(page(entries(40, 20))),
    },
    events,
  );
  const got = await walkList(client, inWindow, paced(events));
  assert.equal(got.outcome, 'whole');
  assert.deepEqual(got.entries.map((item) => item.mtid), Array.from({ length: 25 }, (_unused, k) => id(k)));
  // Asked about entries 0 to 25, in order, and nothing after the first no.
  assert.deepEqual(asked, Array.from({ length: 26 }, (_unused, k) => (UPDATED_S - 60 * k) * 1000));
  assert.deepEqual(events, [`get ${listUrl(null)}`, 'pace', `get ${listUrl(CURSOR_1)}`]);
});

test('a first entry outside the window ends the walk whole with nothing, after one request', async () => {
  const events: string[] = [];
  const client = fakeClient({ [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)) }, events);
  const got = await walkList(client, async () => false, paced(events));
  assert.deepEqual(got, { entries: [], outcome: 'whole', malformed: 0, answer: null });
  assert.equal(events.length, 1);
});

test('a list that fails on page 2 returns partial, with page 1 and the answer that ended it', async () => {
  for (const [status, headers] of [[500, {}], [429, { 'retry-after': '60' }], [403, {}], [401, {}]] as const) {
    const events: string[] = [];
    const failing = answer('<html>error</html>', status, headers);
    const client = fakeClient({ [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)), [listUrl(CURSOR_1)]: failing }, events);
    const got = await walkList(client, always, paced(events));
    assert.equal(got.outcome, 'partial', `status ${status}`);
    assert.equal(got.entries.length, 20);
    assert.equal(got.answer, failing);
    assert.equal(events.filter((event) => event.startsWith('get')).length, 2, `status ${status}: no request after the failure`);
  }
});

test('a list that fails on page 1 returns failed with no entries and the answer', async () => {
  const events: string[] = [];
  const failing = answer('', 503);
  const got = await walkList(fakeClient({ [listUrl(null)]: failing }, events), always, paced(events));
  assert.deepEqual(got, { entries: [], outcome: 'failed', malformed: 0, answer: failing });
});

test('a /sorry/ answer on page 1 fails the walk and hands the answer back for the back-off', async () => {
  const events: string[] = [];
  const sorry: Answer = { status: 429, url: 'https://www.google.com/sorry/index?continue=x', headers: {}, text: '<html>' };
  const got = await walkList(fakeClient({ [listUrl(null)]: sorry }, events), always, paced(events));
  assert.equal(got.outcome, 'failed');
  assert.equal(got.answer, sorry);
});

test('a request with no answer fails or cuts the walk, with no answer to hand back', async () => {
  const events: string[] = [];
  let got = await walkList(fakeClient({ [listUrl(null)]: new RequestError('timeout') }, events), always, paced(events));
  assert.deepEqual(got, { entries: [], outcome: 'failed', malformed: 0, answer: null });
  got = await walkList(fakeClient({ [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)), [listUrl(CURSOR_1)]: new RequestError('network') }, events), always, paced(events));
  assert.equal(got.outcome, 'partial');
  assert.equal(got.entries.length, 20);
  assert.equal(got.answer, null);
});

test('a 200 page that does not parse fails the walk on page 1 and cuts it on page 2, handing the answer back', async () => {
  const events: string[] = [];
  const html = answer('<html>a page where the list was expected</html>');
  let got = await walkList(fakeClient({ [listUrl(null)]: html }, events), always, paced(events));
  assert.deepEqual(got, { entries: [], outcome: 'failed', malformed: 0, answer: html });
  got = await walkList(fakeClient({ [listUrl(null)]: answer(page(entries(0, 20), CURSOR_1)), [listUrl(CURSOR_1)]: html }, events), always, paced(events));
  assert.equal(got.outcome, 'partial');
  assert.equal(got.entries.length, 20);
  assert.equal(got.answer, html);
});

test('malformed entries are counted across pages and do not fail the walk', async () => {
  const events: string[] = [];
  const client = fakeClient(
    {
      [listUrl(null)]: answer(page([...entries(0, 2), entry({ 0: [MSTK, 'bad mtid'] })], CURSOR_1)),
      [listUrl(CURSOR_1)]: answer(page([entry({ 22: null }), ...entries(2, 2), entry({ 5: ['x', 0] })])),
    },
    events,
  );
  const got = await walkList(client, always, paced(events));
  assert.equal(got.outcome, 'whole');
  assert.equal(got.malformed, 3);
  assert.deepEqual(got.entries.map((item) => item.mtid), [id(0), id(1), id(2), id(3)]);
});

test('malformed counts only the unreadable entries before the window stop', async () => {
  const events: string[] = [];
  const cutoff = (UPDATED_S - 60 * 1) * 1000;
  const client = fakeClient({ [listUrl(null)]: answer(page([entry({ 22: null }), ...entries(0, 3), entry({ 22: null }), entry({ 22: null })])) }, events);
  const got = await walkList(client, async (ms) => ms >= cutoff, paced(events));
  assert.equal(got.outcome, 'whole');
  assert.deepEqual(got.entries.map((item) => item.mtid), [id(0), id(1)]);
  assert.equal(got.malformed, 1);
});

test('a thread listed again on a later page is kept once, as first seen', async () => {
  const events: string[] = [];
  const client = fakeClient(
    {
      [listUrl(null)]: answer(page(entries(0, 2), CURSOR_1)),
      // A thread updated between the two calls moves up and shifts the list.
      [listUrl(CURSOR_1)]: answer(page([entry({}, { mtid: id(1), updated: UPDATED_S - 60 }), ...entries(2, 1)])),
    },
    events,
  );
  const got = await walkList(client, always, paced(events));
  assert.equal(got.outcome, 'whole');
  assert.deepEqual(got.entries.map((item) => item.mtid), [id(0), id(1), id(2)]);
});

test('a cursor handed out again cuts the walk as partial instead of looping', async () => {
  const events: string[] = [];
  const client = fakeClient({ [listUrl(null)]: answer(page(entries(0, 1), CURSOR_1)), [listUrl(CURSOR_1)]: answer(page(entries(1, 1), CURSOR_1)) }, events);
  const got = await walkList(client, always, paced(events));
  assert.equal(got.outcome, 'partial');
  assert.equal(got.answer, null);
  assert.equal(got.entries.length, 2);
  assert.equal(events.filter((event) => event.startsWith('get')).length, 2);
});

test('a list still paging after the page limit is cut as partial', async () => {
  assert.equal(MAX_PAGES, 1000);
  const events: string[] = [];
  const cursor = (n: number) => `Cursor-${String(n).padStart(25, '0')}`;
  const pages: Record<string, Reply> = { [listUrl(null)]: answer(page(entries(0, 1), cursor(1))) };
  for (let n = 1; n <= 5; n += 1) {
    pages[listUrl(cursor(n))] = answer(page(entries(n, 1), cursor(n + 1)));
  }
  const got = await walkList(fakeClient(pages, events), always, paced(events), { maxPages: 3 });
  assert.equal(got.outcome, 'partial');
  assert.equal(got.answer, null);
  assert.equal(got.entries.length, 3);
  assert.equal(events.filter((event) => event.startsWith('get')).length, 3);
});

test('a pace() or inWindow that rejects rejects the walk', async () => {
  const events: string[] = [];
  const client = fakeClient({ [listUrl(null)]: answer(page(entries(0, 1), CURSOR_1)), [listUrl(CURSOR_1)]: answer(page(entries(1, 1))) }, events);
  await assert.rejects(
    walkList(client, always, async () => {
      throw new Error('pace failed');
    }),
    /pace failed/,
  );
  await assert.rejects(
    walkList(client, async () => {
      throw new Error('window failed');
    }, paced(events)),
    /window failed/,
  );
});
