// Re-sending after a change of mode. Each mode has its own upload key
// (keys.mts), so a thread sent in one mode is unsent in the other. Re-sending
// everything in the crawl window on every switch would be too much, and
// re-sending nothing would leave the new mode without the recent past, so a
// switch re-sends the threads last used in the RESEND_WINDOW_MS before it,
// once. "Before it" is the first pass in this browser that ran the new mode,
// kept in the store, so a browser that was offline when the config changed
// still gets the full window. A browser that has never stored a mode, such as
// one updated from the spider before this rewrite, counts as switching then.
//
// That spider keyed both modes alike under another id (keys.mts,
// legacyKeyId), which matches neither mode's key. Under data format 1, a
// thread found under it counts as sent in the other mode, whichever mode is
// served: the update re-sends, once, the threads used in the RESEND_WINDOW_MS
// before it, and older ones keep the record they have.
//
// Every key is the data format's own (format.mts), so all of this holds
// within one format. Under a later format no key of an earlier one counts,
// the old spider's included: every thread in the crawl window is due once,
// whatever its age and whichever mode was served before.
import type { DateString } from '@bric/rex-types/types';

import { legacyKeyId, uploadKeyId } from './keys.mts';
import type { ListEntry } from './list.mts';
import type { AimStore, Mode } from './store.mts';

export const RESEND_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// A stored start further ahead of now than this was written under a clock
// that ran fast. Trusted, it would shrink the re-send, possibly to nothing, so
// it is replaced by now. A clock that ran slow cannot be told apart from a
// real early start and is trusted.
export const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// When this browser started running the served mode, writing the record when
// the stored one is absent, malformed, of the other mode or from the future.
// Null when the record could not be read or a new one could not be written:
// this pass then re-sends nothing (dueState holds), and the next pass tries
// again.
export async function resendSince(store: Pick<AimStore, 'mode'>, served: Mode, now: number): Promise<number | null> {
  const stored = await store.mode.get();
  if (stored.unanswered) {
    return null;
  }
  if (stored.value !== null && stored.value.mode === served && stored.value.since <= now + CLOCK_SKEW_MS) {
    return stored.value.since;
  }
  const written = await store.mode.set({ mode: served, since: now });
  return written.ok ? now : null;
}

// The upload-key lookup the caller hands in: rex-spider's
// checkIfAlreadyTransmitted behind a deadline, or a test's stand-in. Not the
// bare call, which never settles while rex-core's database is not open
// (rex-core answers no read then). At the deadline the lookup should reject:
// an answer of false would read as never sent, and the thread would go out
// again.
export type Transmitted = (id: string, ended: DateString) => Promise<boolean>;

// What a thread in the crawl window needs this pass, under the pass's data
// format. sent: it was sent in the served mode at this time, or sent in the
// other mode (or, under format 1, by the old spider) at this time and last
// used more than RESEND_WINDOW_MS before the switch. due: it is to be sent.
// held: it was sent in the other mode or by the old spider, and with no start
// for this pass (since null) it is held back rather than sent. Every key is
// looked up at the entry's updated, the time the old spider's keys were
// built from too. A format out of form rejects (keys.mts).
export type Need = 'sent' | 'due' | 'held';

export async function dueState(transmitted: Transmitted, entry: ListEntry, served: Mode, since: number | null, format: number): Promise<Need> {
  const ended = entry.updated;
  if (await transmitted(uploadKeyId(entry.mtid, served === 'summary', format), ended)) {
    return 'sent';
  }
  const sentBefore = (await transmitted(uploadKeyId(entry.mtid, served !== 'summary', format), ended)) || (format === 1 && (await transmitted(legacyKeyId(entry), ended)));
  if (!sentBefore) {
    return 'due';
  }
  if (since === null) {
    return 'held';
  }
  return ended.timestamp() < since - RESEND_WINDOW_MS ? 'sent' : 'due';
}
