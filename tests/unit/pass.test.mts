import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256 } from '@bric/rex-core/common';
import type { DateString } from '@bric/rex-types/types';

import type { BackoffState } from '../../src/backoff.mts';
import { READ_BUDGET } from '../../src/budget.mts';
import { type Answer, RequestError } from '../../src/client.mts';
import { HOME_URL } from '../../src/home.mts';
import { listUrl } from '../../src/list.mts';
import { PASS_LIMITS, type PassFramework, type PassLimits, type PassOutcome, RETRY_LATE_MS, RETRY_SOON_MS, type Records, runPass, windowContains } from '../../src/pass.mts';
import { type AimRecord, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import type { DetailMemo, ModeRecord, Read, Write } from '../../src/store.mts';
import { FOLWR_TEXT_CAP } from '../../src/stream.mts';
import { MARKERS, TITLE, TITLE_HASH, rawEntry } from './fixtures.mts';
import { limitedPage, threadPage, threadStream } from './thread-fixtures.mts';

type Json = Record<string, unknown>;

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
// The pass's clock: 2026-11-20T12:00:00Z.
const NOW = Date.UTC(2026, 10, 20, 12);

// Thread n's ids, in the list's forms: an mtid of 22 characters, an mstk of
// 31, and the garc its thread page carries, so a folwr request names its
// thread.
const mtid = (n: number): string => `MtidThread_${String(n).padStart(11, '0')}`;
const mstk = (n: number): string => `MstkThread-${String(n).padStart(20, '0')}`;
const garcOf = (n: number): string => `GarcForThread${n}`;
const threadOf = (id: string): number => Number(id.slice('MtidThread_'.length));
const cursorOf = (page: number): string => `Cursor-${String(page).padStart(26, '0')}`;

const seconds = (ms: number): number => Math.floor(ms / 1000);
// The upload key's ms for a thread last updated `days` before the pass: the
// list's [6] seconds in ms.
const keyMs = (days: number): number => seconds(NOW - days * DAY) * 1000;

// Thread n, last updated `days` before the pass, as a raw list entry: the
// fixture's 31 positions with their markers, this thread's ids and times.
function thread(n: number, days: number, changes: Record<number, unknown> = {}): unknown[] {
  const updated = seconds(NOW - days * DAY);
  return rawEntry({ 0: [mstk(n), mtid(n)], 5: [updated - 3600, 0], 6: [updated, 0], 22: [['mtid', mtid(n)], ['csuir', '1'], ['mstk', mstk(n)], ['udm', '50']], ...changes });
}

// The key rex-spider builds for thread n in a mode, as 'id ms'.
const keyOf = (n: number, days: number, mode: 'summary' | 'detail'): string => `${mtid(n)}${mode === 'detail' ? '-detail' : ''} ${keyMs(days)}`;
const legacyKeyOf = (n: number, days: number): string => `${mstk(n)}_${mtid(n)} ${keyMs(days)}`;

const ok = (text: string, url = ''): Answer => ({ status: 200, url, headers: {}, text });
const failing = (status: number, headers: Record<string, string> = {}): Answer => ({ status, url: '', headers, text: '<html>SITE-TEXT refused</html>' });
const SORRY_URL = 'https://www.google.com/sorry/index?continue=made-up&q=SITE-TEXT';
const SORRY: Answer = { status: 429, url: SORRY_URL, headers: {}, text: '<html>SITE-TEXT unusual traffic</html>' };
const SIGNED_IN = ok('<html><a href="https://accounts.google.com/SignOutOptions?hl=en">SITE-TEXT account</a></html>');
const SIGNED_OUT = ok('<html><script>"SNlM0e":"made-up"</script><a aria-label="Sign in">SITE-TEXT Sign in</a></html>');
const listBody = (entries: readonly unknown[], cursor: string | null): string => `)]}'\n\n${JSON.stringify(cursor === null ? [entries, null, 1] : [entries, null, 1, null, null, cursor])}`;
const TWO_TURNS = [{}, {}];

type Reply = Answer | ((nth: number) => Answer);

interface SiteOptions {
  readonly home?: Reply;
  // The list, page by page, each its raw entries; every page but the last
  // hands out the next one's cursor.
  readonly pages?: readonly (readonly unknown[])[];
  // A list page answered with this instead, by its index.
  readonly lists?: Readonly<Record<number, Reply>>;
  // A thread's page or folwr answered with this instead, by thread.
  readonly threadPages?: Readonly<Record<number, Reply>>;
  readonly folwrs?: Readonly<Record<number, Reply>>;
}

// A short name for a request: home, list <page>, page <thread>, folwr <thread>.
function label(url: string): string {
  if (url === HOME_URL) return 'home';
  const parsed = new URL(url);
  if (parsed.pathname === '/httpservice/web/AimThreadsService/ListThreads') {
    const cursor = (JSON.parse(parsed.searchParams.get('reqpld') ?? '[]') as unknown[])[4];
    return `list ${cursor === null ? 0 : Number(String(cursor).slice('Cursor-'.length))}`;
  }
  if (parsed.pathname === '/search') return `page ${threadOf(parsed.searchParams.get('mtid') ?? '')}`;
  if (parsed.pathname === '/async/folwr') return `folwr ${Number((parsed.searchParams.get('garc') ?? '').slice('GarcForThread'.length))}`;
  throw new Error('Test setup invalid: a request the site does not know');
}

// www.google.com as the pass reads it: the home page, the list by cursor, and
// each thread's page and folwr, its own unless a test gives another answer. A
// reply given as a function gets the count of requests to that URL so far.
function site(options: SiteOptions = {}) {
  const requests: string[] = [];
  const counts = new Map<string, number>();
  const reply = (given: Reply, name: string): Answer => {
    const nth = (counts.get(name) ?? 0) + 1;
    counts.set(name, nth);
    return typeof given === 'function' ? given(nth) : given;
  };
  const answerTo = (url: string): Answer => {
    requests.push(url);
    const name = label(url);
    const [kind, at] = name.split(' ');
    const index = Number(at);
    if (kind === 'home') return reply(options.home ?? SIGNED_IN, name);
    if (kind === 'list') {
      const pages = options.pages ?? [[]];
      return reply(options.lists?.[index] ?? ok(listBody(pages[index] ?? [], index + 1 < pages.length ? cursorOf(index + 1) : null)), name);
    }
    if (kind === 'page') return reply(options.threadPages?.[index] ?? ok(threadPage({ garc: garcOf(index) })), name);
    return reply(options.folwrs?.[index] ?? ok(threadStream(TWO_TURNS)), name);
  };
  const folwrCount = () => [...counts.entries()].filter(([name]) => name.startsWith('folwr')).reduce((sum, [, count]) => sum + count, 0);
  return { requests, answerTo, folwrCount };
}

const the = <T,>(given: T | (() => T) | undefined, fallback: T): T => (typeof given === 'function' ? (given as () => T)() : given ?? fallback);

interface SideOptions {
  // Upload keys the browser holds, as 'id ms'.
  readonly keys?: readonly string[];
  readonly summarize?: boolean | (() => boolean);
  readonly halt?: boolean | (() => boolean);
  readonly enabled?: boolean | (() => boolean);
  readonly crawlDelay?: unknown;
  readonly windowStart?: number | null;
  readonly windowEnd?: number | null;
  // checkIfAlreadyTransmitted never answers, as while rex-core's database is
  // not open.
  readonly silentLookups?: boolean;
  // logTransmitted answers but keeps nothing.
  readonly unkeptStamps?: boolean;
  readonly silentWindow?: boolean;
  readonly onWindow?: () => void;
}

// rex-spider's side as the pass sees it. Detail mode and halt_on_error
// unless a test says.
function rexSpider(options: SideOptions = {}) {
  const keys = new Set(options.keys ?? []);
  const stamps: string[] = [];
  const lookups: string[] = [];
  const keyOfCall = (id: string, at: DateString) => `${id} ${Math.round(at.timestamp())}`;
  const framework: PassFramework = {
    isEnabled: () => the(options.enabled, true),
    justSummarize: () => the(options.summarize, false),
    continueAfterError: () => !the(options.halt, true),
    fetchCrawlDelay: () => (options.crawlDelay === undefined ? 30_000 : options.crawlDelay) as number,
    crawlWindowStart: () => {
      options.onWindow?.();
      return options.silentWindow === true ? new Promise(() => {}) : Promise.resolve(options.windowStart ?? null);
    },
    crawlWindowEnd: async () => options.windowEnd ?? null,
    checkIfAlreadyTransmitted: (id, at) => {
      lookups.push(keyOfCall(id, at));
      return options.silentLookups === true ? new Promise(() => {}) : Promise.resolve(keys.has(keyOfCall(id, at)));
    },
    logTransmitted: (id, at) => {
      stamps.push(keyOfCall(id, at));
      if (options.unkeptStamps !== true) keys.add(keyOfCall(id, at));
      return Promise.resolve();
    },
  };
  return { framework, keys, stamps, lookups };
}

interface CoreOptions {
  readonly mode?: ModeRecord | null;
  readonly unanswered?: boolean;
  readonly unkept?: boolean;
  readonly onRead?: () => void;
  readonly memos?: Readonly<Record<string, DetailMemo>>;
  readonly memoUnanswered?: readonly string[];
  readonly memoMalformed?: readonly string[];
  readonly memoUnkept?: boolean;
  readonly backoff?: BackoffState | null;
  readonly backoffUnanswered?: boolean;
  // The thread reads' times as stored, and how their store fails: no answer
  // (flagged), a value of another form, a write not kept, a call that never
  // settles, or one that rejects.
  readonly reads?: readonly number[];
  readonly readsUnanswered?: boolean;
  readonly readsMalformed?: boolean;
  readonly readsUnkept?: boolean;
  readonly readsSilent?: 'get' | 'set';
  readonly readsThrow?: 'get' | 'set';
}

// rex-core's store as the pass sees it: the mode record, the memos, the
// back-off and the read times.
function rexCore(options: CoreOptions = {}) {
  const held: { mode: ModeRecord | null; backoff: BackoffState | null; reads: readonly number[] | null } = { mode: options.mode ?? null, backoff: options.backoff ?? null, reads: options.reads ?? null };
  const readsWrites: (readonly number[])[] = [];
  const writes: ModeRecord[] = [];
  const memos = new Map(Object.entries(options.memos ?? {}));
  const memoWrites: [string, DetailMemo][] = [];
  const memoClears: string[] = [];
  const backoffWrites: (BackoffState | null)[] = [];
  const malformed = new Set(options.memoMalformed ?? []);
  return {
    held, writes, memos, memoWrites, memoClears, backoffWrites, readsWrites,
    store: {
      mode: {
        get: async (): Promise<Read<ModeRecord>> => {
          options.onRead?.();
          return { value: options.unanswered === true ? null : held.mode, unanswered: options.unanswered === true, malformed: false };
        },
        set: async (record: ModeRecord): Promise<Write> => {
          writes.push(record);
          if (options.unkept === true) return { ok: false, unanswered: false };
          held.mode = record;
          return { ok: true, unanswered: false };
        },
      },
      memo: {
        get: async (id: string): Promise<Read<DetailMemo>> => {
          if (options.memoUnanswered?.includes(id) === true) return { value: null, unanswered: true, malformed: false };
          if (malformed.has(id)) return { value: null, unanswered: false, malformed: true };
          return { value: memos.get(id) ?? null, unanswered: false, malformed: false };
        },
        set: async (id: string, memo: DetailMemo): Promise<Write> => {
          memoWrites.push([id, memo]);
          if (options.memoUnkept === true) return { ok: false, unanswered: false };
          memos.set(id, memo);
          return { ok: true, unanswered: false };
        },
        clear: async (id: string): Promise<Write> => {
          memoClears.push(id);
          memos.delete(id);
          malformed.delete(id);
          return { ok: true, unanswered: false };
        },
      },
      backoff: {
        get: async (): Promise<Read<BackoffState>> => ({ value: options.backoffUnanswered === true ? null : held.backoff, unanswered: options.backoffUnanswered === true, malformed: false }),
        set: async (state: BackoffState | null): Promise<Write> => {
          backoffWrites.push(state);
          held.backoff = state;
          return { ok: true, unanswered: false };
        },
      },
      reads: {
        get: async (): Promise<Read<readonly number[]>> => {
          if (options.readsSilent === 'get') return new Promise(() => {});
          if (options.readsThrow === 'get') throw new Error('the store broke');
          if (options.readsUnanswered === true) return { value: null, unanswered: true, malformed: false };
          if (options.readsMalformed === true && readsWrites.length === 0) return { value: null, unanswered: false, malformed: true };
          return { value: held.reads, unanswered: false, malformed: false };
        },
        set: async (times: readonly number[]): Promise<Write> => {
          readsWrites.push(times);
          if (options.readsSilent === 'set') return new Promise(() => {});
          if (options.readsThrow === 'set') throw new Error('the store broke');
          if (options.readsUnkept === true) return { ok: false, unanswered: false };
          held.reads = times;
          return { ok: true, unanswered: false };
        },
      },
    },
  };
}

// Thread n's short name in the events: n for its mtid, n-detail for its
// detail key's id.
const short = (id: string): string => (id.endsWith('-detail') ? `${threadOf(id.slice(0, -'-detail'.length))}-detail` : `${threadOf(id)}`);

// Text the site holds that must never reach a record or a log line: the
// list's planted markers, the thread's questions, answers and other text, the
// page's values, and the URLs.
const SITE_TEXT = [...MARKERS, 'SITE-TEXT', 'Made-up question', 'made-up highlight', 'A made-up heading', 'CONTROLS-TEXT', 'ASIDE-TEXT', 'SCRIPT-TEXT', 'TIME-TEXT', 'MstkThread', 'GarcForThread', 'FakeXsrf', 'example.', 'http'];

interface RunOptions {
  readonly core?: ReturnType<typeof rexCore>;
  readonly now?: number;
  readonly limits?: Partial<PassLimits>;
  // How long one thread request (a page or a folwr) takes on the clock, and
  // one home or list request.
  readonly readMs?: number;
  readonly listMs?: number;
  readonly stampMs?: number;
  readonly memoMs?: number;
  readonly slept?: (ms: number) => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly hash?: (text: string) => Promise<string>;
  readonly dispatchThrowsOn?: number;
  readonly records?: Records;
  // A request that throws instead of answering, by its label.
  readonly throwsOn?: Readonly<Record<string, RequestError>>;
}

// One pass with the fakes. The clock starts at now and moves only with the
// waits, the requests and the store calls a test times. Every record is
// checked for the site's text, and every log line for text, ids and URLs.
async function pass(web: ReturnType<typeof site>, side: ReturnType<typeof rexSpider>, options: RunOptions = {}) {
  let clock = options.now ?? NOW;
  const core = options.core ?? rexCore();
  const sent: Json[] = [];
  const raw: AimRecord[] = [];
  const events: string[] = [];
  const trace: string[] = [];
  const note = (event: string) => {
    events.push(event);
    trace.push(event);
  };
  const lines: string[] = [];
  const outcome: PassOutcome = await runPass({
    client: {
      get: async (url: string) => {
        const name = label(url);
        note(`GET ${name}`);
        clock += name === 'home' || name.startsWith('list') ? options.listMs ?? 0 : options.readMs ?? 0;
        const thrown = options.throwsOn?.[name];
        if (thrown !== undefined) {
          web.requests.push(url);
          throw thrown;
        }
        return web.answerTo(url);
      },
    },
    framework: {
      ...side.framework,
      crawlWindowStart: () => {
        trace.push('window');
        return side.framework.crawlWindowStart();
      },
      checkIfAlreadyTransmitted: (id, at) => {
        trace.push(`lookup ${id}`);
        return side.framework.checkIfAlreadyTransmitted(id, at);
      },
      logTransmitted: (id, at) => {
        note(`stamp ${short(id)}`);
        clock += options.stampMs ?? 0;
        return side.framework.logTransmitted(id, at);
      },
    },
    store: {
      mode: {
        get: () => {
          trace.push('mode get');
          return core.store.mode.get();
        },
        set: (record) => {
          trace.push('mode set');
          return core.store.mode.set(record);
        },
      },
      memo: {
        get: (id) => {
          trace.push(`memo get ${short(id)}`);
          clock += options.memoMs ?? 0;
          return core.store.memo.get(id);
        },
        set: (id, memo) => {
          note(`memo ${short(id)}`);
          return core.store.memo.set(id, memo);
        },
        clear: (id) => {
          note(`clear ${short(id)}`);
          return core.store.memo.clear(id);
        },
      },
      backoff: {
        get: () => {
          trace.push('backoff get');
          return core.store.backoff.get();
        },
        set: (state) => {
          trace.push('backoff set');
          return core.store.backoff.set(state);
        },
      },
      reads: {
        get: () => {
          trace.push('reads get');
          return core.store.reads.get();
        },
        set: (times) => {
          trace.push('reads set');
          return core.store.reads.set(times);
        },
      },
    },
    dispatch: (record) => {
      if (options.dispatchThrowsOn !== undefined && record.identifier === mtid(options.dispatchThrowsOn)) throw new Error('the queue is full');
      raw.push(record);
      const text = JSON.stringify(record);
      for (const marker of SITE_TEXT) {
        assert.equal(text.includes(marker), false, `the site's text reached a record: ${marker}`);
      }
      sent.push(JSON.parse(text) as Json);
      note(`dispatch ${short(record.identifier)}`);
    },
    sleep: options.sleep ?? (async (ms) => {
      note(`wait ${ms}`);
      clock += (options.slept ?? ((asked) => asked))(ms);
    }),
    keepAlive: () => {
      trace.push('keep-alive');
    },
    hash: options.hash ?? sha256,
    ...(options.records === undefined ? {} : { records: options.records }),
    limits: { ...PASS_LIMITS, storeMs: 50, hashMs: 50, ...options.limits },
    log: (line) => lines.push(line),
  }, () => clock);
  for (const line of lines) {
    for (const marker of [...SITE_TEXT, 'MtidThread', 'Cursor-', 'google.com']) {
      assert.equal(line.includes(marker), false, `a log line carries text, an id or a URL: ${line}`);
    }
  }
  return { outcome, sent, raw, events, trace, lines, core, clock: () => clock };
}

const withoutMs = (reason: string): string => reason.replace(/ ms=\d+$/, '');
const requestsOf = (events: readonly string[]): string[] => events.filter((event) => event.startsWith('GET ')).map((event) => event.slice('GET '.length));
// The threads whose folwr was requested, in order.
const readsOf = (events: readonly string[]): number[] => events.filter((event) => event.startsWith('GET folwr ')).map((event) => Number(event.slice('GET folwr '.length)));
const kindsOf = (sent: readonly Json[]) => sent.map((record) => [short(String(record.identifier)), record.is_summary]);

// ---- the pass that works ----

test('the summary pass sends one summary per listed thread, newest first, and stamps each with its summary key at the list\'s update time', async () => {
  const pages = [[thread(1, 1), thread(2, 3)]];
  const side = rexSpider({ summarize: true });
  const run = await pass(site({ pages }), side);
  assert.deepEqual(run.events, ['GET home', 'wait 30000', 'GET list 0', 'dispatch 1', 'dispatch 2', 'wait 3000', 'stamp 1', 'stamp 2']);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary'), keyOf(2, 3, 'summary')]);
  for (const record of run.sent) {
    assert.deepEqual([record.name, record.platform, record.format_version, record.is_summary, record.turns], ['rex-conversation', 'google-ai-mode', 1, true, []]);
  }
  assert.deepEqual(run.outcome.ids, [mtid(1), mtid(2)]);
  assert.equal(run.outcome.count, 2);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2');
  const again = await pass(site({ pages }), side);
  assert.deepEqual(again.sent, []);
  assert.deepEqual([again.outcome.count, withoutMs(again.outcome.reason)], [0, 'ok seen=2 dispatched=0']);
});

test('the detail pass reads each thread, its page then its folwr crawl_delay apart, and sends one detail record per due thread, stamped with its -detail key', async () => {
  const pages = [[thread(1, 1), thread(2, 3)]];
  const side = rexSpider();
  const core = rexCore();
  const run = await pass(site({ pages }), side, { core });
  assert.deepEqual(run.events, [
    'GET home', 'wait 30000', 'GET list 0',
    'wait 30000', 'GET page 1', 'wait 30000', 'GET folwr 1', 'dispatch 1',
    'wait 30000', 'stamp 1-detail', 'GET page 2', 'wait 30000', 'GET folwr 2', 'dispatch 2',
    'wait 3000', 'stamp 2-detail',
  ]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail'), keyOf(2, 3, 'detail')]);
  for (const record of run.sent) {
    assert.deepEqual([record.format_version, record.is_summary, record.turns_complete, (record.turns as unknown[]).length, (record.metadata as Json).turn_blocks], [1, false, true, 4, 2]);
  }
  assert.deepEqual(core.writes, [{ mode: 'detail', since: NOW }]);
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [2, [mtid(1), mtid(2)], 'ok seen=2 dispatched=2']);
  const again = await pass(site({ pages }), side, { core });
  assert.deepEqual(readsOf(again.events), []);
  assert.equal(withoutMs(again.outcome.reason), 'ok seen=2 dispatched=0');
});

test('a titled thread\'s records carry the title\'s SHA-256, never null and never the title', async () => {
  const pages = [[thread(1, 1, { 1: TITLE })]];
  assert.match(TITLE_HASH, /^[0-9a-f]{64}$/);
  for (const summarize of [true, false]) {
    const run = await pass(site({ pages }), rexSpider({ summarize }));
    assert.equal(run.sent.length, 1);
    assert.equal((run.sent[0].metadata as Json).title_hash, TITLE_HASH, `summarize ${summarize}`);
  }
});

test('summary records are built in full, their hashes made, before they are dispatched', async () => {
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ summarize: true }));
  assert.equal(run.raw.length, 1);
  assert.equal(typeof (run.raw[0] as unknown as { then?: unknown }).then, 'undefined');
});

