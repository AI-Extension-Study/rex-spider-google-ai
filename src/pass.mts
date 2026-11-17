// One crawl pass: the home page, which says whether the browser is signed in
// to Google, the list walk, and a record for each thread in the crawl window
// that is not sent yet in the served mode. Summary mode builds the record
// from the list entry; detail mode reads the thread first (read.mts). The
// requests, rex-spider's side, rex-core's store, the dispatch, the waits and
// the clock are handed in, so the pass runs under the unit tests as it does
// in the worker. It never throws: every outcome is a reason (reasons.mts),
// and it never logs text, a title, an id or a URL.
//
// The failure policy. A 429, a 503, any Retry-After or Google's
// unusual-traffic page (/sorry/) stops the pass and sets a back-off that
// outlives the worker (backoff.mts), which skips the passes after it until
// it runs out; that thread gets nothing and is read after it. A home page
// without SignOutOptions, a 401 anywhere, or a list that comes back empty
// after a cursor ends the pass as not signed in, with no back-off. A read
// whose page lacks a thread value checks the home page once more, and ends
// the pass so too if the home page has no SignOutOptions. A page with none of
// the five values is Google's limited page, its answer to too many reads:
// after that home check it stops the pass with a back-off of its own, and
// its thread gets nothing, as after a 429. Any other failed read is that
// thread's alone: its summary goes out in the detail's place unless one went
// out at that time, and a memo holds it back for a day, or a week when the
// failure will not pass by itself. Three such in a row end the pass, or the
// first with halt_on_error. A detail pass reads at most the read budget's
// threads in any hour, counted across passes in the store (budget.mts), and
// stops once the hour's reads reach it.
import type { DateString } from '@bric/rex-types/types';

import { type BackoffCode, type BackoffState, backoffDecision, nextBackoff } from './backoff.mts';
import { READ_BUDGET, type ReadBudget, readsInWindow, withRead } from './budget.mts';
import { type Answer, type Client, RequestError, classify, retryAfterMs } from './client.mts';
import { HOME_URL, isSignedIn } from './home.mts';
import { uploadKeyId } from './keys.mts';
import { type ListEntry, type WalkResult, walkList } from './list.mts';
import { CLOCK_SKEW_MS, type Transmitted, dueState, resendSince } from './mode.mts';
import { TIMED_OUT, crawlDelayMs, touch, withDeadline } from './pacing.mts';
import { type ReadFailure, type ReadResult, readThread } from './read.mts';
import { type Cut, type ReasonCode, type ReasonFields, type Stop, formatReason } from './reasons.mts';
import { type AimRecord, buildDetailRecord, buildSummaryRecord, hashTitle } from './record.mts';
import type { AimStore, DetailMemo, Mode } from './store.mts';

// The rex-spider calls the pass makes on the spider. The flags are the
// served config as of the last refresh, read where they apply: isEnabled
// before every request, the served mode and halt_on_error before each
// thread. The crawl window and the upload keys go to rex-core, which never
// answers while its database is not open, so each such call has a deadline.
export interface PassFramework {
  isEnabled(): boolean;
  justSummarize(): boolean;
  continueAfterError(): boolean;
  fetchCrawlDelay(): number;
  crawlWindowStart(): Promise<number | null>;
  crawlWindowEnd(): Promise<number | null>;
  checkIfAlreadyTransmitted(identifier: string, updated: DateString): Promise<boolean>;
  logTransmitted(identifier: string, updated: DateString): Promise<void>;
}

export interface PassLimits {
  // The wait after records are dispatched before their keys are stamped. It
  // stands in for a signal rex-core's dispatchEvent does not give: when a
  // point is stored. The extension stores points a little over a second after
  // the last one, so 3 s leaves room for a batch. A worker that dies before
  // the stamps sends those records again rather than losing them.
  readonly settleMs: number;
  // Summary records dispatched before each settle wait.
  readonly batch: number;
  // The longest wait for the crawl window, an upload-key lookup or a stamp:
  // long enough that only storage that is not answering trips it.
  readonly storeMs: number;
  // The longest wait for one title hash. rex-core's sha256 never settles when
  // the digest fails, and a record must not wait on it for good.
  readonly hashMs: number;
  // The reading time after which a pass reads no more threads: the requests,
  // parsing and store calls of its thread reads, and not its paced waits,
  // which at the 30 s pace would end a pass after half a dozen threads. It
  // starts at the first thread read, since every pass walks the list first,
  // and a long list's walk could otherwise spend it before any thread is
  // read. The threads a pass does not reach keep no key and are read in a
  // later pass.
  readonly detailBudgetMs: number;
  // Failed thread reads in a row that end a pass without halt_on_error: past
  // a few, the reads are failing for a reason the next threads share.
  readonly failedRun: number;
  // Thread reads in any window, across passes (budget.mts).
  readonly readBudget: ReadBudget;
}

