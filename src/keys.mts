// Every rex-core key this module writes or looks up. They sit under the
// namespace rex-spider gives the spider, next to the two keys rex-spider
// writes itself: rex-spider-google-ai-last-crawl, and the upload key
// rex-spider-google-ai-conversation-upload-<id>-<ms>, which rex-spider builds
// from an id below and the list entry's updated (list.mts, ListEntry).

import type { ListEntry } from './list.mts';

export const KEY_PREFIX = 'rex-spider-google-ai-';

function idOrThrow(id: string, what: string): string {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  return id;
}

// The id an upload key is built from, one per mode, so a thread sent in one
// mode is unsent in the other.
export function uploadKeyId(mtid: string, summary: boolean): string {
  return summary ? idOrThrow(mtid, 'an mtid') : `${idOrThrow(mtid, 'an mtid')}-detail`;
}

// The id the spider before this rewrite built its upload keys from, the same
// in both modes: "<[0][0]>_<[0][1]>" of the list entry, which is the mstk and
// the mtid. No key above matches it, so a thread it sent would look unsent;
// mode.mts looks it up as sent in the other mode. The mstk changes when the
// thread gets a turn, and its time with it, so a thread with no turn since
// still has the id its old key holds.
export function legacyKeyId(entry: Pick<ListEntry, 'mstk' | 'mtid'>): string {
  return `${idOrThrow(entry.mstk, 'an mstk')}_${idOrThrow(entry.mtid, 'an mtid')}`;
}

// The served mode and when this browser first saw it (store.mts, ModeRecord).
export const MODE_KEY = `${KEY_PREFIX}mode`;

// The wait a refusal asked for, which skips passes until it runs out
// (backoff.mts, BackoffState).
export const BACKOFF_KEY = `${KEY_PREFIX}backoff`;

// When the last thread reads started, which the read budget counts
// (budget.mts; store.mts, AimStore's reads).
export const READS_KEY = `${KEY_PREFIX}read-times`;

const MEMO_PREFIX = `${KEY_PREFIX}detail-memo-`;

// One thread's memo of a failed detail read (store.mts, DetailMemo).
export function memoKey(mtid: string): string {
  return `${MEMO_PREFIX}${idOrThrow(mtid, 'an mtid')}`;
}

// The part of a key that may be logged: its kind. A memo key carries a thread
// id, and a key this module does not own is not echoed at all.
export function keyKind(key: string): string {
  if (key === MODE_KEY || key === BACKOFF_KEY || key === READS_KEY) {
    return key;
  }
  if (key.startsWith(MEMO_PREFIX)) {
    return `${KEY_PREFIX}detail-memo`;
  }
  return 'other key';
}
