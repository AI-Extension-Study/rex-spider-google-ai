// The allow-list of the Google AI Mode case (redact.mts): every key a format
// 1 record may carry at each level, with the form its value is kept in. A form
// returns the value when it is in form, else null, or 'unrecognised' for a
// speaker string other than the two, which carries nothing of the string.
// They are the forms the builders apply (record.mts, list.mts), applied again
// because the extension runs the case on whatever point names the platform.
// The extension carries a copy of this file and redact.mts, so it imports
// nothing but rex-types. Pure.
import { DateString } from '@bric/rex-types/types';

const UNRECOGNISED = 'unrecognised';

export const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Object.hasOwn, which this repo's library target (es2021) does not name. It
// throws on null or undefined, and runs a proxy's traps, as Object.hasOwn does.
export const hasOwn = (value: unknown, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

// An own key's value, or undefined: a key named like one of Object's own
// (constructor, toString) is never read through the prototype.
export const ownField = (value: unknown, key: string): unknown => (isObject(value) && hasOwn(value, key) ? value[key] : undefined);

// Every key of the table, in its order, each from the value's own key of
// that name in its form; null where the value has none.
export function keepAll(table: Readonly<Record<string, (value: unknown) => unknown>>, value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table).map(([key, form]) => [key, form(ownField(value, key))]));
}

const asCount = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
// The list's small integers, as list.mts reads them.
const asSmallInteger = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 ? value : null);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const asHash = (value: unknown): string | null => (typeof value === 'string' && SHA256_HEX.test(value) ? value : null);

// The thread's mtid, in the form list.mts reads [0][1] in. The old crawler's
// <mstk>_<mtid> is past 64 characters, since every mstk the captures saw was
// 135 or more.
const MTID_FORM = /^[A-Za-z0-9_-]{1,64}$/;
export const asMtid = (value: unknown): string | null => (typeof value === 'string' && MTID_FORM.test(value) ? value : null);

// Epoch seconds from 2001 to 2286. The list's times are seconds, and the
// bound keeps a time in milliseconds from reading as one some 50,000 years
// ahead; a record with a list time outside it is cut to the scaffold, as on
// ChatGPT.
export const asSeconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 1e9 && value < 1e10 ? value : null);

// Temporal.Instant, taken from a DateString's value so it is the copy
// DateString reads with. Its from() throws on a string that names no instant
// (a 13th month, hour 24), which a shape check alone would let by.
const INSTANT = (new DateString('1970-01-01T00:00:00Z').value as object).constructor as unknown as { from(item: string): object };
export const INSTANT_TO_STRING = (INSTANT as unknown as { prototype: { toString(): string } }).prototype.toString;

// The instant a string names, as Temporal writes it, or null.
function instantText(value: string): string | null {
  try {
    return Reflect.apply(INSTANT_TO_STRING, INSTANT.from(value), []);
  } catch {
    return null;
  }
}

// created_at and updated_at as the builders write them, a DateString's JSON:
// UTC with Z, and a fraction only when the second has one, with no trailing
// zero. Temporal also reads offsets and [annotations]; the shape and the
// exact rewrite keep both out.
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const asUtcTime = (value: unknown): string | null => (typeof value === 'string' && UTC_TIME.test(value) && instantText(value) === value ? value : null);

// The builder copies the parser's speaker without a check, so the closed set
// is applied here.
const SPEAKERS: ReadonlySet<string> = new Set(['user', 'assistant']);
const asSpeaker = (value: unknown): string | null => (typeof value !== 'string' ? null : SPEAKERS.has(value) ? value : UNRECOGNISED);

// A key with one value on every AI Mode turn: the thread carries no per-turn
// id or time and does not branch, the source list's total is not in it, and
// images are not read.
const asNull = (): null => null;
const asTrue = (value: unknown): true | null => (value === true ? true : null);

const LIST_NUMBERS: Readonly<Record<string, (value: unknown) => unknown>> = Object.fromEntries(
  ['3', '11', '13', '17', '18', '23', '25', '26', '27', '30'].map((key) => [key, asSmallInteger]),
);

// Exactly the ten list numbers, whatever the value holds, so a record never
// carries more than the fixed schema.
export const SUMMARY_METADATA = {
  title_hash: asHash, created_at: asUtcTime, updated_at: asUtcTime, list_numbers: (value: unknown) => keepAll(LIST_NUMBERS, value),
};
export const DETAIL_METADATA = { ...SUMMARY_METADATA, turn_blocks: asCount };

// A turn's keys in the standard's order. The five fixed-null keys read null
// whatever came. speaker and on_current_branch have no null in AI Mode's
// form: either one null here means a turn the builders do not make, which
// redact.mts drops.
export const TURN = {
  identifier: asNull, parent: asNull, speaker: asSpeaker, when: asNull, on_current_branch: asTrue,
  text_chars: asCount, text_words: asCount, citation_count: asCount, search_result_count: asNull, attachments: asNull,
};