export const PASS_LIMITS: PassLimits = { settleMs: 3000, batch: 25, storeMs: 20_000, hashMs: 1000, detailBudgetMs: 360_000, failedRun: 3, readBudget: READ_BUDGET };

const DAY_MS = 24 * 60 * 60 * 1000;

// When a thread whose read failed is read again: a day after a first failure
// that may pass by itself, a week after any other or a repeat. A thread used
// since, with a newer list time, is read at once.
export const RETRY_SOON_MS = DAY_MS;
export const RETRY_LATE_MS = 7 * DAY_MS;

// The failures that may pass by themselves, as on the ChatGPT crawler: no
// answer, a 5xx (or a redirect that was not followed), and a 2xx that is not
// what was asked for, as an interstitial would be: a page that lacks a thread
// value or holds one out of form (layout) or a folwr body that is not a whole
// stream of chunks. The limited page writes no memo and is not here. A
// refusal (a 403, a 404), a body over the cap, which a thread only grows
// past, and a thread that cannot be built into a record wait for a change.
const MAY_PASS: ReadonlySet<string> = new Set(['network', 'server', 'layout', 'stream']);

export interface Records {
  readonly summary: typeof buildSummaryRecord;
  readonly detail: typeof buildDetailRecord;
}

const RECORDS: Records = { summary: buildSummaryRecord, detail: buildDetailRecord };

export interface PassDeps {
  // www.google.com with the browser's cookies (client.mts).
  readonly client: Client;
  readonly framework: PassFramework;
  // rex-core's store, for the mode record (mode.mts), the back-off
  // (backoff.mts), the memos of failed reads and the read times
  // (budget.mts).
  readonly store: Pick<AimStore, 'mode' | 'backoff' | 'memo' | 'reads'>;
  readonly dispatch: (record: AimRecord) => void;
  // Every wait of the pass, in chunks of at most 20 s with a keep-alive call
  // before each (pacing.mts).
  readonly sleep: (ms: number) => Promise<void>;
  // Made before each store call, which does not reset the worker's idle timer.
  readonly keepAlive: () => unknown;
  // The title's hash: rex-core's sha256 in the worker.
  readonly hash: (text: string) => Promise<string>;
  // The record builders (record.mts): the real ones unless a test hands in
  // others.
  readonly records?: Records;
  readonly limits?: PassLimits;
  readonly log?: (line: string) => void;
}

export interface PassOutcome {
  // Records sent when the pass read the whole list, or -1 when it has no
  // whole reading of it: it read none, or only part. Readers of the
  // completion event take 0 or more to mean ids is the account's threads in
  // the window, so a list read in part would read as threads deleted. The
  // reason still says how many records a partial pass sent.
  readonly count: number;
  // The threads listed in the crawl window, by mtid, in the walk's order; []
  // with -1.
  readonly ids: string[];
  readonly reason: string;
}

// Epoch ms, as rex-spider's crawlWindowStart and crawlWindowEnd give them;
// null is no bound on that side.
export interface CrawlWindow {
  readonly start: number | null;
  readonly end: number | null;
}

// rex-spider's crawlWindowContains, on the two bounds read once per pass:
// both ends included, and a time that is not a finite number is outside.
// The list walk asks only whether a time is before the start (every page is
// newest first, so the first such ends the walk); a thread is sent only when
// this says it is inside.
export function windowContains(window: CrawlWindow, ms: number): boolean {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return false;
  }
  return (window.start === null || ms >= window.start) && (window.end === null || ms <= window.end);
}

// The store did not answer, or failed.
class StoreSilent extends Error {}
// enabled false was served during the list walk or a thread read.
class SwitchedOff extends Error {}

type Stage = 'start' | 'home' | 'list';

interface Pass {
  readonly deps: PassDeps;
  readonly limits: PassLimits;
  readonly now: () => number;
  readonly say: (line: string) => void;
  readonly records: Records;
  // When the pass started, for the ms its reason ends with.
  readonly started: number;
  // Time spent in the paced waits, which the detail budget leaves out.
  waited: number;
  // Where a throw is reported, until the list is read.
  stage: Stage;
  // The back-off as the pass found it, null when there was none or it could
  // not be read.
  backoff: BackoffState | null;
  // The pass's refusal or limited page, which sets the back-off; at most
  // one, since it stops the pass.
  refusal: { readonly code: BackoffCode; readonly retryAfterMs: number | null } | null;
  // List pages answered in full, which with no refusal clear the back-off.
  pagesRead: number;
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);

// A paced wait, measured on the clock rather than taken as the wait asked
// for, so a timer that fires late, or a clock change during the wait, does
// not count as reading either.
async function pace(pass: Pass, ms: number): Promise<void> {
  const from = pass.now();
  await pass.deps.sleep(ms);
  pass.waited += Math.max(0, pass.now() - from);
}

