// The thread list: ListThreads, page by page, newest first. Each entry is
// read into the few fields the spider uses, by form; nothing else of it is
// kept, and an entry that cannot be read is skipped and counted, never
// thrown. The walk makes the requests, calls pace() between them, and says
// how far it got. It logs nothing: an entry holds the thread's title and
// questions.
import { DateString } from '@bric/rex-types/types';

import type { Answer, Client } from './client.mts';
import { classify } from './client.mts';

export const PAGE_SIZE = 20;

// A list still handing out cursors after this many pages is cut, so a server
// that never stops paging cannot hold a pass. 1,000 pages of 20 is 20,000
// threads, far past any account seen.
export const MAX_PAGES = 1000;

// The positions that held small integers on every entry seen. Their meaning
// is not settled, so they are kept as numbers for analysis; the set is fixed.
export const LIST_NUMBER_KEYS = ['3', '11', '13', '17', '18', '23', '25', '26', '27', '30'] as const;

export interface ListEntry {
  // [0][1], the thread's id, which stays the same across follow-ups.
  mtid: string;
  // The mstk pair of [22], which changes each time the thread gets a turn.
  mstk: string;
  // [1], the generated title. Kept in memory only, to be hashed.
  title: string | null;
  // new DateString([5][0]) and new DateString([6][0]) (or [5][0] when [6] is
  // null): seconds only, as the old spider read them, since its upload keys
  // are rebuilt from these.
  created: DateString;
  updated: DateString;
  // Exactly the LIST_NUMBER_KEYS, each an integer from 0 to 999 or null.
  numbers: Record<string, number | null>;
}

export interface ListPage {
  entries: ListEntry[];
  // outer[5], the next page's cursor; null on the last page.
  cursor: string | null;
  malformed: number;
}

export type WalkOutcome = 'whole' | 'partial' | 'failed';

export interface WalkResult {
  // Each thread once, as first seen, newest first.
  entries: ListEntry[];
  // whole: read to the last page, or to the first entry outside the window.
  // failed: the first page could not be read; entries is empty, which is then
  // not an empty account. partial: a later page could not be read, or the
  // walk was cut (a cursor handed out twice, or MAX_PAGES); entries holds the
  // pages before it.
  outcome: WalkOutcome;
  // Entries skipped as unreadable, up to where the walk stopped.
  malformed: number;
  // The answer that ended a walk short of whole, for the pass to classify
  // (rate-limited, challenge and signed-out each call for their own stop).
  // Null for a whole walk, a request that got no answer, and a cut. Its text
  // can hold anything, so it is never logged.
  answer: Answer | null;
}

export interface WalkOptions {
  readonly maxPages?: number;
}

const LIST = 'https://www.google.com/httpservice/web/AimThreadsService/ListThreads';

export function listUrl(cursor: string | null): string {
  return `${LIST}?hl=en&reqpld=${encodeURIComponent(JSON.stringify([null, PAGE_SIZE, 0, null, cursor]))}&msc=gwsclient`;
}

// Google's JSON guard, which every list answer starts with.
const GUARD = ")]}'";

// Id form. mtid was 22 to 23 characters on every entry seen; mstk and the
// cursor 30 and more.
const MTID_FORM = /^[A-Za-z0-9_-]{1,64}$/;
const LONG_ID_FORM = /^[A-Za-z0-9_-]{1,1024}$/;

// A DateString of the seconds, as the old spider made it, or null when the
// value is not a number DateString can hold. Its constructor throws on a
// number past Temporal's range and logs a value it cannot read, so only a
// finite number reaches it.
function seconds(value: unknown): DateString | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  try {
    return new DateString(value);
  } catch {
    return null;
  }
}

// [5] and [6] are [seconds, nanoseconds]; the seconds alone are read.
const timeAt = (position: unknown): DateString | null => (Array.isArray(position) ? seconds(position[0]) : null);

// [22] read as a map: [key, value] pairs whose order varies. Exactly one mstk
// pair, in id form.
function mstkOf(pairs: unknown): string | null {
  if (!Array.isArray(pairs)) {
    return null;
  }
  const values = pairs.filter((pair): pair is unknown[] => Array.isArray(pair) && pair[0] === 'mstk').map((pair) => pair[1]);
  if (values.length !== 1) {
    return null;
  }
  const [value] = values;
  return typeof value === 'string' && LONG_ID_FORM.test(value) ? value : null;
}