test('the list is walked page by page, crawl_delay apart, and a thread on any page is sent', async () => {
  const pages = [[thread(1, 1), thread(2, 2)], [thread(3, 3)], [thread(4, 4)]];
  const run = await pass(site({ pages }), rexSpider({ summarize: true }));
  assert.deepEqual(run.events.slice(0, 7), ['GET home', 'wait 30000', 'GET list 0', 'wait 30000', 'GET list 1', 'wait 30000', 'GET list 2']);
  assert.deepEqual(run.outcome.ids, [1, 2, 3, 4].map(mtid));
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=4');
});

// The calls that go to rex-core: the store's and rex-spider's.
const REX_CORE_CALL = /^(window|lookup |stamp |mode (get|set)|memo |clear |backoff (get|set)|reads (get|set))/;

test('every call to rex-core is made just after a keep-alive call, since store calls do not reset the worker\'s idle timer', async () => {
  const side = rexSpider({ keys: [keyOf(2, 2, 'detail')] });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), side, { core: rexCore({ mode: { mode: 'summary', since: NOW - DAY } }) });
  const calls = run.trace.flatMap((entry, at) => (REX_CORE_CALL.test(entry) ? [[entry, run.trace[at - 1]]] : []));
  assert.ok(calls.length >= 8, `only ${calls.length} rex-core calls were seen`);
  for (const [call, before] of calls) {
    assert.equal(before, 'keep-alive', `${call} came after ${before}`);
  }
});