// The wait before a request of the walk, a thread's folwr or a home page
// check: crawl_delay, then enabled is read again, so a spider switched off
// during the wait sends no request after it.
async function beforeRequest(pass: Pass): Promise<void> {
  await pace(pass, crawlDelayMs(pass.deps.framework.fetchCrawlDelay()));
  if (!pass.deps.framework.isEnabled()) {
    throw new SwitchedOff();
  }
}

// The reading time since a mark: the time since, less the paced waits since.
interface Mark {
  readonly at: number;
  readonly waited: number;
}

const markOf = (pass: Pass): Mark => ({ at: pass.now(), waited: pass.waited });
const spentSince = (pass: Pass, mark: Mark): number => pass.now() - mark.at - (pass.waited - mark.waited);

// The pass's wall-clock time, for its reason.
function elapsed(pass: Pass): number {
  const ms = Math.round(pass.now() - pass.started);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}

// The title's hash to its deadline, or null: hashTitle never rejects, but
// rex-core's sha256 may never settle.
async function titleHash(pass: Pass, entry: ListEntry): Promise<string | null> {
  const hashed = await withDeadline(hashTitle(entry.title, pass.deps.hash), pass.limits.hashMs);
  return hashed === TIMED_OUT ? null : hashed;
}

// One rex-core call through rex-spider to its deadline, after a keep-alive
// call. One that gets no answer, or fails, rejects.
async function stored<T>(pass: Pass, call: () => Promise<T>): Promise<T> {
  touch(pass.deps.keepAlive, pass.say);
  let answer: T | typeof TIMED_OUT;
  try {
    answer = await withDeadline(Promise.resolve().then(call), pass.limits.storeMs);
  } catch {
    throw new StoreSilent();
  }
  if (answer === TIMED_OUT) {
    throw new StoreSilent();
  }
  return answer;
}

// The upload-key lookup: true or false as rex-core answers. One that gets no
// answer rejects, never answers false: false reads as never sent, and the
// thread would go out again.
const lookup = (pass: Pass): Transmitted => async (id, at) => (await stored(pass, () => pass.deps.framework.checkIfAlreadyTransmitted(id, at))) === true;

// Stamps a sent record's key and reads it back, since rex-spider's
// logTransmitted resolves whatever the store answers, a failed write
// included. A stamp that is not kept or gets no answer stops the sending for
// the pass: a record sent without its key goes out again in a later pass,
// and a store that fails would leave every record of the pass so.
async function stamp(pass: Pass, id: string, at: DateString): Promise<boolean> {
  try {
    await stored(pass, () => pass.deps.framework.logTransmitted(id, at));
    if (await lookup(pass)(id, at)) {
      return true;
    }
    pass.say('an upload key was not kept; the sending stops for this pass');
  } catch {
    pass.say('an upload key got no answer; the sending stops for this pass');
  }
  return false;
}

function dispatched(pass: Pass, record: AimRecord): boolean {
  try {
    pass.deps.dispatch(record);
    return true;
  } catch (error) {
    pass.say(`a record could not be dispatched (${nameOf(error)}); the sending stops for this pass`);
    return false;
  }
}

// Why the sending stops before the next thread, if it does: the spider was
// switched off, or the served mode is no longer the pass's. A thread already
// sent keeps the key of the mode it went out in, and the next pass sends in
// the mode served then.
function halted(pass: Pass, mode: Mode): Stop | null {
  const { framework } = pass.deps;
  if (!framework.isEnabled()) {
    return 'disabled';
  }
  if ((framework.justSummarize() ? 'summary' : 'detail') !== mode) {
    pass.say('another mode was served during the pass; a later pass sends the threads not sent');
    return 'mode';
  }
  return null;
}

interface Sending {
  readonly sent: number;
  readonly failed: number;
  readonly held: number;
  readonly stop: Stop | null;
  // When it stopped, the due threads a later pass sends: those not reached,
  // and those sent without their key, which go out again. Absent when it
  // stopped before it knew which threads were due.
  readonly left?: number;
}

// Summary mode: the records in batches, each batch's keys stamped after the
// settle wait that follows it. Each record's title hash is awaited before it
// is dispatched.
async function sendSummaries(pass: Pass, due: readonly ListEntry[]): Promise<Sending> {
  let sent = 0;
  let stamped = 0;
  let stop: Stop | null = null;
  try {
    for (let start = 0; start < due.length && stop === null; start += pass.limits.batch) {
      const out: ListEntry[] = [];
      for (const entry of due.slice(start, start + pass.limits.batch)) {
        stop = halted(pass, 'summary');
        if (stop !== null) {
          break;
        }
        // A hash that hangs holds a record for the hash deadline, and a batch
        // of them would outlast the worker's idle limit with no call between.
        touch(pass.deps.keepAlive, pass.say);
        if (!dispatched(pass, pass.records.summary(entry, await titleHash(pass, entry)))) {
          stop = 'internal';
          break;
        }
        out.push(entry);
        sent += 1;
      }
      if (out.length > 0) {
        await pace(pass, pass.limits.settleMs);
        for (const entry of out) {
          if (!(await stamp(pass, uploadKeyId(entry.mtid, true), entry.updated))) {
            stop = 'store';
            break;
          }
          stamped += 1;
        }
      }
    }
  } catch (error) {
    pass.say(`the summary records ended on an internal error (${nameOf(error)})`);
    stop = 'internal';
  }
  return { sent, failed: 0, held: 0, stop, ...(stop === null ? {} : { left: due.length - stamped }) };
}

