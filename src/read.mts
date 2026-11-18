// Reading one thread with two requests: the thread page, which holds the
// five values the folwr request needs, then folwr, whose answer holds every
// turn. pace() is awaited between them. A read that fails says why;
// nothing is logged, since the URLs name the thread and the bodies hold its
// questions and answers.
import type { Answer, Classification, Client } from './client.mts';
import { classify } from './client.mts';
import type { ListEntry } from './list.mts';
import type { ParsedThread } from './record.mts';
import { FOLWR_TEXT_CAP, unchunk } from './stream.mts';
import { parseTurns } from './turns.mts';

export interface FolwrValues {
  garc: string;
  mlro: string;
  mlros: string;
  xsrf: string;
  ei: string;
}

// layout: the thread page lacks a value, or holds one out of its form, but
// holds at least one of the four data- attributes that carry four of the
// values; or the folwr stream gives no turn block, or none whose answer body
// was found. limited: the page holds none of those four in any form, as
// Google's limited page, its answer to too many reads, does (the pass stops
// on it with a back-off). stream: the folwr body has no guard or a chunk
// cannot be walked. too-large: the folwr body is over FOLWR_TEXT_CAP and was
// not read. network: a request got no answer. The rest are the answer's
// classification.
export type ReadFailure = 'layout' | 'limited' | 'stream' | 'too-large' | Exclude<Classification, 'ok'> | 'network';

// A failure's answer is the one whose classification ended the read, so the
// pass can read its status and Retry-After. It is null for layout, limited,
// stream and too-large, which need neither, so a page or a folwr body (up to
// 40 Mi units of the thread's text) and the URL with its tokens go no
// further than here; and null for network, which got no answer. Its text
// and url are never logged.
export type ReadResult = { ok: true; thread: ParsedThread } | { ok: false; failure: ReadFailure; answer: Answer | null };

// mstk and mtid are in id form (list.mts), so encoding changes nothing; it
// is there so no other value could change the URL's shape.
export function threadPageUrl(entry: ListEntry): string {
  return `https://www.google.com/search?udm=50&mstk=${encodeURIComponent(entry.mstk)}&mtid=${encodeURIComponent(entry.mtid)}&csuir=1&hl=en`;
}

// A value is taken as written, so one that would need decoding (an entity),
// or holds a space, a quote or a bracket, counts as missing rather than be
// sent on changed. VALUE finds the first of each kind; a value not in its
// captured form (ID_FORM, and for the xsrf token XSRF_FORM) then counts as
// missing too, so the folwr URL is always in the form its allow pattern
// names (allowed.mts), which Chrome's size limit keeps that narrow.
const VALUE = '([^\\s"\'<>&]+)';
const ID_FORM = /^[A-Za-z0-9_-]+$/;
const XSRF_FORM = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;
const attribute = (name: string) => new RegExp(`\\s${name}="${VALUE}"`);
const GARC = attribute('data-garc');
const MLRO = attribute('data-lro-token');
const MLROS = attribute('data-lro-signature');
const XSRF = attribute('data-xsrf-folwr-token');
const EI = new RegExp(`kEI:'${VALUE}'`);

// The five values, each the first of its kind on the page, or null when any
// is missing.
export function folwrValues(html: string): FolwrValues | null {
  const found = (pattern: RegExp, form: RegExp): string | undefined => {
    const value = pattern.exec(html)?.[1];
    return value !== undefined && form.test(value) ? value : undefined;
  };
  const garc = found(GARC, ID_FORM);
  const mlro = found(MLRO, ID_FORM);
  const mlros = found(MLROS, ID_FORM);
  const xsrf = found(XSRF, XSRF_FORM);
  const ei = found(EI, ID_FORM);
  if (garc === undefined || mlro === undefined || mlros === undefined || xsrf === undefined || ei === undefined) {
    return null;
  }
  return { garc, mlro, mlros, xsrf, ei };
}

// Whether the page holds any of the four data- attributes in any form: the
// name, as an attribute (after a space), and its =, whatever follows, quoted
// or not, so a value out of form, or one written another way, still counts;
// a name written as a script or JSON key does not. Only a page with none of
// the four is Google's limited page; one with any is a layout change. kEI is
// not asked: the limited pages of the live runs (2026-11-17) held none of
// the four attributes, while kEI was checked there in one form only.
const ATTRIBUTES = ['data-garc', 'data-lro-token', 'data-lro-signature', 'data-xsrf-folwr-token'].map((name) => new RegExp(`\\s${name}\\s*=`));
const holdsAnyAttribute = (html: string): boolean => ATTRIBUTES.some((pattern) => pattern.test(html));

// Only these five parameters, in this order: each dropped alone breaks the
// read, and none of the page's other ten is needed.
export function folwrUrl(v: FolwrValues): string {
  return `https://www.google.com/async/folwr?${new URLSearchParams({ async: `_fmt:prog,_xsrf:${v.xsrf}`, garc: v.garc, mlro: v.mlro, mlros: v.mlros, ei: v.ei })}`;
}

// The answer, or null when the request got none. A RequestError says only
// whether it timed out, and that goes no further than here.
async function get(client: Client, url: string): Promise<Answer | null> {
  try {
    return await client.get(url);
  } catch {
    return null;
  }
}

const failed = (failure: ReadFailure, answer: Answer | null): ReadResult => ({ ok: false, failure, answer });

// The thread's turns, complete only when parseTurns found every turn whole
// and the stream ended whole. A pace() that rejects rejects the read.
export async function readThread(client: Client, entry: ListEntry, pace: () => Promise<void>): Promise<ReadResult> {
  const page = await get(client, threadPageUrl(entry));
  if (page === null) {
    return failed('network', null);
  }
  const pageClass = classify(page);
  if (pageClass !== 'ok') {
    return failed(pageClass, page);
  }
  const values = folwrValues(page.text);
  if (values === null) {
    return failed(holdsAnyAttribute(page.text) ? 'layout' : 'limited', null);
  }
  await pace();
  const stream = await get(client, folwrUrl(values));
  if (stream === null) {
    return failed('network', null);
  }
  const streamClass = classify(stream);
  if (streamClass !== 'ok') {
    return failed(streamClass, stream);
  }
  // Checked before unchunk, which refuses it too, so the failure says why.
  if (stream.text.length > FOLWR_TEXT_CAP) {
    return failed('too-large', null);
  }
  const unchunked = unchunk(stream.text);
  if (unchunked === null) {
    return failed('stream', null);
  }
  const thread = parseTurns(unchunked.html);
  // Every thread has at least one turn, so no turn block, or none whose
  // answer body was found (parseTurns gives an answer null counts only
  // then), means the parser no longer sees Google's markup. As a record it
  // would take the detail key, and the thread would not be read again at
  // this list time.
  if (!thread.turns.some((turn) => turn.speaker === 'assistant' && turn.text_chars !== null)) {
    return failed('layout', null);
  }
  return { ok: true, thread: { ...thread, complete: thread.complete && unchunked.whole } };
}