test('a keep-alive call comes before each summary record is built, since a hash that hangs can hold a record for its deadline', async () => {
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2), thread(3, 3)]] }), rexSpider({ summarize: true }));
  const firstDispatch = run.trace.indexOf('dispatch 1');
  const lastLookup = run.trace.slice(0, firstDispatch).map((entry) => entry.startsWith('lookup ')).lastIndexOf(true);
  assert.deepEqual(run.trace.slice(lastLookup + 1, run.trace.indexOf('wait 3000')), ['keep-alive', 'dispatch 1', 'keep-alive', 'dispatch 2', 'keep-alive', 'dispatch 3']);
});

test('the requests are the four URL forms: the home page, the list, then each thread\'s page and folwr', async () => {
  const web = site({ pages: [[thread(1, 1)]] });
  await pass(web, rexSpider());
  assert.equal(web.requests[0], HOME_URL);
  assert.equal(web.requests[1], listUrl(null));
  assert.equal(web.requests[2], `https://www.google.com/search?udm=50&mstk=${mstk(1)}&mtid=${mtid(1)}&csuir=1&hl=en`);
  assert.ok(web.requests[3].startsWith(`https://www.google.com/async/folwr?async=_fmt%3Aprog%2C_xsrf%3A`));
  assert.equal(web.requests.length, 4);
});

// ---- sign-in and an empty account ----

test('a home page without SignOutOptions ends the pass as not signed in, with no list request, no back-off and count -1', async () => {
  const core = rexCore();
  const web = site({ home: SIGNED_OUT, pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider(), { core });
  assert.deepEqual(requestsOf(run.events), ['home']);
  assert.deepEqual(run.outcome, { count: -1, ids: [], reason: run.outcome.reason });
  assert.equal(withoutMs(run.outcome.reason), 'not-signed-in stage=home');
  assert.deepEqual(core.backoffWrites, []);
});

test('a signed-in home page and an empty list end the pass as none: a whole reading of no threads, count 0', async () => {
  for (const text of [")]}'\n\n[]", listBody([], null), `)]}'\n\n${JSON.stringify([null, null, 1])}`]) {
    const run = await pass(site({ lists: { 0: ok(text) } }), rexSpider());
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0'], text);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [0, [], 'none'], text);
  }
});

test('a list whose only entries cannot be read is not none: the malformed entries are counted', async () => {
  const run = await pass(site({ pages: [[thread(1, 1, { 22: null }), thread(2, 2, { 0: null })]] }), rexSpider({ summarize: true }));
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [0, 'ok seen=0 dispatched=0 malformed=2']);
});

test('malformed entries are skipped and counted in the reason, and the rest are sent', async () => {
  const run = await pass(site({ pages: [[thread(1, 1), thread(9, 2, { 5: ['not a time', 0] })], [thread(2, 3)]] }), rexSpider({ summarize: true }));
  assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', true]]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 malformed=1');
});

test('the home page decides whether the pass goes on: no marker, a 401, another status, a refusal or no answer end it there', async () => {
  const cases: [Reply | RequestError, string][] = [
    [SIGNED_OUT, 'not-signed-in stage=home'],
    [failing(401), 'not-signed-in stage=home status=401'],
    [failing(500), 'http-error stage=home status=500'],
    [failing(404), 'http-error stage=home status=404'],
    [failing(403), 'http-error stage=home status=403'],
    [failing(429, { 'retry-after': '90' }), 'rate-limited stage=home status=429 retry-after=90'],
    [failing(503), 'rate-limited stage=home status=503'],
    [SORRY, 'challenge stage=home status=429'],
    [{ ...SIGNED_IN, url: SORRY_URL }, 'challenge stage=home status=200'],
    [new RequestError('network'), 'network stage=home'],
    [new RequestError('timeout'), 'timeout stage=home'],
  ];
  for (const [home, reason] of cases) {
    const web = site({ pages: [[thread(1, 1)]], ...(home instanceof RequestError ? {} : { home }) });
    const run = await pass(web, rexSpider(), home instanceof RequestError ? { throwsOn: { home } } : {});
    assert.deepEqual(requestsOf(run.events), ['home'], reason);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], reason]);
  }
});

// ---- the crawl window ----

test('with an end set, the walk passes threads newer than the end without stopping and stops at the first older than the start; neither is sent', async () => {
  const pages = [[thread(1, 1), thread(2, 2)], [thread(3, 5), thread(4, 20), thread(5, 21)], [thread(6, 22)]];
  const side = rexSpider({ windowStart: NOW - 10 * DAY, windowEnd: NOW - 3 * DAY });
  const run = await pass(site({ pages }), side);
  // Page 1 is read although every thread on page 0 is newer than the end;
  // page 2 is not, since thread 4 is older than the start.
  assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'list 1', 'page 3', 'folwr 3']);
  assert.deepEqual(kindsOf(run.sent), [['3', false]]);
  assert.deepEqual(run.outcome.ids, [mtid(3)]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1');
});

test('the window\'s bounds are rex-spider\'s: both ends included, null for no bound, and a time that is not a finite number is outside', () => {
  const window = { start: 1000, end: 2000 };
  assert.deepEqual([999, 1000, 1500, 2000, 2001].map((ms) => windowContains(window, ms)), [false, true, true, true, false]);
  assert.equal(windowContains({ start: null, end: null }, 0), true);
  assert.equal(windowContains({ start: null, end: 5 }, -1e15), true);
  assert.equal(windowContains({ start: 5, end: null }, 1e15), true);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(windowContains({ start: null, end: null }, bad), false, String(bad));
  }
});

test('the window is on the update time: a thread created before the start and updated after it is sent', async () => {
  const pages = [[thread(1, 1, { 5: [seconds(NOW - 20 * DAY), 0] }), thread(2, 20)]];
  const run = await pass(site({ pages }), rexSpider({ windowStart: NOW - 10 * DAY }));
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual([run.outcome.ids, withoutMs(run.outcome.reason)], [[mtid(1)], 'ok seen=1 dispatched=1']);
});

test('a thread updated exactly at the window\'s start is inside it: the walk goes on past it and it is sent', async () => {
  const pages = [[thread(1, 5), thread(2, 6)]];
  const run = await pass(site({ pages }), rexSpider({ windowStart: keyMs(5) }));
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual([run.outcome.ids, withoutMs(run.outcome.reason)], [[mtid(1)], 'ok seen=1 dispatched=1']);
});

test('threads are sent newest first by update time even when a page lists them out of order, and ids keep the list\'s order', async () => {
  const pages = [[thread(1, 5), thread(2, 1), thread(3, 3)]];
  const detail = await pass(site({ pages }), rexSpider());
  assert.deepEqual(readsOf(detail.events), [2, 3, 1]);
  assert.deepEqual(detail.outcome.ids, [1, 2, 3].map(mtid));
  const summary = await pass(site({ pages }), rexSpider({ summarize: true }));
  assert.deepEqual(kindsOf(summary.sent).map(([n]) => n), ['2', '3', '1']);
});

test('a crawl window that does not come stops the pass before any request', { timeout: 5000 }, async () => {
  const web = site({ pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider({ silentWindow: true }));
  assert.deepEqual(web.requests, []);
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [-1, 'store']);
});

// ---- the list going wrong ----

test('a first list page that fails ends the pass with its own reason and no reading, after no further request', async () => {
  const cases: [Reply | RequestError, string][] = [
    [failing(429, { 'retry-after': '120' }), 'rate-limited stage=list status=429 retry-after=120'],
    [SORRY, 'challenge stage=list status=429'],
    [failing(401), 'not-signed-in stage=list status=401'],
    [failing(500), 'http-error stage=list status=500'],
    [failing(403), 'http-error stage=list status=403'],
    [ok('<html>SITE-TEXT a page where the list was expected</html>'), 'list-failed cut=unreadable'],
    [new RequestError('network'), 'network stage=list'],
    [new RequestError('timeout'), 'timeout stage=list'],
  ];
  for (const [answer, reason] of cases) {
    const web = site({ pages: [[thread(1, 1)]], ...(answer instanceof RequestError ? {} : { lists: { 0: answer } }) });
    const run = await pass(web, rexSpider(), answer instanceof RequestError ? { throwsOn: { 'list 0': answer } } : {});
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0'], reason);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], reason]);
  }
});