type ReadWhy = ReadFailure | 'unreadable';

type DetailRead =
  | { readonly kind: 'record'; readonly record: AimRecord }
  | { readonly kind: 'failed'; readonly why: ReadWhy; readonly retryAfterMs: number | null };

// One thread, as a detail record, or why it gave none. crawl_delay is waited
// between its two requests, and a switch-off served in that wait rejects
// (SwitchedOff). The log names the kind of failure and the status, never the
// answer's text or URL.
async function readDetail(pass: Pass, entry: ListEntry): Promise<DetailRead> {
  let result: ReadResult;
  try {
    result = await readThread(pass.deps.client, entry, () => beforeRequest(pass));
  } catch (error) {
    if (error instanceof SwitchedOff) {
      throw error;
    }
    // A parser that throws on this thread fails this thread's read alone:
    // were it to end the pass, the thread would come first on every pass
    // and the threads behind it would never be read.
    pass.say(`a thread read ended on an internal error (${nameOf(error)})`);
    return { kind: 'failed', why: 'unreadable', retryAfterMs: null };
  }
  if (!result.ok) {
    const { failure, answer } = result;
    pass.say(`a thread read failed (${failure}${answer === null ? '' : `, status ${answer.status}`})`);
    const refused = failure === 'rate-limited' || failure === 'challenge';
    return { kind: 'failed', why: failure, retryAfterMs: refused && answer !== null ? retryAfterMs(answer, pass.now()) : null };
  }
  touch(pass.deps.keepAlive, pass.say);
  try {
    return { kind: 'record', record: pass.records.detail(entry, await titleHash(pass, entry), result.thread) };
  } catch (error) {
    pass.say(`the record builder failed on a thread (${nameOf(error)})`);
    return { kind: 'failed', why: 'unreadable', retryAfterMs: null };
  }
}

type HomeCheck = { readonly kind: 'signed-in' | 'signed-out' | 'unknown' } | { readonly kind: 'refused'; readonly code: 'rate-limited' | 'challenge' };

// The home page once more, after a read whose page lacked a thread value or
// all five: a signed-out session's thread page lacks them too. A refusal
// sets the back-off as anywhere else. An answer that cannot say either way
// (no answer, another status) lets a layout failure count, and a limited
// page stop the pass.
async function checkHome(pass: Pass): Promise<HomeCheck> {
  await beforeRequest(pass);
  let home: Answer;
  try {
    home = await pass.deps.client.get(HOME_URL);
  } catch {
    pass.say('the home page check got no answer; the read counts as failed');
    return { kind: 'unknown' };
  }
  const verdict = classify(home);
  if (verdict === 'rate-limited' || verdict === 'challenge') {
    pass.refusal = { code: verdict, retryAfterMs: retryAfterMs(home, pass.now()) };
    return { kind: 'refused', code: verdict };
  }
  if (verdict === 'signed-out') {
    return { kind: 'signed-out' };
  }
  if (verdict === 'ok') {
    return { kind: isSignedIn(home.text) ? 'signed-in' : 'signed-out' };
  }
  pass.say(`the home page check failed (status ${home.status}); the read counts as failed`);
  return { kind: 'unknown' };
}

// The read budget, asked just before a thread's page request: spent when the
// reads stored in its window have reached its count; store when the times
// got no answer or the new one was not kept, since no read is made without
// its time stored first; ok once this read's time is stored. A read counts
// from its page request, whatever comes of it. Times of another form read as
// none, and this read's time replaces them.
async function spendRead(pass: Pass): Promise<'ok' | 'spent' | 'store'> {
  const budget = pass.limits.readBudget;
  let times: readonly number[];
  try {
    const read = await stored(pass, () => pass.deps.store.reads.get());
    if (read.unanswered) {
      throw new StoreSilent();
    }
    times = read.value ?? [];
  } catch {
    pass.say('the read times got no answer; the reads stop for this pass');
    return 'store';
  }
  const now = pass.now();
  if (readsInWindow(times, now, budget) >= budget.reads) {
    pass.say('the read budget is spent; the threads not read are read in a later pass');
    return 'spent';
  }
  try {
    if ((await stored(pass, () => pass.deps.store.reads.set(withRead(times, now, budget)))).ok) {
      return 'ok';
    }
  } catch {
    // Said below.
  }
  pass.say('a read time was not kept; the reads stop for this pass');
  return 'store';
}