const smallInteger = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 ? value : null);

function readEntry(raw: unknown): ListEntry | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const ids: unknown = raw[0];
  const mtid: unknown = Array.isArray(ids) ? ids[1] : undefined;
  if (typeof mtid !== 'string' || !MTID_FORM.test(mtid)) {
    return null;
  }
  const mstk = mstkOf(raw[22]);
  const created = timeAt(raw[5]);
  const updated = raw[6] === null ? timeAt(raw[5]) : timeAt(raw[6]);
  if (mstk === null || created === null || updated === null) {
    return null;
  }
  const numbers: Record<string, number | null> = {};
  for (const key of LIST_NUMBER_KEYS) {
    numbers[key] = smallInteger(raw[Number(key)]);
  }
  const title: unknown = raw[1];
  return { mtid, mstk, title: typeof title === 'string' && title !== '' ? title : null, created, updated, numbers };
}

// outer[5]: absent, null or '' on the last page, else an id-form string.
// Undefined for anything else, which makes the page unreadable rather than
// the last.
function readCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return typeof value === 'string' && LONG_ID_FORM.test(value) ? value : undefined;
}

// Each entry in page order, null where it could not be read, so the walk
// counts only the unreadable entries before it stops.
function readPage(text: string): { items: (ListEntry | null)[]; cursor: string | null } | null {
  if (!text.startsWith(GUARD)) {
    return null;
  }
  let outer: unknown;
  try {
    outer = JSON.parse(text.slice(GUARD.length));
  } catch {
    return null;
  }
  if (!Array.isArray(outer)) {
    return null;
  }
  // A signed-out answer is [] and the last page can be [null, null, 1]: no
  // entries either way.
  const list: unknown = outer[0];
  if (list !== undefined && list !== null && !Array.isArray(list)) {
    return null;
  }
  const cursor = readCursor(outer[5]);
  if (cursor === undefined) {
    return null;
  }
  return { items: Array.isArray(list) ? list.map(readEntry) : [], cursor };
}

// Null when the text is not a list answer: no guard, no JSON after it, or not
// the list's shape.
export function parseListPage(text: string): ListPage | null {
  const page = readPage(text);
  if (page === null) {
    return null;
  }
  const entries = page.items.filter((item): item is ListEntry => item !== null);
  return { entries, cursor: page.cursor, malformed: page.items.length - entries.length };
}

// inWindow is asked about each entry's update time in epoch ms. Every page is
// newest first by [6], so the first entry it rejects ends the walk: every one
// after it is older. A pace() or inWindow that rejects rejects the walk.
export async function walkList(client: Client, inWindow: (ms: number) => Promise<boolean>, pace: () => Promise<void>, { maxPages = MAX_PAGES }: WalkOptions = {}): Promise<WalkResult> {
  const entries: ListEntry[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let malformed = 0;
  let cursor: string | null = null;
  const result = (outcome: WalkOutcome, answer: Answer | null = null): WalkResult => ({ entries, outcome, malformed, answer });
  // A page that could not be read: the first leaves nothing, a later one
  // leaves the pages before it.
  const short = (pages: number, answer: Answer | null) => result(pages === 0 ? 'failed' : 'partial', answer);

  for (let pages = 0; ; pages += 1) {
    if (pages >= maxPages) {
      return result('partial');
    }
    if (pages > 0) {
      await pace();
    }
    let answer: Answer;
    try {
      answer = await client.get(listUrl(cursor));
    } catch {
      // A RequestError carries only its kind, and the walk's outcome says the
      // same.
      return short(pages, null);
    }
    if (classify(answer) !== 'ok') {
      return short(pages, answer);
    }
    const page = readPage(answer.text);
    if (page === null) {
      return short(pages, answer);
    }
    for (const item of page.items) {
      if (item === null) {
        malformed += 1;
        continue;
      }
      if (!(await inWindow(item.updated.timestamp()))) {
        return result('whole');
      }
      // A thread updated between two requests moves to the top and shifts
      // the list down, so it can come again on a later page.
      if (!seen.has(item.mtid)) {
        seen.add(item.mtid);
        entries.push(item);
      }
    }
    if (page.cursor === null) {
      return result('whole');
    }
    if (cursors.has(page.cursor)) {
      return result('partial');
    }
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
}