test('a refusal or a sign-out on a later list page ends the pass with nothing sent, since the next request would meet it too', async () => {
  const pages = [[thread(1, 1)], [thread(2, 2)]];
  const cases: [Answer, string][] = [
    [failing(429), 'rate-limited stage=list status=429'],
    [SORRY, 'challenge stage=list status=429'],
    [failing(401), 'not-signed-in stage=list status=401'],
    // A signed-out session answers the list with [] and a 200.
    [ok(")]}'\n\n[]"), 'not-signed-in stage=list'],
    [ok(listBody([], null)), 'not-signed-in stage=list'],
  ];
  for (const [answer, reason] of cases) {
    const run = await pass(site({ pages, lists: { 1: answer } }), rexSpider({ summarize: true }));
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'list 1'], reason);
    assert.deepEqual(run.sent, [], reason);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], reason]);
  }
});

test('a list read in part is no reading of the account: count -1 and no ids, while what was read goes out and the reason says why the list was cut', async () => {
  const pages = [[thread(1, 1), thread(2, 2)], [thread(3, 3)]];
  const cases: [Answer | RequestError, string][] = [
    [failing(500), 'http-error'],
    [failing(404), 'http-error'],
    [ok('<html>SITE-TEXT</html>'), 'unreadable'],
    [new RequestError('network'), 'network'],
    [new RequestError('timeout'), 'timeout'],
  ];
  for (const [answer, cut] of cases) {
    const web = site({ pages, ...(answer instanceof RequestError ? {} : { lists: { 1: answer } }) });
    const run = await pass(web, rexSpider({ summarize: true }), answer instanceof RequestError ? { throwsOn: { 'list 1': answer } } : {});
    assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', true]], cut);
    assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], `partial seen=2 dispatched=2 cut=${cut}`]);
  }
});

test('a list cut by a cursor handed out twice is read in part too', async () => {
  const web = site({ pages: [[thread(1, 1)], [thread(2, 2)]], lists: { 1: ok(listBody([thread(2, 2)], cursorOf(1))) } });
  const run = await pass(web, rexSpider({ summarize: true }));
  assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'list 1']);
  assert.equal(withoutMs(run.outcome.reason), 'partial seen=2 dispatched=2 cut=repeated-cursor');
});

test('a list still handing out cursors after 100 pages is read in part, cut at the page limit', async () => {
  const pages = Array.from({ length: 101 }, (_, k) => [thread(k + 1, k + 1)]);
  const run = await pass(site({ pages }), rexSpider({ summarize: true }));
  assert.equal(requestsOf(run.events).filter((name) => name.startsWith('list')).length, 100);
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'partial seen=100 dispatched=100 cut=page-limit']);
});

test('a list read in part that gives no thread in the crawl window is list-failed, never an empty reading', async () => {
  const web = site({ pages: [[thread(1, 1)], [thread(2, 2)]], lists: { 1: failing(500) } });
  const run = await pass(web, rexSpider({ summarize: true, windowEnd: NOW - 30 * DAY }));
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'list-failed cut=http-error']);
});

test('a list read whole with no thread in the crawl window is an empty reading: count 0', async () => {
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ summarize: true, windowEnd: NOW - 30 * DAY }));
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [0, [], 'ok seen=0 dispatched=0']);
});

// ---- modes and the re-send ----

test('a switch from summary to detail re-sends in detail only the threads last used in the 90 days before it', async () => {
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary'), keyOf(2, 100, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY } });
  const run = await pass(site({ pages: [[thread(3, 5), thread(1, 10), thread(2, 100)]] }), side, { core });
  assert.deepEqual(readsOf(run.events), [3, 1]);
  assert.deepEqual(side.stamps, [keyOf(3, 5, 'detail'), keyOf(1, 10, 'detail')]);
  assert.deepEqual(core.writes, [{ mode: 'detail', since: NOW }]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=2');
});

test('a switch from detail to summary re-sends as summaries only the threads last used in the 90 days before it', async () => {
  const side = rexSpider({ summarize: true, keys: [keyOf(1, 10, 'detail'), keyOf(2, 100, 'detail')] });
  const core = rexCore({ mode: { mode: 'detail', since: NOW - 200 * DAY } });
  const run = await pass(site({ pages: [[thread(3, 5), thread(1, 10), thread(2, 100)]] }), side, { core });
  assert.deepEqual(kindsOf(run.sent), [['3', true], ['1', true]]);
  assert.deepEqual(side.stamps, [keyOf(3, 5, 'summary'), keyOf(1, 10, 'summary')]);
  assert.deepEqual(core.writes, [{ mode: 'summary', since: NOW }]);
});

test('the update re-sends once the threads the old spider sent in the 90 days before it, and not older ones, in either mode', async () => {
  for (const summarize of [false, true]) {
    // A browser updated from the old spider: no mode record, legacy keys.
    const side = rexSpider({ summarize, keys: [legacyKeyOf(1, 10), legacyKeyOf(2, 100)] });
    const run = await pass(site({ pages: [[thread(3, 5), thread(1, 10), thread(2, 100)]] }), side);
    assert.deepEqual(kindsOf(run.sent), [['3', summarize], ['1', summarize]], `summarize ${summarize}`);
    assert.ok(side.lookups.includes(legacyKeyOf(1, 10)), 'the legacy key was not looked up');
  }
});

test('a store that does not answer the mode record holds back the threads sent only in the other mode, and sends the rest', async () => {
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY }, unanswered: true });
  const run = await pass(site({ pages: [[thread(3, 5), thread(1, 10)]] }), side, { core });
  assert.deepEqual(readsOf(run.events), [3]);
  assert.deepEqual(core.writes, []);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 held=1');
});

test('a mode record that cannot be written holds them back too', async () => {
  const side = rexSpider({ keys: [keyOf(1, 10, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY }, unkept: true });
  const run = await pass(site({ pages: [[thread(3, 5), thread(1, 10)]] }), side, { core });
  assert.deepEqual(readsOf(run.events), [3]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 held=1');
});

// ---- the store ----

test('a key lookup that never answers stops the sending with nothing sent: its deadline rejects, and never reads as not sent', { timeout: 5000 }, async () => {
  const side = rexSpider({ silentLookups: true });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 3)]] }), side);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(readsOf(run.events), []);
  assert.equal(side.lookups.length, 1);
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [0, 'ok seen=2 dispatched=0 stop=store']);
});

test('a summary stamp that is not kept stops the sending for the pass, and the records with no key count as left: they go out again', async () => {
  const side = rexSpider({ summarize: true, unkeptStamps: true });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 3)]] }), side);
  assert.equal(run.sent.length, 2);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 left=2 stop=store');
});

test('a detail stamp that is not kept stops the reads before the next one, and its thread counts as left with the one not read', async () => {
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 3)]] }), rexSpider({ unkeptStamps: true }));
  assert.deepEqual(readsOf(run.events), [1]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 left=2 stop=store');
});

test('the last detail record\'s key, written after the reads, counts it as left when it is not kept', async () => {
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ unkeptStamps: true }));
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1 left=1 stop=store');
});

// ---- the detail budget and pacing ----

test('the detail budget is 360 s of reading', () => {
  assert.equal(PASS_LIMITS.detailBudgetMs, 360_000);
});

// The tests run with 50 ms store and hash deadlines, so the defaults are
// pinned here: a store deadline past the worker's 30 s idle limit, or a
// hash one past a few seconds, would outlast the worker.
test('the pass\'s limits are the ChatGPT crawler\'s, and the memo lengths a day and a week', () => {
  assert.deepEqual(PASS_LIMITS, { settleMs: 3000, batch: 25, storeMs: 20_000, hashMs: 1000, detailBudgetMs: 360_000, failedRun: 3, readBudget: READ_BUDGET });
  assert.deepEqual([RETRY_SOON_MS, RETRY_LATE_MS], [DAY, 7 * DAY]);
});

test('reads that spend exactly the budget stop before the next thread: at 90 s a thread, four are read', async () => {
  const pages = [[1, 2, 3, 4, 5, 6].map((n) => thread(n, n))];
  const run = await pass(site({ pages }), rexSpider(), { readMs: 45_000 });
  assert.deepEqual(readsOf(run.events), [1, 2, 3, 4]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=4 left=2 stop=budget');
});

test('the detail budget counts the reading: at 100 s a thread (two 50 s requests), the reads stop after four and the rest wait for a later pass', async () => {
  const pages = [[1, 2, 3, 4, 5, 6].map((n) => thread(n, n))];
  const side = rexSpider();
  const run = await pass(site({ pages }), side, { readMs: 50_000 });
  assert.deepEqual(readsOf(run.events), [1, 2, 3, 4]);
  assert.deepEqual(side.stamps, [1, 2, 3, 4].map((n) => keyOf(n, n, 'detail')));
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=4 left=2 stop=budget');
});

test('the budget starts at the first read: a list walk that takes longer than the budget does not starve the reads', async () => {
  const pages = [[thread(1, 1)], [thread(2, 2)], [thread(3, 3)]];
  // Four requests before the reads (the home page and three list pages) at 200 s each.
  const run = await pass(site({ pages }), rexSpider(), { listMs: 200_000 });
  assert.deepEqual(readsOf(run.events), [1, 2, 3]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=3');
});

test('store calls during the reads count against the budget: at 100 s a stamp, the reads stop after five', async () => {
  const pages = [[1, 2, 3, 4, 5, 6].map((n) => thread(n, n))];
  const run = await pass(site({ pages }), rexSpider(), { stampMs: 100_000 });
  assert.deepEqual(readsOf(run.events), [1, 2, 3, 4, 5]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=5 left=1 stop=budget');
});

test('memo reads during the reads count against the budget: at 100 s a memo read, the reads stop after three', async () => {
  const pages = [[1, 2, 3, 4, 5, 6].map((n) => thread(n, n))];
  const run = await pass(site({ pages }), rexSpider({ halt: false }), { memoMs: 100_000 });
  assert.deepEqual(readsOf(run.events), [1, 2, 3]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=6 dispatched=3 left=3 stop=budget');
});

test('the paced waits do not count against the budget: twenty threads read 30 s apart all go out', async () => {
  const pages = [Array.from({ length: 20 }, (_, k) => thread(k + 1, k + 1))];
  // A read budget of more than twenty, so only the reading time can stop it.
  const run = await pass(site({ pages }), rexSpider(), { limits: { readBudget: { reads: 21, windowMs: READ_BUDGET.windowMs } } });
  assert.equal(readsOf(run.events).length, 20);
  assert.ok(run.clock() - NOW > 1_200_000, 'the waits took less than two budgets');
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=20 dispatched=20');
});

test('nor does a wait that runs longer than it asked: it is measured on the clock', async () => {
  const pages = [[1, 2, 3, 4, 5, 6].map((n) => thread(n, n))];
  const run = await pass(site({ pages }), rexSpider(), { readMs: 25_000, slept: (ms) => ms + 50_000 });
  assert.equal(readsOf(run.events).length, 6);
});

test('a crawl_delay of 0 still keeps the settle wait between threads, and one that cannot be read is 30 s', async () => {
  const fast = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), rexSpider({ crawlDelay: 0 }));
  // After the home page, before each thread, between each thread's two
  // requests, and the settle before the last stamp.
  assert.deepEqual(fast.events.filter((event) => event.startsWith('wait')), ['wait 0', 'wait 3000', 'wait 0', 'wait 3000', 'wait 0', 'wait 3000']);
  const broken = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ crawlDelay: 'soon' }));
  assert.deepEqual(broken.events.filter((event) => event.startsWith('wait')), ['wait 30000', 'wait 30000', 'wait 30000', 'wait 3000']);
});