// A write that waits for the wait before the next read, as a record waits to
// be stored before its key does: a detail record's key, or the memo of a
// failed read, whose summary may have just gone out.
type Pending =
  | { readonly kind: 'stamp'; readonly id: string; readonly at: DateString }
  | { readonly kind: 'memo'; readonly mtid: string; readonly memo: DetailMemo };

// A memo that is not kept stops the sending, as a stamp does: the next pass
// would read the thread again at once and send its summary again.
async function written(pass: Pass, write: Pending): Promise<boolean> {
  if (write.kind === 'stamp') {
    return stamp(pass, write.id, write.at);
  }
  touch(pass.deps.keepAlive, pass.say);
  let kept: boolean;
  try {
    kept = (await pass.deps.store.memo.set(write.mtid, write.memo)).ok;
  } catch {
    kept = false;
  }
  if (!kept) {
    pass.say('a memo of a failed read was not kept; the sending stops for this pass');
  }
  return kept;
}

// Detail mode: each thread read in turn, crawl_delay apart and never closer
// than the settle wait, until the reads have spent the detail budget. A
// record's key, or a failed read's memo, is written after the wait before the
// next read, or after a settle wait at the end, so what went out is stored
// before what says it went out. A thread its memo holds back is passed over,
// and neither counts in a run of failed reads nor breaks one.
async function sendDetails(pass: Pass, due: readonly ListEntry[]): Promise<Sending> {
  const { framework, store } = pass.deps;
  let sent = 0;
  // Threads dealt with for now: a record whose key was kept, or a failed read
  // whose memo was kept. With the held ones, the rest are left.
  let done = 0;
  let failed = 0;
  let held = 0;
  let inARow = 0;
  let stop: Stop | null = null;
  let pending: Pending | null = null;
  const start = markOf(pass);
  try {
    for (const entry of due) {
      const at = entry.updated;
      touch(pass.deps.keepAlive, pass.say);
      const memo = await store.memo.get(entry.mtid);
      if (memo.unanswered) {
        pass.say('a memo of a failed read got no answer; its thread is read in a later pass');
        held += 1;
        continue;
      }
      // A memo of this list time holds its thread until its retry time,
      // unless it was written under a clock that ran fast, which the mode
      // record's start is not trusted after either (mode.mts).
      const earlier = memo.value !== null && memo.value.ended === at.timestamp() ? memo.value : null;
      if (earlier !== null && earlier.at <= pass.now() + CLOCK_SKEW_MS && pass.now() < earlier.at + earlier.retryMs) {
        held += 1;
        continue;
      }
      if (spentSince(pass, start) >= pass.limits.detailBudgetMs) {
        pass.say('the detail budget is spent; the threads not read are read in a later pass');
        stop = 'budget';
        break;
      }
      await pace(pass, Math.max(crawlDelayMs(framework.fetchCrawlDelay()), pass.limits.settleMs));
      if (pending !== null) {
        const write = pending;
        pending = null;
        if (!(await written(pass, write))) {
          stop = 'store';
          break;
        }
        done += 1;
      }
      stop = halted(pass, 'detail');
      if (stop !== null) {
        break;
      }
      // halt_on_error as served now, for this thread's read.
      const halts = !framework.continueAfterError();
      const spend = await spendRead(pass);
      if (spend !== 'ok') {
        stop = spend === 'spent' ? 'read-budget' : 'store';
        break;
      }
      const read = await readDetail(pass, entry);
      if (read.kind === 'record') {
        inARow = 0;
        if (memo.value !== null || memo.malformed) {
          touch(pass.deps.keepAlive, pass.say);
          if (!(await store.memo.clear(entry.mtid)).ok) {
            pass.say('a memo of a failed read was not cleared');
          }
        }
        if (!dispatched(pass, read.record)) {
          stop = 'internal';
          break;
        }
        sent += 1;
        // The key's time is the list's update time, as the key was checked.
        pending = { kind: 'stamp', id: uploadKeyId(entry.mtid, false), at };
        continue;
      }
      if (read.why === 'rate-limited' || read.why === 'challenge') {
        // Google asked for a wait: this thread gets nothing now, and is read
        // after the back-off.
        pass.refusal = { code: read.why, retryAfterMs: read.retryAfterMs };
        pass.say('Google asked for a wait; the threads not read are read after the back-off');
        stop = read.why;
        break;
      }
      if (read.why === 'signed-out') {
        pass.say('the session ended during the thread reads');
        stop = 'not-signed-in';
        break;
      }
      if (read.why === 'limited') {
        // Google's limited page: the back-off is set before the home check,
        // so a switch-off or a throw in its wait still stores it, and the
        // next enabled pass does not request into the limit. A refusal there
        // replaces it, and a signed-out home page clears it.
        pass.refusal = { code: 'limited', retryAfterMs: null };
      }
      if (read.why === 'layout' || read.why === 'limited') {
        const home = await checkHome(pass);
        if (home.kind === 'signed-out') {
          // A signed-out session's thread page, not Google's limit.
          pass.refusal = null;
          pass.say('the home page holds no SignOutOptions after a read that found no thread values; the user is not signed in');
          stop = 'not-signed-in';
          break;
        }
        if (home.kind === 'refused') {
          pass.say('Google asked for a wait; the threads not read are read after the back-off');
          stop = home.code;
          break;
        }
      }
      if (read.why === 'limited') {
        // This thread gets nothing now, neither a summary nor a memo, and does
        // not count as a failed read; it is read after the back-off.
        pass.say('a thread page held none of the thread values, as Google\'s limited page; the threads not read are read after the back-off');
        stop = 'limited';
        break;
      }
      failed += 1;
      inARow += 1;
      const failures = (earlier?.failures ?? 0) + 1;
      // The summary goes out in the detail's place once per list time: at a
      // first failure, and unless summary mode sent it at that time before a
      // switch. It gets no key: a thread last used before the re-send window
      // would then count as sent in detail (mode.mts), and its read would
      // never come again.
      if (failures === 1 && !(await lookup(pass)(uploadKeyId(entry.mtid, true), at))) {
        touch(pass.deps.keepAlive, pass.say);
        if (!dispatched(pass, pass.records.summary(entry, await titleHash(pass, entry)))) {
          // No memo, so a later pass reads the thread at once and sends its
          // summary then.
          stop = 'internal';
          break;
        }
        sent += 1;
      }
      pending = { kind: 'memo', mtid: entry.mtid, memo: { ended: at.timestamp(), at: pass.now(), retryMs: MAY_PASS.has(read.why) && failures === 1 ? RETRY_SOON_MS : RETRY_LATE_MS, failures } };
      if (halts || inARow >= pass.limits.failedRun) {
        pass.say(halts ? 'a thread read failed and halt_on_error is set; the reads stop' : `${inARow} thread reads failed in a row; the reads stop`);
        stop = halts ? 'halt-on-error' : 'failed-reads';
        break;
      }
    }
  } catch (error) {
    if (error instanceof SwitchedOff) {
      stop = 'disabled';
    } else if (error instanceof StoreSilent) {
      pass.say('an upload key got no answer; the sending stops for this pass');
      stop = 'store';
    } else {
      pass.say(`the thread reads ended on an internal error (${nameOf(error)})`);
      stop = 'internal';
    }
  }
  if (pending !== null) {
    try {
      await pace(pass, pass.limits.settleMs);
      if (await written(pass, pending)) {
        done += 1;
      } else {
        stop ??= 'store';
      }
    } catch (error) {
      pass.say(`the last write of the thread reads was not made (${nameOf(error)})`);
      stop ??= 'internal';
    }
  }
  return { sent, failed, held, stop, ...(stop === null ? {} : { left: due.length - done - held }) };
}

