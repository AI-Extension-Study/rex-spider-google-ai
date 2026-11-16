// The rex-conversation records the spider sends, in the shared conversation
// record layout (format 1): a summary record from a list entry, and a detail
// record from a list entry and the turns read from its thread. Nothing in
// them is text from the list or the thread. Of the entry a record keeps the
// mtid, the two times and the small integers of LIST_NUMBER_KEYS; the title
// goes out only as its SHA-256, which the spider makes with hashTitle before
// building the record. Never the mstk, which the thread's URL carries, and no
// other position of the entry. The builders read no configuration: summary
// or detail is the caller's choice. Pure.
import type { DateString } from '@bric/rex-types/types';

import type { ListEntry } from './list.mts';
import { LIST_NUMBER_KEYS } from './list.mts';

export const FORMAT_VERSION = 1;

const NAME = 'rex-conversation';
const PLATFORM = 'google-ai-mode';

// At most this many turns, the newest kept, and their JSON at most this many
// characters, as on the other crawlers, so one thread cannot fill the upload
// queue every collector shares. Either cut leaves the turns incomplete. A
// turn holds no string but its speaker, so 1,000 turns stay far under the
// JSON bound (about 230 characters a turn at most) and only the turn cap
// cuts at these values; the bound is kept so the rule reads the same on
// every platform.
export const MAX_TURNS = 1000;
export const TURNS_JSON_LIMIT = 512 * 1024;

// One question or one answer. A thread's response carries no per-turn id or
// time, and nothing in it branches, so those keys have one value. The source
// list's total is not in the response, and the study does not read images,
// so search_result_count and attachments are always null.
export interface AimTurn {
  identifier: null;
  parent: null;
  speaker: 'user' | 'assistant';
  when: null;
  on_current_branch: true;
  text_chars: number | null;
  text_words: number | null;
  citation_count: number | null;
  search_result_count: null;
  attachments: null;
}

// What the thread parser gives: the turns in the order asked, the number of
// turn blocks the response held, and whether every block gave both turns and
// the stream ended whole.
export interface ParsedThread {
  turns: AimTurn[];
  blocks: number;
  complete: boolean;
}

export interface AimMetadata {
  // SHA-256 of the title in lowercase hex, or null.
  title_hash: string | null;
  // The entry's created and updated as ISO 8601 instants in UTC, the same
  // text the record's started and ended upload as.
  created_at: string;
  updated_at: string;
  // Exactly the LIST_NUMBER_KEYS, each an integer from 0 to 999 or null.
  list_numbers: Record<string, number | null>;
  // Detail records only: the thread's turn blocks, or null when the count
  // handed in is not a whole number of at least 0.
  turn_blocks?: number | null;
}

export interface AimRecord {
  name: typeof NAME;
  platform: typeof PLATFORM;
  identifier: string;
  format_version: typeof FORMAT_VERSION;
  is_summary: boolean;
  date: number;
  started: DateString;
  ended: DateString;
  turns: AimTurn[];
  // Detail records only.
  turns_complete?: boolean;
  metadata: AimMetadata;
}

// The caps, smaller in tests.
export interface DetailOptions {
  readonly maxTurns?: number;
  readonly turnsJsonLimit?: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const hashOrNull = (value: unknown): string | null => (typeof value === 'string' && SHA256_HEX.test(value) ? value : null);

// The title's SHA-256 as lowercase hex, or null: for no title or an empty
// one, and when the hash fails or answers with anything but lowercase hex, so
// a hash wired wrong can never send the title itself. In the spider the hash
// is rex-core's sha256, the hash the other crawlers' titles go out as.
export async function hashTitle(title: string | null, sha256: (text: string) => Promise<string>): Promise<string | null> {
  if (typeof title !== 'string' || title === '') {
    return null;
  }
  try {
    return hashOrNull(await sha256(title));
  } catch {
    return null;
  }
}

const smallInteger = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 999 ? value : null);

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

// The ten keys in their order whatever the entry holds; the list has already
// read each value by form, and is read again here so a record never carries
// more than the fixed schema.
function listNumbers(numbers: Readonly<Record<string, number | null>>): Record<string, number | null> {
  const kept: Record<string, number | null> = {};
  for (const key of LIST_NUMBER_KEYS) {
    kept[key] = Object.prototype.hasOwnProperty.call(numbers, key) ? smallInteger(numbers[key]) : null;
  }
  return kept;
}

// The title hash handed in is kept only in a SHA-256's form, so a caller
// that hands in the title by mistake sends nothing of it. created_at and
// updated_at are the DateStrings' own JSON: the list builds them from whole
// seconds, so they read like 2025-11-16T13:33:20Z.
function metadataOf(entry: ListEntry, titleHash: string | null): AimMetadata {
  return {
    title_hash: hashOrNull(titleHash),
    created_at: entry.created.toJSON(),
    updated_at: entry.updated.toJSON(),
    list_numbers: listNumbers(entry.numbers),
  };
}

// A summary record: no turns and no turns_complete. Its date, ended in epoch
// ms, is the time the upload key is built from (keys.mts).
export function buildSummaryRecord(entry: ListEntry, titleHash: string | null): AimRecord {
  return {
    name: NAME,
    platform: PLATFORM,
    identifier: entry.mtid,
    format_version: FORMAT_VERSION,
    is_summary: true,
    date: entry.updated.timestamp(),
    started: entry.created,
    ended: entry.updated,
    turns: [],
    metadata: metadataOf(entry, titleHash),
  };
}

// A turn rebuilt key by key in the layout's order, so only the standard keys
// go out whatever the parser handed in: the fixed keys at their one value,
// each count a whole number of at least 0 or null.
function turnOf(turn: AimTurn): AimTurn {
  return {
    identifier: null,
    parent: null,
    speaker: turn.speaker,
    when: null,
    on_current_branch: true,
    text_chars: count(turn.text_chars),
    text_words: count(turn.text_words),
    citation_count: count(turn.citation_count),
    search_result_count: null,
    attachments: null,
  };
}

// The newest turns within both caps, in their order. When the newest alone
// is over the JSON cap, none is kept.
function newest(turns: readonly AimTurn[], maxTurns: number, jsonLimit: number): AimTurn[] {
  const kept: AimTurn[] = [];
  let length = 2; // the brackets
  for (let at = turns.length - 1; at >= 0 && kept.length < maxTurns; at -= 1) {
    const cost = JSON.stringify(turns[at]).length + (kept.length > 0 ? 1 : 0);
    if (length + cost > jsonLimit) {
      break;
    }
    length += cost;
    kept.push(turns[at]);
  }
  return kept.reverse();
}

// A detail record: the thread's turns, cut to the caps, and its block count.
// turns_complete is the thread's complete unless a cap cut a turn. Its date
// is started in epoch ms, which the list always gives.
export function buildDetailRecord(entry: ListEntry, titleHash: string | null, thread: ParsedThread, { maxTurns = MAX_TURNS, turnsJsonLimit = TURNS_JSON_LIMIT }: DetailOptions = {}): AimRecord {
  const all = thread.turns.map(turnOf);
  const turns = newest(all, maxTurns, turnsJsonLimit);
  return {
    name: NAME,
    platform: PLATFORM,
    identifier: entry.mtid,
    format_version: FORMAT_VERSION,
    is_summary: false,
    date: entry.created.timestamp(),
    started: entry.created,
    ended: entry.updated,
    turns,
    turns_complete: turns.length === all.length && thread.complete === true,
    metadata: { ...metadataOf(entry, titleHash), turn_blocks: count(thread.blocks) },
  };
}