// ---- flags served during the pass ----

test('summarize served during the detail reads ends them; the threads read keep their detail keys, and the next pass sends in summary', async () => {
  const pages = [[1, 2, 3, 4].map((n) => thread(n, n))];
  const web = site({ pages });
  let summarize = false;
  const side = rexSpider({ summarize: () => summarize || web.folwrCount() >= 2 });
  const core = rexCore();
  const run = await pass(web, side, { core });
  assert.deepEqual(readsOf(run.events), [1, 2]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail'), keyOf(2, 2, 'detail')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=2 left=2 stop=mode');
  summarize = true;
  const next = await pass(site({ pages }), side, { core });
  assert.deepEqual(readsOf(next.events), []);
  assert.deepEqual(kindsOf(next.sent), [1, 2, 3, 4].map((n) => [`${n}`, true]));
});

test('detail served during a summary pass ends it too, and what went out is stamped', async () => {
  let asked = 0;
  // Read once when the pass starts and once before each thread.
  const side = rexSpider({ summarize: () => (asked += 1) <= 2 });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2), thread(3, 3)]] }), side);
  assert.deepEqual(kindsOf(run.sent), [['1', true]]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=1 left=2 stop=mode');
});

test('enabled false served during the reads stops them before the next request, between a thread\'s two requests too', async () => {
  const pages = [[1, 2, 3].map((n) => thread(n, n))];
  const before = site({ pages });
  const side = rexSpider({ enabled: () => before.folwrCount() < 2 });
  const run = await pass(before, side);
  assert.deepEqual(readsOf(run.events), [1, 2]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=2 left=1 stop=disabled');
  // Switched off after thread 1's page: its folwr is not requested, and it gets nothing.
  const between = site({ pages });
  const core = rexCore();
  const cut = await pass(between, rexSpider({ enabled: () => !between.requests.some((url) => label(url) === 'page 1') }), { core });
  assert.deepEqual(requestsOf(cut.events), ['home', 'list 0', 'page 1']);
  assert.deepEqual([cut.sent, core.memoWrites], [[], []]);
  assert.equal(withoutMs(cut.outcome.reason), 'ok seen=3 dispatched=0 left=3 stop=disabled');
});

test('a switch-off served while the mode record is read stops the pass before any request', async () => {
  let enabled = true;
  const web = site({ pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider({ enabled: () => enabled }), { core: rexCore({ onRead: () => { enabled = false; } }) });
  assert.deepEqual(web.requests, []);
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'disabled stage=start']);
});

test('a switch-off served while the crawl window is looked up stops the pass before the home page', async () => {
  let enabled = true;
  const web = site({ pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider({ enabled: () => enabled, onWindow: () => { enabled = false; } }));
  assert.deepEqual(web.requests, []);
  assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [-1, 'disabled stage=start']);
});

test('a switch-off served during the list walk stops it before its next request, with no reading of the list', async () => {
  const web = site({ pages: [[thread(1, 1)], [thread(2, 2)], [thread(3, 3)]] });
  const run = await pass(web, rexSpider({ enabled: () => web.requests.length < 2 }));
  assert.deepEqual(requestsOf(run.events), ['home', 'list 0']);
  assert.deepEqual([run.outcome.count, run.outcome.ids, withoutMs(run.outcome.reason)], [-1, [], 'disabled stage=list']);
});

test('a switch-off before the pass starts sends no request and reads no store', async () => {
  const web = site({ pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider({ enabled: false }), { core: rexCore({ backoff: { until: NOW + MINUTE, failures: 1, code: 'rate-limited' } }) });
  assert.deepEqual(web.requests, []);
  assert.equal(run.trace.includes('backoff get'), false);
  assert.equal(withoutMs(run.outcome.reason), 'disabled stage=start');
});

// ---- what cannot go wrong quietly ----

test('a hash that never answers gives null hashes, and the records still go out', { timeout: 5000 }, async () => {
  const stuck = () => new Promise<string>(() => {});
  const summary = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ summarize: true }), { hash: stuck });
  assert.equal((summary.sent[0].metadata as Json).title_hash, null);
  const read = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { hash: stuck });
  assert.deepEqual([(read.sent[0].metadata as Json).title_hash, read.sent[0].is_summary], [null, false]);
});

// A detail builder that throws on one thread (no input is known to make the
// real one throw; this stands in for a fault in a later build).
const throwsOn = (n: number): Records => ({
  summary: buildSummaryRecord,
  detail: (entry, titleHash, parsed, caps) => {
    if (entry.mtid === mtid(n)) throw new TypeError('the builder broke');
    return buildDetailRecord(entry, titleHash, parsed, caps);
  },
});

test('a record builder that throws on a thread is a read that cannot be used: its summary and a 7-day memo, and the next thread is read', async () => {
  const core = rexCore();
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), rexSpider({ halt: false }), { core, records: throwsOn(1) });
  assert.deepEqual(readsOf(run.events), [1, 2]);
  assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', false]]);
  assert.deepEqual(core.memoWrites.map(([id, memo]) => [short(id), memo.retryMs, memo.failures]), [['1', 7 * DAY, 1]]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 failed=1');
});

test('a wait that rejects ends the pass with a reason, and runPass does not throw', async () => {
  let calls = 0;
  let throwAt = 0;
  const broken = async () => {
    calls += 1;
    if (calls === throwAt) throw new TypeError('timer broke');
  };
  // The second wait is the walk's first.
  throwAt = 2;
  const walk = await pass(site({ pages: [[thread(1, 1)], [thread(2, 2)]] }), rexSpider(), { sleep: broken });
  assert.deepEqual([walk.outcome.count, withoutMs(walk.outcome.reason)], [-1, 'internal stage=list']);
  // The fourth is the one before the second thread: the first record still gets its key.
  calls = 0;
  throwAt = 4;
  const side = rexSpider();
  const reads = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), side, { sleep: broken });
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail')]);
  assert.equal(withoutMs(reads.outcome.reason), 'ok seen=2 dispatched=1 left=1 stop=internal');
});

test('a dispatch that throws stops the sending, and its thread gets no key', async () => {
  const side = rexSpider({ summarize: true });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), side, { dispatchThrowsOn: 2 });
  assert.deepEqual(kindsOf(run.sent), [['1', true]]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'summary')]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 left=1 stop=internal');
});

// ---- the failure policy ----
//
// The arms serve halt_on_error false, so these do too unless a test is about
// it.

const SOON = DAY;
const LATE = 7 * DAY;

test('a 429 with Retry-After: 120 on a thread stops the pass, stores a back-off of at least 120 s, and sends nothing for that thread', async () => {
  const pages = [[thread(1, 1), thread(2, 2), thread(3, 3)]];
  const side = rexSpider({ halt: false });
  const core = rexCore();
  const run = await pass(site({ pages, threadPages: { 2: failing(429, { 'retry-after': '120' }) } }), side, { core });
  assert.deepEqual(requestsOf(run.events).slice(2), ['page 1', 'folwr 1', 'page 2']);
  assert.deepEqual(kindsOf(run.sent), [['1', false]]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail')]);
  assert.deepEqual(core.memoWrites, []);
  assert.equal(core.backoffWrites.length, 1);
  const stored = core.backoffWrites[0] as BackoffState;
  assert.deepEqual([stored.code, stored.failures], ['rate-limited', 1]);
  assert.ok(stored.until - run.clock() >= 120_000);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=1 left=2 stop=rate-limited');
  // A minute later the pass is skipped with no request.
  const skipped = site({ pages });
  const next = await pass(skipped, side, { core, now: run.clock() + MINUTE });
  assert.deepEqual(skipped.requests, []);
  assert.deepEqual(next.outcome, { count: -1, ids: [], reason: `backoff until=${new Date(stored.until).toISOString()} code=rate-limited` });
  // Once it has run out, the thread is read, and the clean pass clears the back-off.
  const after = await pass(site({ pages }), side, { core, now: stored.until });
  assert.deepEqual(readsOf(after.events), [2, 3]);
  assert.deepEqual(core.backoffWrites, [stored, null]);
});

test('a Retry-After longer than the schedule sets the wait', async () => {
  const core = rexCore();
  const run = await pass(site({ pages: [[thread(1, 1)]], folwrs: { 1: failing(429, { 'retry-after': '3600' }) } }), rexSpider({ halt: false }), { core });
  assert.equal((core.held.backoff as BackoffState).until - run.clock(), 60 * MINUTE);
});

test('a 503, a Retry-After on any status, and Google\'s /sorry/ page stop the pass the same way, on either of a thread\'s requests', async () => {
  const cases: [string, Answer, string][] = [
    ['a 503', failing(503), 'rate-limited'],
    ['a 403 with Retry-After', failing(403, { 'retry-after': '30' }), 'rate-limited'],
    ['the /sorry/ page with a 429', SORRY, 'challenge'],
    ['the /sorry/ page with a 200', { ...ok(threadPage({ garc: garcOf(1) })), url: SORRY_URL }, 'challenge'],
  ];
  for (const [name, refusal, code] of cases) {
    for (const where of ['page', 'folwr'] as const) {
      const core = rexCore();
      const web = site({ pages: [[thread(1, 1), thread(2, 2)]], ...(where === 'page' ? { threadPages: { 1: refusal } } : { folwrs: { 1: refusal } }) });
      const run = await pass(web, rexSpider({ halt: false }), { core });
      assert.deepEqual(requestsOf(run.events).slice(2), where === 'page' ? ['page 1'] : ['page 1', 'folwr 1'], `${name} on the ${where}`);
      assert.deepEqual([run.sent, core.memoWrites], [[], []], `${name} on the ${where}`);
      assert.deepEqual(core.backoffWrites.map((state) => [state?.code, state?.failures]), [[code, 1]], `${name} on the ${where}`);
      assert.equal(withoutMs(run.outcome.reason), `ok seen=2 dispatched=0 left=2 stop=${code}`, `${name} on the ${where}`);
    }
  }
});

test('a refusal at the home page or a list sets the back-off too, and each refusal in a row doubles the wait', async () => {
  const core = rexCore();
  const side = rexSpider();
  const first = await pass(site({ home: failing(429) }), side, { core });
  assert.equal(withoutMs(first.outcome.reason), 'rate-limited stage=home status=429');
  assert.equal((core.held.backoff as BackoffState).until - first.clock(), 5 * MINUTE);
  const second = await pass(site({ lists: { 0: failing(429, { 'retry-after': '60' }) } }), side, { core, now: (core.held.backoff as BackoffState).until });
  assert.equal(withoutMs(second.outcome.reason), 'rate-limited stage=list status=429 retry-after=60');
  assert.deepEqual([(core.held.backoff as BackoffState).failures, (core.held.backoff as BackoffState).until - second.clock()], [2, 10 * MINUTE]);
  const third = await pass(site({ home: SORRY }), side, { core, now: (core.held.backoff as BackoffState).until });
  assert.equal(withoutMs(third.outcome.reason), 'challenge stage=home status=429');
  assert.deepEqual([(core.held.backoff as BackoffState).code, (core.held.backoff as BackoffState).failures], ['challenge', 3]);
});

test('a 401 on either of a thread\'s requests ends the pass as not signed in, with no back-off, no summary and no memo', async () => {
  for (const where of ['page', 'folwr'] as const) {
    const core = rexCore();
    const web = site({ pages: [[thread(1, 1), thread(2, 2)]], ...(where === 'page' ? { threadPages: { 1: failing(401) } } : { folwrs: { 1: failing(401) } }) });
    const run = await pass(web, rexSpider({ halt: false }), { core });
    assert.deepEqual([run.sent, core.memoWrites, core.backoffWrites], [[], [], []], where);
    assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [0, 'ok seen=2 dispatched=0 left=2 stop=not-signed-in'], where);
  }
});