// The threads due this pass, checked against the upload keys, then sent in
// the served mode, newest first so a pass cut short has sent the most recent.
async function sendAll(pass: Pass, entries: readonly ListEntry[], served: Mode, since: number | null): Promise<Sending> {
  let held = 0;
  const due: ListEntry[] = [];
  try {
    const transmitted = lookup(pass);
    for (const entry of entries) {
      const need = await dueState(transmitted, entry, served, since);
      if (need === 'due') {
        due.push(entry);
      } else if (need === 'held') {
        held += 1;
      }
    }
  } catch (error) {
    pass.say(error instanceof StoreSilent ? 'an upload key got no answer; the sending stops for this pass' : `the upload keys could not be read (${nameOf(error)})`);
    return { sent: 0, failed: 0, held, stop: error instanceof StoreSilent ? 'store' : 'internal' };
  }
  if (held > 0) {
    pass.say(`${held} threads are held back for a later pass: sent only in the other mode while the mode record could not be read`);
  }
  due.sort((a, b) => b.updated.timestamp() - a.updated.timestamp());
  const sending = served === 'summary' ? await sendSummaries(pass, due) : await sendDetails(pass, due);
  return { ...sending, held: sending.held + held };
}

// The pass with no reading of the list. A skipped pass, which made no
// attempt, has no ms and is written where it is skipped.
function none<C extends Exclude<ReasonCode, 'ok' | 'partial' | 'none' | 'backoff'>>(pass: Pass, code: C, fields: Omit<ReasonFields<C>, 'ms'>): PassOutcome {
  return { count: -1, ids: [], reason: formatReason(code, { ...fields, ms: elapsed(pass) } as unknown as ReasonFields<C>) };
}

const seconds = (ms: number | null | undefined): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms / 1000) : undefined);

