// The Google AI Mode case of the extension's content processor, which calls
// it for platform 'google-ai-mode' on every rex-conversation point before it
// is queued for upload, with the data format it accepts: its own, which it
// also serves the spider as data_format. A record buildSummaryRecord or
// buildDetailRecord made under that format, in the standard record layout,
// comes back equal, each value written from its checked form (keep.mts) and
// every other key dropped, at every level, but in two cases. A list time
// outside 2001 to 2286 cuts the record to the scaffold (asSeconds), and a
// speaker other than user or assistant reads unrecognised. An identifier
// outside the mtid's form reads null, and a turn of another form is dropped,
// which marks the turns incomplete. Any other point keeps only the scaffold:
// the fields the processor keeps for a point of no known platform, each in
// its form. A record of another format is one, and so is every point the old
// crawler sent, since none has a format_version. The case never throws,
// because rex-content-processing uploads a failed processor's input
// unredacted. The extension carries a copy of this file and keep.mts, so the
// two import nothing but rex-types and hold no format of their own. Pure.
import { DateString } from '@bric/rex-types/types';

import { DETAIL_METADATA, INSTANT_TO_STRING, SUMMARY_METADATA, TURN, asMtid, asSeconds, hasOwn, isObject, keepAll } from './keep.mts';

const NAME = 'rex-conversation';
const PLATFORM = 'google-ai-mode';

// The form the scaffold keeps a name, a platform or a generator id in: PDK's
// generator ids and the platform strings are lowercase words joined by
// hyphens, none over 64 characters.
const ID_FORM = /^[a-z][a-z0-9-]{0,63}$/;
const inIdForm = (value: unknown): boolean => typeof value === 'string' && ID_FORM.test(value);

// The fields the content processor keeps for a point of no known platform,
// each with the form the scaffold keeps it in; a field outside its form, or
// undefined, is left out. _pdk_trace_context and passive-data-metadata are
// PDK's own and go as they come, as in the processor's other cases.
const SCAFFOLD: Readonly<Record<string, (value: unknown) => boolean>> = {
  date: (value) => typeof value === 'number' && Number.isFinite(value),
  name: inIdForm,
  platform: inIdForm,
  identifier: (value) => asMtid(value) !== null,
  generatorId: inIdForm,
  _pdk_trace_context: (value) => value !== undefined,
  'passive-data-metadata': (value) => value !== undefined,
};
// The scaffold's PDK keys, which a record keeps after its own.
const ENVELOPE: ReadonlySet<string> = new Set(['generatorId', '_pdk_trace_context', 'passive-data-metadata']);
const FIELDS = [...Object.keys(SCAFFOLD), 'format_version', 'is_summary', 'started', 'ended', 'turns', 'turns_complete', 'metadata'];

// A field of the event: an own property, read once, or undefined if reading
// it throws, as a getter or a proxy can.
function readOwn(event: unknown, key: string): unknown {
  try {
    return hasOwn(event, key) ? (event as Readonly<Record<string, unknown>>)[key] : undefined;
  } catch {
    return undefined;
  }
}

const NUMBER_FORM = /^number:(\d+(?:\.\d+)?)$/;

// The seconds a started or ended was built from, when it is a DateString the
// list makes: new DateString(seconds), so originalValue 'number:' and the
// seconds, with value the same instant, as rex-types' Temporal.Instant or as
// its string, and no other own key. Else null, or a throw the caller catches.
// The case writes a new DateString from the seconds, so nothing else of the
// object goes out: the extension uploads originalValue too.
function secondsOf(date: unknown): number | null {
  if (!isObject(date) || Object.keys(date).length !== 2 || !hasOwn(date, 'value') || !hasOwn(date, 'originalValue')) {
    return null;
  }
  const { value, originalValue } = date;
  const number = typeof originalValue === 'string' ? NUMBER_FORM.exec(originalValue) : null;
  const seconds = number === null ? null : asSeconds(Number(number[1]));
  if (seconds === null) {
    return null;
  }
  const iso = new DateString(seconds).toJSON();
  const same = typeof value === 'string' ? value === iso : Reflect.apply(INSTANT_TO_STRING, value, []) === iso;
  return same ? seconds : null;
}

// A turn in its form, or null for one the builders do not make: a speaker
// that is no string, or a turn off the current branch.
function keepTurn(turn: unknown): Record<string, unknown> | null {
  if (!isObject(turn)) {
    return null;
  }
  const kept = keepAll(TURN, turn);
  return kept.speaker === null || kept.on_current_branch === null ? null : kept;
}

/**
 * The record for a record the builders made under the accepted format, else
 * the scaffold; never throws. An accepted format that is not a whole number
 * from 1 to 999 accepts no record, so a call that leaves it out cannot pass a
 * point with no format_version.
 */
export function redactGoogleAiMode(event: Record<string, unknown>, format: number): Record<string, unknown> {
  const fields = Object.fromEntries(FIELDS.map((key) => [key, readOwn(event, key)]));
  const scaffold = Object.fromEntries(Object.entries(SCAFFOLD).filter(([key, holds]) => holds(fields[key])).map(([key]) => [key, fields[key]]));
  try {
    const { name, platform, identifier, format_version: version, is_summary: isSummary, turns, turns_complete: complete, metadata } = fields;
    // A summary has no turns and does not say whether they are complete; a
    // detail says so.
    const shaped = isSummary === true
      ? Array.isArray(turns) && turns.length === 0 && complete === undefined
      : isSummary === false && Array.isArray(turns) && typeof complete === 'boolean';
    const accepted = Number.isInteger(format) && format >= 1 && format <= 999;
    if (!accepted || name !== NAME || platform !== PLATFORM || version !== format || !shaped || !isObject(metadata)) {
      return scaffold;
    }
    const started = secondsOf(fields.started);
    const ended = secondsOf(fields.ended);
    if (started === null || ended === null) {
      return scaffold;
    }
    // date is a summary's end, or a detail's start, in ms.
    const date = new DateString(isSummary ? ended : started).timestamp();
    if (fields.date !== date) {
      return scaffold;
    }
    const envelope = Object.fromEntries(Object.entries(scaffold).filter(([key]) => ENVELOPE.has(key)));
    const head = {
      name: NAME, platform: PLATFORM, identifier: asMtid(identifier), format_version: format, is_summary: isSummary, date,
      started: new DateString(started), ended: new DateString(ended),
    };
    if (isSummary) {
      return { ...head, turns: [], metadata: keepAll(SUMMARY_METADATA, metadata), ...envelope };
    }
    // Each element read once; a turn dropped here leaves the turns incomplete.
    const read = Array.from(turns as unknown[]);
    const kept = read.map(keepTurn).filter((turn) => turn !== null);
    return { ...head, turns: kept, turns_complete: complete === true && kept.length === read.length, metadata: keepAll(DETAIL_METADATA, metadata), ...envelope };
  } catch {
    return scaffold;
  }
}