test('a 401 or no marker at the home page, and a 401 on a list, set no back-off either', async () => {
  for (const options of [{ home: failing(401) }, { home: SIGNED_OUT }, { pages: [[thread(1, 1)]], lists: { 0: failing(401) } }] as SiteOptions[]) {
    const core = rexCore();
    await pass(site(options), rexSpider(), { core });
    assert.deepEqual(core.backoffWrites, []);
  }
});

test('a read that fails as a layout change checks the home page once more; without SignOutOptions the pass ends as not signed in, and the thread gets nothing', async () => {
  const core = rexCore();
  const web = site({ pages: [[thread(1, 1), thread(2, 2)]], home: (nth) => (nth === 1 ? SIGNED_IN : SIGNED_OUT), threadPages: { 1: ok(threadPage({ garc: null })) } });
  const run = await pass(web, rexSpider({ halt: false }), { core });
  assert.deepEqual(run.events.slice(3), ['wait 30000', 'GET page 1', 'wait 30000', 'GET home']);
  assert.deepEqual([run.sent, core.memoWrites, core.backoffWrites], [[], [], []]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=not-signed-in');
});

test('when the home page still holds SignOutOptions, the layout failure counts: the summary goes out in its place with a 1-day memo, and the next thread is read', async () => {
  const core = rexCore();
  const web = site({ pages: [[thread(1, 1), thread(2, 2)]], threadPages: { 1: ok(threadPage({ mlros: null })) } });
  const run = await pass(web, rexSpider({ halt: false }), { core });
  assert.deepEqual(run.events.slice(3), [
    'wait 30000', 'GET page 1', 'wait 30000', 'GET home', 'dispatch 1',
    'wait 30000', 'memo 1', 'GET page 2', 'wait 30000', 'GET folwr 2', 'dispatch 2',
    'wait 3000', 'stamp 2-detail',
  ]);
  assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', false]]);
  assert.deepEqual(core.memoWrites.map(([id, memo]) => [short(id), memo.retryMs, memo.failures]), [['1', SOON, 1]]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 failed=1');
});

test('a home check that is refused stops the pass with a back-off, and one that gets a 401 ends it as not signed in', async () => {
  const layout = ok(threadPage({ ei: null }));
  const refused = rexCore();
  const limited = await pass(site({ pages: [[thread(1, 1)]], home: (nth) => (nth === 1 ? SIGNED_IN : SORRY), threadPages: { 1: layout } }), rexSpider({ halt: false }), { core: refused });
  assert.deepEqual([limited.sent, refused.memoWrites], [[], []]);
  assert.deepEqual(refused.backoffWrites.map((state) => state?.code), ['challenge']);
  assert.equal(withoutMs(limited.outcome.reason), 'ok seen=1 dispatched=0 left=1 stop=challenge');
  const out = await pass(site({ pages: [[thread(1, 1)]], home: (nth) => (nth === 1 ? SIGNED_IN : failing(401)), threadPages: { 1: layout } }), rexSpider({ halt: false }));
  assert.equal(withoutMs(out.outcome.reason), 'ok seen=1 dispatched=0 left=1 stop=not-signed-in');
});

test('a home check that cannot tell (a 500, no answer) lets the layout failure count', async () => {
  const homes: Reply[] = [
    (nth) => (nth === 1 ? SIGNED_IN : failing(500)),
    (nth) => {
      if (nth === 1) return SIGNED_IN;
      throw new RequestError('network');
    },
  ];
  for (const home of homes) {
    const core = rexCore();
    const run = await pass(site({ home, pages: [[thread(1, 1)]], threadPages: { 1: ok(threadPage({ xsrf: null })) } }), rexSpider({ halt: false }), { core });
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'page 1', 'home']);
    assert.deepEqual(kindsOf(run.sent), [['1', true]]);
    assert.deepEqual(core.memoWrites.map(([id, memo]) => [short(id), memo.retryMs]), [['1', SOON]]);
    assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1 failed=1');
  }
});

test('a read that fails sends the summary in its place, with a memo of 1 day for a failure that may pass and 7 days otherwise', async () => {
  const cases: [string, SiteOptions, Readonly<Record<string, RequestError>>, number][] = [
    ['a 500 on the page', { threadPages: { 1: failing(500) } }, {}, SOON],
    ['a 500 on folwr', { folwrs: { 1: failing(500) } }, {}, SOON],
    ['a redirect that was not followed', { threadPages: { 1: failing(302) } }, {}, SOON],
    ['no answer to the page', {}, { 'page 1': new RequestError('network') }, SOON],
    ['no answer to folwr in time', {}, { 'folwr 1': new RequestError('timeout') }, SOON],
    ['a page without the values, signed in', { threadPages: { 1: ok(threadPage({ garc: null })) } }, {}, SOON],
    ['a folwr body that is not the stream', { folwrs: { 1: ok('<html>SITE-TEXT</html>') } }, {}, SOON],
    ['a folwr body with a chunk length past its end', { folwrs: { 1: ok(")]}'\nff;short") } }, {}, SOON],
    ['a folwr body over the cap', { folwrs: { 1: ok(`)]}'\n${'x'.repeat(FOLWR_TEXT_CAP)}`) } }, {}, LATE],
    ['a 403 on the page', { threadPages: { 1: failing(403) } }, {}, LATE],
    ['a 404 on folwr', { folwrs: { 1: failing(404) } }, {}, LATE],
  ];
  for (const [what, options, throws, retryMs] of cases) {
    const side = rexSpider({ halt: false });
    const core = rexCore();
    const run = await pass(site({ pages: [[thread(1, 1)]], ...options }), side, { core, throwsOn: throws });
    assert.deepEqual(kindsOf(run.sent), [['1', true]], what);
    // The summary in the detail's place gets no key, so the thread's detail is read again when its memo runs out.
    assert.deepEqual(side.stamps, [], what);
    assert.deepEqual(core.memoWrites.map(([id, memo]) => [short(id), memo.ended, memo.retryMs, memo.failures]), [['1', keyMs(1), retryMs, 1]], what);
    assert.deepEqual(core.backoffWrites, [], what);
    assert.deepEqual([run.outcome.count, withoutMs(run.outcome.reason)], [1, 'ok seen=1 dispatched=1 failed=1'], what);
  }
});

test('the summary does not go out in a failed read\'s place when one went out at that time, and the memo is still written', async () => {
  // Sent as a summary 10 days ago, before the switch to detail, so re-sent in detail; the read fails.
  const side = rexSpider({ halt: false, keys: [keyOf(1, 10, 'summary')] });
  const core = rexCore({ mode: { mode: 'summary', since: NOW - 200 * DAY } });
  const run = await pass(site({ pages: [[thread(1, 10)]], folwrs: { 1: failing(500) } }), side, { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(run.sent, []);
  assert.deepEqual(core.memoWrites.map(([id]) => short(id)), ['1']);
});

test('a memo holds its thread back until its retry time; a failure then sends no second summary and waits 7 days', async () => {
  // crawl_delay 0, so the memos are read at the pass's starting time.
  const side = rexSpider({ halt: false, crawlDelay: 0 });
  const core = rexCore();
  const options = { pages: [[thread(1, 1)]], folwrs: { 1: failing(500) } };
  await pass(site(options), side, { core });
  const memo = core.memos.get(mtid(1)) as DetailMemo;
  assert.equal(memo.retryMs, SOON);
  const held = await pass(site(options), side, { core, now: memo.at + memo.retryMs - 1 });
  assert.deepEqual(requestsOf(held.events), ['home', 'list 0']);
  assert.equal(withoutMs(held.outcome.reason), 'ok seen=1 dispatched=0 held=1');
  const again = await pass(site(options), side, { core, now: memo.at + memo.retryMs });
  assert.deepEqual(readsOf(again.events), [1]);
  assert.deepEqual(again.sent, []);
  const repeat = core.memos.get(mtid(1)) as DetailMemo;
  assert.deepEqual([repeat.failures, repeat.retryMs], [2, LATE]);
});

test('a thread used since its memo was written is read at once, and a read that works clears the memo', async () => {
  const core = rexCore({ memos: { [mtid(1)]: { ended: keyMs(2), at: NOW - 1000, retryMs: LATE, failures: 1 } } });
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ halt: false }), { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(core.memoClears.map(short), ['1']);
  assert.deepEqual(kindsOf(run.sent), [['1', false]]);
});

test('a memo written under a clock that ran fast is not trusted, and one of the wrong form is cleared by a read that works', async () => {
  const fast = rexCore({ memos: { [mtid(1)]: { ended: keyMs(1), at: NOW + 2 * DAY, retryMs: LATE, failures: 1 } } });
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ halt: false }), { core: fast });
  assert.deepEqual(readsOf(run.events), [1]);
  const odd = rexCore({ memoMalformed: [mtid(1)] });
  await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ halt: false }), { core: odd });
  assert.deepEqual(odd.memoClears.map(short), ['1']);
});

