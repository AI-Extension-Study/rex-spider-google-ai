// Reading one thread with two requests: the thread page, which holds the
// five values the folwr request needs, then folwr, whose answer holds every
// turn. pace() is awaited between them. A read that fails says why, and
// hands back the answer that ended it so the pass can sort it (a wait's
// Retry-After, a challenge); nothing is logged, since the URLs name the
// thread and the bodies hold its questions and answers.
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

// layout: the thread page lacks a value. stream: the folwr body has no guard
// or a chunk cannot be walked. too-large: the folwr body is over
// FOLWR_TEXT_CAP and was not read. network: a request got no answer. The
// rest are the answer's classification.
export type ReadFailure = 'layout' | 'stream' | 'too-large' | Exclude<Classification, 'ok'> | 'network';

export type ReadResult = { ok: true; thread: ParsedThread } | { ok: false; failure: ReadFailure; answer: Answer | null };

// mstk and mtid are in id form (list.mts), so encoding changes nothing; it
// is there so no other value could change the URL's shape.
export function threadPageUrl(entry: ListEntry): string {
  return `https://www.google.com/search?udm=50&mstk=${encodeURIComponent(entry.mstk)}&mtid=${encodeURIComponent(entry.mtid)}&csuir=1&hl=en`;
}

// A value is taken as written, so one that would need decoding (an entity),
// or holds a space, a quote or a bracket, counts as missing rather than be
// sent on changed. Captured forms: letters, digits, '-', '_' and the xsrf
// token's ':'.
const VALUE = '([^\\s"\'<>&]+)';
const attribute = (name: string) => new RegExp(`\\s${name}="${VALUE}"`);
const GARC = attribute('data-garc');
const MLRO = attribute('data-lro-token');
const MLROS = attribute('data-lro-signature');
const XSRF = attribute('data-xsrf-folwr-token');
const EI = new RegExp(`kEI:'${VALUE}'`);

// The five values, each the first of its kind on the page, or null when any
// is missing.
export function folwrValues(html: string): FolwrValues | null {
  const garc = GARC.exec(html)?.[1];
  const mlro = MLRO.exec(html)?.[1];
  const mlros = MLROS.exec(html)?.[1];
  const xsrf = XSRF.exec(html)?.[1];
  const ei = EI.exec(html)?.[1];
  if (garc === undefined || mlro === undefined || mlros === undefined || xsrf === undefined || ei === undefined) {
    return null;
  }
  return { garc, mlro, mlros, xsrf, ei };
}

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
    return failed('layout', page);
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
    return failed('too-large', stream);
  }
  const unchunked = unchunk(stream.text);
  if (unchunked === null) {
    return failed('stream', stream);
  }
  const thread = parseTurns(unchunked.html);
  return { ok: true, thread: { ...thread, complete: thread.complete && unchunked.whole } };
}