// A refusal, a sign-out or another status at the home page or a list page.
// Null when the answer is ok.
function refusedAt(pass: Pass, stage: 'home' | 'list', answer: Answer): PassOutcome | null {
  const verdict = classify(answer);
  switch (verdict) {
    case 'rate-limited':
    case 'challenge': {
      const asked = retryAfterMs(answer, pass.now());
      pass.refusal = { code: verdict, retryAfterMs: asked };
      return verdict === 'challenge'
        ? none(pass, 'challenge', { stage, status: answer.status })
        : none(pass, 'rate-limited', { stage, status: answer.status, 'retry-after': seconds(asked) });
    }
    case 'signed-out':
      return none(pass, 'not-signed-in', { stage, status: answer.status });
    case 'refused':
    case 'not-found':
    case 'server':
      return none(pass, 'http-error', { stage, status: answer.status });
    default:
      return null;
  }
}

// The home page: signed in, or how the pass ends there.
async function readHome(pass: Pass): Promise<PassOutcome | null> {
  let home: Answer;
  try {
    home = await pass.deps.client.get(HOME_URL);
  } catch (error) {
    return none(pass, error instanceof RequestError && error.kind === 'timeout' ? 'timeout' : 'network', { stage: 'home' });
  }
  const refused = refusedAt(pass, 'home', home);
  if (refused !== null) {
    return refused;
  }
  if (!isSignedIn(home.text)) {
    pass.say('the home page holds no SignOutOptions; the user is not signed in to Google');
    return none(pass, 'not-signed-in', { stage: 'home' });
  }
  return null;
}

// Why a walk read only in part was cut, for the reason. An answer that ended
// it here is a status that is neither a refusal nor a sign-out.
function cutOf(walk: WalkResult): Cut {
  switch (walk.stop) {
    case 'unreadable':
    case 'timeout':
    case 'network':
    case 'repeated-cursor':
    case 'page-limit':
      return walk.stop;
    default:
      return 'http-error';
  }
}

// How a walk that is not whole ends the pass, or null when what it read is
// to be sent. A refusal or a sign-out ends it wherever it came, since the
// next request would meet it too, and the pages before it are not acted on.
function walkStopped(pass: Pass, walk: WalkResult): PassOutcome | null {
  if (walk.outcome === 'whole') {
    return null;
  }
  if (walk.stop === 'answer' && walk.answer !== null) {
    const verdict = classify(walk.answer);
    if (verdict === 'rate-limited' || verdict === 'challenge' || verdict === 'signed-out' || walk.outcome === 'failed') {
      return refusedAt(pass, 'list', walk.answer);
    }
    return null;
  }
  if (walk.stop === 'no-list') {
    pass.say('the list came back empty after a cursor; the session ended during the walk');
    return none(pass, 'not-signed-in', { stage: 'list' });
  }
  if (walk.outcome === 'failed') {
    if (walk.stop === 'timeout' || walk.stop === 'network') {
      return none(pass, walk.stop, { stage: 'list' });
    }
    return none(pass, 'list-failed', { cut: cutOf(walk) });
  }
  return null;
}

async function crawlWindow(pass: Pass): Promise<CrawlWindow | null> {
  const { framework } = pass.deps;
  try {
    const [start, end] = await stored(pass, () => Promise.all([framework.crawlWindowStart(), framework.crawlWindowEnd()]));
    return { start, end };
  } catch {
    pass.say('the crawl window got no answer');
    return null;
  }
}