test('a memo that gets no answer holds its thread back for the pass, and the next thread is read', async () => {
  const core = rexCore({ memoUnanswered: [mtid(1)] });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), rexSpider({ halt: false }), { core });
  assert.deepEqual(readsOf(run.events), [2]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 held=1');
});

test('a memo that is not kept stops the sending before the next read, and its thread counts as left: a later pass reads it at once', async () => {
  const core = rexCore({ memoUnkept: true });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]], folwrs: { 1: failing(500) } }), rexSpider({ halt: false }), { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 failed=1 left=2 stop=store');
});

test('three failed reads in a row end the pass, each with its summary and memo', async () => {
  const pages = [[1, 2, 3, 4, 5].map((n) => thread(n, n))];
  const folwrs = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, failing(500)]));
  const core = rexCore();
  const run = await pass(site({ pages, folwrs }), rexSpider({ halt: false }), { core });
  assert.deepEqual(readsOf(run.events), [1, 2, 3]);
  assert.deepEqual(core.memoWrites.map(([id]) => short(id)), ['1', '2', '3']);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=5 dispatched=3 failed=3 left=2 stop=failed-reads');
});

test('a read that works breaks the run, and a thread held back by its memo neither counts in it nor breaks it', async () => {
  const pages = [[1, 2, 3, 4, 5, 6, 7].map((n) => thread(n, n))];
  const folwrs = { 1: failing(500), 3: failing(500), 5: failing(404), 6: failing(500) };
  const core = rexCore({ memos: { [mtid(4)]: { ended: keyMs(4), at: NOW - 1000, retryMs: LATE, failures: 1 } } });
  const run = await pass(site({ pages, folwrs }), rexSpider({ halt: false }), { core });
  assert.deepEqual(readsOf(run.events), [1, 2, 3, 5, 6]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=7 dispatched=5 failed=4 held=1 left=1 stop=failed-reads');
});

test('halt_on_error ends the reads at the first that fails, after its summary and memo', async () => {
  const core = rexCore();
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]], folwrs: { 1: failing(500) } }), rexSpider(), { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(kindsOf(run.sent), [['1', true]]);
  assert.deepEqual(core.memoWrites.map(([id]) => short(id)), ['1']);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 failed=1 left=1 stop=halt-on-error');
});

test('halt_on_error is read before each thread: served during the reads, it ends them at the next failure', async () => {
  const web = site({ pages: [[1, 2, 3, 4].map((n) => thread(n, n))], folwrs: { 1: failing(500), 3: failing(500) } });
  const run = await pass(web, rexSpider({ halt: () => web.folwrCount() >= 2 }));
  assert.deepEqual(readsOf(run.events), [1, 2, 3]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=3 failed=2 left=1 stop=halt-on-error');
});

// ---- Google's limited page ----
//
// After about 40 requests Google answers the thread page with a limited
// page: a 200 search page that holds none of the five values (read.mts).

const LIMITED = ok(limitedPage());

test('a limited thread page stops the pass as limited after the home check: a 60-minute back-off, no summary, no memo, and the thread left for a later pass', async () => {
  const pages = [[thread(1, 1), thread(2, 2), thread(3, 3)]];
  const side = rexSpider({ halt: false });
  const core = rexCore();
  const run = await pass(site({ pages, threadPages: { 2: LIMITED } }), side, { core });
  assert.deepEqual(run.events, [
    'GET home', 'wait 30000', 'GET list 0',
    'wait 30000', 'GET page 1', 'wait 30000', 'GET folwr 1', 'dispatch 1',
    'wait 30000', 'stamp 1-detail', 'GET page 2', 'wait 30000', 'GET home',
  ]);
  assert.deepEqual(kindsOf(run.sent), [['1', false]]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail')]);
  assert.deepEqual(core.memoWrites, []);
  const stored = core.held.backoff as BackoffState;
  assert.deepEqual(core.backoffWrites, [{ until: run.clock() + 60 * MINUTE, failures: 1, code: 'limited' }]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=3 dispatched=1 left=2 stop=limited');
  // A minute later the pass is skipped with no request and no store call but the back-off's.
  const skipped = site({ pages });
  const next = await pass(skipped, side, { core, now: run.clock() + MINUTE });
  assert.deepEqual(skipped.requests, []);
  assert.deepEqual(next.trace.filter((entry) => REX_CORE_CALL.test(entry)), ['backoff get']);
  assert.deepEqual(next.outcome, { count: -1, ids: [], reason: `backoff until=${new Date(stored.until).toISOString()} code=limited` });
  // Once it has run out, thread 2 is read with the one not reached, and the clean pass clears the back-off.
  const after = await pass(site({ pages }), side, { core, now: stored.until });
  assert.deepEqual(readsOf(after.events), [2, 3]);
  assert.deepEqual(kindsOf(after.sent), [['2', false], ['3', false]]);
  assert.deepEqual(core.backoffWrites, [stored, null]);
});

test('each limited page in a row doubles the wait from 60 minutes, to at most 6 hours, and no pass sends or memos anything', async () => {
  const core = rexCore();
  const side = rexSpider({ halt: false });
  const waits: number[] = [];
  let now = NOW;
  for (let round = 0; round < 5; round += 1) {
    const run = await pass(site({ pages: [[thread(1, 1)]], threadPages: { 1: LIMITED } }), side, { core, now });
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'page 1', 'home'], `round ${round}`);
    assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=0 left=1 stop=limited', `round ${round}`);
    const state = core.held.backoff as BackoffState;
    assert.deepEqual([state.code, state.failures], ['limited', round + 1]);
    waits.push((state.until - run.clock()) / MINUTE);
    now = state.until;
  }
  assert.deepEqual(waits, [60, 120, 240, 360, 360]);
  assert.deepEqual([core.memoWrites, side.stamps], [[], []]);
});

test('a limited page whose home check says signed out ends the pass as not signed in, and one whose check is refused stops it with that refusal\'s back-off', async () => {
  const cases: [Answer, string, string | null][] = [
    [SIGNED_OUT, 'not-signed-in', null],
    [failing(401), 'not-signed-in', null],
    [SORRY, 'challenge', 'challenge'],
    [failing(429), 'rate-limited', 'rate-limited'],
  ];
  for (const [check, stop, code] of cases) {
    const core = rexCore();
    const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]], home: (nth) => (nth === 1 ? SIGNED_IN : check), threadPages: { 1: LIMITED } }), rexSpider({ halt: false }), { core });
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'page 1', 'home'], stop);
    assert.deepEqual([run.sent, core.memoWrites], [[], []], stop);
    assert.deepEqual(core.backoffWrites.map((state) => [state?.code, state === null ? null : (state.until - run.clock()) / MINUTE]), code === null ? [] : [[code, 5]], stop);
    assert.equal(withoutMs(run.outcome.reason), `ok seen=2 dispatched=0 left=2 stop=${stop}`);
  }
});

test('a limited page stops the pass even when the home check cannot tell (a 500, no answer)', async () => {
  const homes: Reply[] = [
    (nth) => (nth === 1 ? SIGNED_IN : failing(500)),
    (nth) => {
      if (nth === 1) return SIGNED_IN;
      throw new RequestError('network');
    },
  ];
  for (const home of homes) {
    const core = rexCore();
    const run = await pass(site({ home, pages: [[thread(1, 1), thread(2, 2)]], threadPages: { 1: LIMITED } }), rexSpider({ halt: false }), { core });
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'page 1', 'home']);
    assert.deepEqual([run.sent, core.memoWrites], [[], []]);
    assert.deepEqual(core.backoffWrites.map((state) => state?.code), ['limited']);
    assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=limited');
  }
});

// The crawler has met Google's limit, so its back-off is stored even when a
// switch-off in the wait before the home check ends the pass, and the next
// enabled pass does not request into the limit. A layout failure is not
// Google's limit, and the same switch-off stores nothing.
test('a switch-off served in the wait before the home check after a limited page still stores the limited back-off', async () => {
  const pages = [[thread(1, 1), thread(2, 2)]];
  const offAfterPage1 = (web: ReturnType<typeof site>) => rexSpider({ halt: false, enabled: () => !web.requests.some((url) => label(url) === 'page 1') });
  const web = site({ pages, threadPages: { 1: LIMITED } });
  const core = rexCore();
  const run = await pass(web, offAfterPage1(web), { core });
  assert.deepEqual(requestsOf(run.events), ['home', 'list 0', 'page 1']);
  assert.deepEqual([run.sent, core.memoWrites], [[], []]);
  assert.deepEqual(core.backoffWrites, [{ until: run.clock() + 60 * MINUTE, failures: 1, code: 'limited' }]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=disabled');
  const skipped = site({ pages });
  const next = await pass(skipped, rexSpider({ halt: false }), { core, now: run.clock() + MINUTE });
  assert.deepEqual(skipped.requests, []);
  assert.equal(next.outcome.reason, `backoff until=${new Date(run.clock() + 60 * MINUTE).toISOString()} code=limited`);
  const layoutWeb = site({ pages, threadPages: { 1: ok(threadPage({ garc: null })) } });
  const layoutCore = rexCore();
  const layout = await pass(layoutWeb, offAfterPage1(layoutWeb), { core: layoutCore });
  assert.deepEqual(requestsOf(layout.events), ['home', 'list 0', 'page 1']);
  assert.deepEqual([layout.sent, layoutCore.memoWrites, layoutCore.backoffWrites], [[], [], []]);
  assert.equal(withoutMs(layout.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=disabled');
});

test('a limited page neither counts in the run of failed reads nor ends one as halt_on_error would', async () => {
  const pages = [[1, 2, 3, 4].map((n) => thread(n, n))];
  const core = rexCore();
  const run = await pass(site({ pages, folwrs: { 1: failing(500), 2: failing(500) }, threadPages: { 3: LIMITED } }), rexSpider({ halt: false }), { core });
  assert.deepEqual(requestsOf(run.events).slice(2), ['page 1', 'folwr 1', 'page 2', 'folwr 2', 'page 3', 'home']);
  assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', true]]);
  assert.deepEqual(core.memoWrites.map(([id]) => short(id)), ['1', '2']);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=4 dispatched=2 failed=2 left=2 stop=limited');
  const halting = await pass(site({ pages, threadPages: { 1: LIMITED } }), rexSpider({ halt: true }));
  assert.deepEqual(halting.sent, []);
  assert.equal(withoutMs(halting.outcome.reason), 'ok seen=4 dispatched=0 left=4 stop=limited');
});

// ---- the read budget ----
//
// At most 15 thread reads in any 60 minutes, counted across passes in the
// store. The first thread's read starts 60 s into a pass: the wait after the
// home page and the one before the thread.

const FIRST_READ = NOW + 60_000;
const HOUR = 60 * MINUTE;

test('with 15 reads stored in the last hour, a detail pass reads no thread and stops as read-budget, leaving every due thread', async () => {
  const core = rexCore({ reads: Array.from({ length: 15 }, (_, k) => NOW - k * MINUTE) });
  const side = rexSpider({ halt: false });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), side, { core });
  assert.deepEqual(requestsOf(run.events), ['home', 'list 0']);
  assert.deepEqual([run.sent, side.stamps, core.memoWrites, core.backoffWrites, core.readsWrites], [[], [], [], [], []]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=read-budget');
});

test('a read stops counting once it is 60 minutes old: 15 that old let the read go ahead, 15 a millisecond younger do not', async () => {
  const at = (ms: number) => rexCore({ reads: Array.from({ length: 15 }, () => ms) });
  const old = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { core: at(FIRST_READ - HOUR) });
  assert.deepEqual(readsOf(old.events), [1]);
  assert.equal(withoutMs(old.outcome.reason), 'ok seen=1 dispatched=1');
  const young = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { core: at(FIRST_READ - HOUR + 1) });
  assert.deepEqual(readsOf(young.events), []);
  assert.equal(withoutMs(young.outcome.reason), 'ok seen=1 dispatched=0 left=1 stop=read-budget');
});

test('with 14 reads stored in the last hour, one thread is read, and the pass stops as read-budget before the next', async () => {
  const core = rexCore({ reads: Array.from({ length: 14 }, (_, k) => NOW - k * MINUTE) });
  const side = rexSpider();
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), side, { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(side.stamps, [keyOf(1, 1, 'detail')]);
  assert.equal((core.held.reads as number[]).length, 15);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=1 left=1 stop=read-budget');
});

test('a read\'s time is stored just before its page request, so a read that fails counts too', async () => {
  const core = rexCore();
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]], threadPages: { 1: failing(500) } }), rexSpider({ halt: false }), { core });
  for (const n of [1, 2]) {
    const at = run.trace.indexOf(`GET page ${n}`);
    assert.deepEqual(run.trace.slice(at - 4, at), ['keep-alive', 'reads get', 'keep-alive', 'reads set'], `thread ${n}`);
  }
  // Thread 1's page at 60 s, its failure's wait, then thread 2's page at 90 s.
  assert.deepEqual(core.readsWrites, [[FIRST_READ], [FIRST_READ, FIRST_READ + 30_000]]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2 failed=1');
});

// The enabled and mode check comes after the wait before a read, and the read
// is spent only after it, so a read that is never made is never counted.
test('a switch-off or another mode served in the wait before a read stores no read time', async () => {
  const pages = [[1, 2, 3].map((n) => thread(n, n))];
  const off = site({ pages });
  const offCore = rexCore();
  const switched = await pass(off, rexSpider({ enabled: () => off.folwrCount() < 2 }), { core: offCore });
  assert.deepEqual(readsOf(switched.events), [1, 2]);
  assert.equal(offCore.readsWrites.length, 2, 'switch-off');
  assert.equal(withoutMs(switched.outcome.reason), 'ok seen=3 dispatched=2 left=1 stop=disabled');
  const moded = site({ pages });
  const modeCore = rexCore();
  const changed = await pass(moded, rexSpider({ summarize: () => moded.folwrCount() >= 2 }), { core: modeCore });
  assert.deepEqual(readsOf(changed.events), [1, 2]);
  assert.equal(modeCore.readsWrites.length, 2, 'mode');
  assert.equal(withoutMs(changed.outcome.reason), 'ok seen=3 dispatched=2 left=1 stop=mode');
});

test('the stored times keep the newest 15, and a time more than a day ahead is dropped and not counted, while one less ahead counts', async () => {
  const older = Array.from({ length: 16 }, (_, k) => NOW - 2 * HOUR - k * MINUTE);
  const core = rexCore({ reads: [NOW + 2 * DAY, ...older] });
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(core.readsWrites, [[...older.slice(0, 14).reverse(), FIRST_READ]]);
  const behind = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { core: rexCore({ reads: Array.from({ length: 15 }, () => NOW + HOUR) }) });
  assert.deepEqual(readsOf(behind.events), []);
  assert.equal(withoutMs(behind.outcome.reason), 'ok seen=1 dispatched=0 left=1 stop=read-budget');
});

test('read times that cannot be read, or a time that is not stored, stop the pass as store before any thread read', { timeout: 5000 }, async () => {
  const cases: [string, CoreOptions][] = [
    ['a read with no answer', { readsUnanswered: true }],
    ['a read that never settles', { readsSilent: 'get' }],
    ['a read that rejects', { readsThrow: 'get' }],
    ['a write not kept', { readsUnkept: true }],
    ['a write that never settles', { readsSilent: 'set' }],
    ['a write that rejects', { readsThrow: 'set' }],
  ];
  for (const [what, options] of cases) {
    const core = rexCore(options);
    const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), rexSpider({ halt: false }), { core });
    assert.deepEqual(requestsOf(run.events), ['home', 'list 0'], what);
    assert.deepEqual([run.sent, core.memoWrites, core.backoffWrites], [[], [], []], what);
    assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=0 left=2 stop=store', what);
  }
});

test('read times of the wrong form read as none: the read goes ahead and its time replaces them', async () => {
  const core = rexCore({ readsMalformed: true, reads: Array.from({ length: 15 }, () => NOW) });
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider(), { core });
  assert.deepEqual(readsOf(run.events), [1]);
  assert.deepEqual(core.readsWrites, [[FIRST_READ]]);
});

test('a summary pass reads no thread, so it neither reads nor stores read times, and a spent budget does not stop it', async () => {
  const core = rexCore({ reads: Array.from({ length: 15 }, () => NOW) });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2)]] }), rexSpider({ summarize: true }), { core });
  assert.equal(run.trace.some((entry) => entry.startsWith('reads ')), false);
  assert.deepEqual(kindsOf(run.sent), [['1', true], ['2', true]]);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=2 dispatched=2');
});

// ---- the back-off ----

test('a back-off that has run out is cleared by a pass that reads a list page with no refusal, and kept by one that reads none', async () => {
  const old: BackoffState = { until: NOW - 1, failures: 3, code: 'rate-limited' };
  const cleared = rexCore({ backoff: old });
  await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ summarize: true }), { core: cleared });
  assert.deepEqual(cleared.backoffWrites, [null]);
  for (const options of [{ home: failing(500) }, { home: failing(401) }, { home: SIGNED_OUT }] as SiteOptions[]) {
    const kept = rexCore({ backoff: old });
    await pass(site(options), rexSpider({ summarize: true }), { core: kept });
    assert.deepEqual(kept.backoffWrites, []);
  }
});

test('an empty account\'s list read clears a back-off that has run out too', async () => {
  const core = rexCore({ backoff: { until: NOW - 1, failures: 1, code: 'challenge' } });
  const run = await pass(site(), rexSpider(), { core });
  assert.equal(withoutMs(run.outcome.reason), 'none');
  assert.deepEqual(core.backoffWrites, [null]);
});

test('a back-off is not cleared by a pass whose first list page failed without a refusal', async () => {
  const core = rexCore({ backoff: { until: NOW - 1, failures: 2, code: 'rate-limited' } });
  const run = await pass(site({ lists: { 0: failing(500) } }), rexSpider({ summarize: true }), { core });
  assert.equal(withoutMs(run.outcome.reason), 'http-error stage=list status=500');
  assert.deepEqual(core.backoffWrites, []);
});

test('a stored back-off more than 6 hours ahead is ignored, and the pass runs', async () => {
  const core = rexCore({ backoff: { until: NOW + 6 * 60 * MINUTE + 1, failures: 1, code: 'challenge' } });
  const web = site({ pages: [[thread(1, 1)]] });
  const run = await pass(web, rexSpider({ summarize: true }), { core });
  assert.ok(web.requests.length > 0);
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1');
  assert.deepEqual(core.backoffWrites, [null]);
});

test('a back-off that gets no answer does not stop the pass', async () => {
  const run = await pass(site({ pages: [[thread(1, 1)]] }), rexSpider({ summarize: true }), { core: rexCore({ backoffUnanswered: true }) });
  assert.equal(withoutMs(run.outcome.reason), 'ok seen=1 dispatched=1');
});

test('every memo, back-off and read-time call is made just after a keep-alive call too', async () => {
  const core = rexCore({
    backoff: { until: NOW - 1, failures: 2, code: 'rate-limited' },
    memos: {
      // Thread 2's memo is of an older list time, so it is read and its memo cleared; thread 3's holds it back.
      [mtid(2)]: { ended: keyMs(9), at: NOW - 1000, retryMs: LATE, failures: 1 },
      [mtid(3)]: { ended: keyMs(3), at: NOW - 1000, retryMs: LATE, failures: 1 },
    },
  });
  const run = await pass(site({ pages: [[thread(1, 1), thread(2, 2), thread(3, 3)]], folwrs: { 1: failing(500) } }), rexSpider({ halt: false }), { core });
  for (const kind of ['backoff get', 'memo get', 'memo 1', 'clear 2', 'backoff set', 'reads get', 'reads set']) {
    assert.ok(run.trace.some((entry) => entry.startsWith(kind)), `no ${kind} call`);
  }
  const calls = run.trace.flatMap((entry, at) => (REX_CORE_CALL.test(entry) ? [[entry, run.trace[at - 1]]] : []));
  for (const [call, before] of calls) {
    assert.equal(before, 'keep-alive', `${call} came after ${before}`);
  }
});

// ---- the completion's count ----

test('crawled_count is -1 whenever the pass has no whole reading of the list, and 0 or more only when it has one', async () => {
  const none: [string, SiteOptions, SideOptions][] = [
    ['signed out', { home: SIGNED_OUT }, {}],
    ['a refused list', { lists: { 0: failing(429) } }, {}],
    ['a list read in part', { pages: [[thread(1, 1)], [thread(2, 2)]], lists: { 1: failing(500) } }, { summarize: true }],
    ['switched off', {}, { enabled: false }],
  ];
  for (const [what, options, sideOptions] of none) {
    const run = await pass(site(options), rexSpider(sideOptions));
    assert.deepEqual([run.outcome.count, run.outcome.ids], [-1, []], what);
  }
  const empty = await pass(site(), rexSpider());
  assert.deepEqual([empty.outcome.count, empty.outcome.ids], [0, []]);
});