async function run(pass: Pass): Promise<PassOutcome> {
  const { deps } = pass;
  const { framework } = deps;
  // rex-spider checks enabled when it queues the crawl; the config may have
  // switched the spider off since.
  if (!framework.isEnabled()) {
    return none(pass, 'disabled', { stage: 'start' });
  }
  // A back-off still running skips the pass with no request. One that cannot
  // be read is no reason to skip.
  touch(deps.keepAlive, pass.say);
  const backoff = await deps.store.backoff.get();
  if (backoff.unanswered) {
    pass.say('the back-off got no answer; the pass goes ahead');
  }
  pass.backoff = backoff.value;
  const decision = backoffDecision(backoff.value, pass.now());
  if (decision.skip) {
    pass.say('a back-off is running; the pass is skipped');
    return { count: -1, ids: [], reason: formatReason('backoff', { until: decision.until, code: decision.code }) };
  }
  const served: Mode = framework.justSummarize() ? 'summary' : 'detail';
  // When this browser started running the served mode, written now if it
  // had not run it before (mode.mts). Taken before any request, so a pass
  // that finds the user signed out still dates a switch.
  const since = await resendSince({
    mode: {
      get: () => {
        touch(deps.keepAlive, pass.say);
        return deps.store.mode.get();
      },
      set: (record) => {
        touch(deps.keepAlive, pass.say);
        return deps.store.mode.set(record);
      },
    },
  }, served, pass.now());
  if (since === null) {
    pass.say('the mode record was not read or not written; threads sent only in the other mode wait for a later pass');
  }
  const window = await crawlWindow(pass);
  if (window === null) {
    return none(pass, 'store', {});
  }
  // The mode record's read and write and the window's lookup can each take up
  // to a store deadline, and a refresh in that time may have switched the
  // spider off, so enabled is read again just before the first request.
  if (!framework.isEnabled()) {
    return none(pass, 'disabled', { stage: 'start' });
  }
  pass.stage = 'home';
  const home = await readHome(pass);
  if (home !== null) {
    return home;
  }
  pass.stage = 'list';
  let walk: WalkResult;
  try {
    // crawl_delay between every two requests of the pass, the home page's
    // too, and enabled read again after each wait.
    await beforeRequest(pass);
    // A list page answered in full counts toward clearing the back-off.
    const counted: Client = {
      get: async (url) => {
        const answer = await deps.client.get(url);
        if (classify(answer) === 'ok') {
          pass.pagesRead += 1;
        }
        return answer;
      },
    };
    // The walk is asked only whether a thread is older than the window's
    // start, so threads newer than its end do not end the walk; those are
    // passed over below.
    walk = await walkList(counted, async (ms) => window.start === null || ms >= window.start, () => beforeRequest(pass));
  } catch (error) {
    if (error instanceof SwitchedOff) {
      return none(pass, 'disabled', { stage: 'list' });
    }
    throw error;
  }
  const stopped = walkStopped(pass, walk);
  if (stopped !== null) {
    return stopped;
  }
  const whole = walk.outcome === 'whole';
  const malformed = walk.malformed > 0 ? walk.malformed : undefined;
  if (whole && walk.entries.length === 0 && walk.malformed === 0) {
    return { count: 0, ids: [], reason: formatReason('none', { ms: elapsed(pass) }) };
  }
  const inWindow = walk.entries.filter((entry) => windowContains(window, entry.updated.timestamp()));
  // A walk read only in part may hold no thread because the list failed,
  // not because the account has none.
  if (!whole && inWindow.length === 0) {
    return none(pass, 'list-failed', { cut: cutOf(walk) });
  }
  const sending = await sendAll(pass, inWindow, served, since);
  const ids = inWindow.map((entry) => entry.mtid);
  const positive = (count: number) => (count > 0 ? count : undefined);
  const fields = {
    seen: ids.length,
    dispatched: sending.sent,
    failed: positive(sending.failed),
    held: positive(sending.held),
    left: sending.left,
    malformed,
  };
  const stop = sending.stop ?? undefined;
  if (whole) {
    return { count: sending.sent, ids, reason: formatReason('ok', { ...fields, stop, ms: elapsed(pass) }) };
  }
  return { count: -1, ids: [], reason: formatReason('partial', { ...fields, cut: cutOf(walk), stop, ms: elapsed(pass) }) };
}

// What outlives the pass. A refusal sets the back-off, longer after each in a
// row; a pass that read a list page and met none clears it; a pass that read
// none says nothing of Google, and the back-off stays as it was. Never
// throws: the outcome is the pass's report, and a store that fails here must
// not lose it.
async function persist(pass: Pass): Promise<void> {
  const { refusal } = pass;
  let next: BackoffState | null;
  if (refusal !== null) {
    next = nextBackoff(pass.backoff, { kind: 'refused', now: pass.now(), code: refusal.code, retryAfterMs: refusal.retryAfterMs });
  } else if (pass.pagesRead > 0 && pass.backoff !== null) {
    next = null;
  } else {
    return;
  }
  try {
    touch(pass.deps.keepAlive, pass.say);
    if (!(await pass.deps.store.backoff.set(next)).ok) {
      pass.say('the back-off was not stored');
    }
  } catch (error) {
    pass.say(`the back-off was not stored (${nameOf(error)})`);
  }
}

export async function runPass(deps: PassDeps, now: () => number): Promise<PassOutcome> {
  const log = deps.log ?? ((line: string) => console.log(`[rex-spider-google-ai] ${line}`));
  // A log that throws has nowhere left to report to.
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // ignored
    }
  };
  let pass: Pass | null = null;
  try {
    pass = {
      deps, limits: deps.limits ?? PASS_LIMITS, now, say, records: deps.records ?? RECORDS, started: now(), waited: 0, stage: 'start',
      backoff: null, refusal: null, pagesRead: 0,
    };
    let outcome: PassOutcome;
    try {
      outcome = await run(pass);
    } catch (error) {
      say(`the pass ended on an internal error (${nameOf(error)})`);
      outcome = none(pass, 'internal', { stage: pass.stage });
    }
    await persist(pass);
    return outcome;
  } catch (error) {
    say(`the pass ended on an internal error (${nameOf(error)})`);
    try {
      if (pass !== null) {
        return none(pass, 'internal', { stage: pass.stage });
      }
    } catch {
      // A clock that throws: the literal below.
    }
    return { count: -1, ids: [], reason: 'internal stage=start ms=0' };
  }
}
