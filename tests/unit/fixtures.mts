// Synthetic list entries and parsed threads for the record tests. The raw
// entries and their markers are in entry-fixtures.mts. Entries are read
// through parseListPage, so a record is built from what the list really
// produces, and a test can check that no marker reaches a record.
import assert from 'node:assert/strict';

import { type ListEntry, parseListPage } from '../../src/list.mts';
import type { AimTurn, ParsedThread } from '../../src/record.mts';
import { rawEntry } from './entry-fixtures.mts';

export { ANSWER_MARKER, CREATED_S, MARKERS, MSTK, MTID, NUMBERS, TITLE, TITLE_HASH, UPDATED_S, URL_MARKER, rawEntry } from './entry-fixtures.mts';

// The entry the list reads from a raw entry on a last page.
export function listEntry(changes: Record<number, unknown> = {}): ListEntry {
  const page = parseListPage(`)]}'\n\n${JSON.stringify([[rawEntry(changes)], null, 1])}`);
  assert.ok(page !== null && page.entries.length === 1, 'Test setup invalid: the list did not read the entry');
  return page.entries[0];
}

export function userTurn(chars: number | null, words: number | null): AimTurn {
  return {
    identifier: null, parent: null, speaker: 'user', when: null, on_current_branch: true,
    text_chars: chars, text_words: words, citation_count: 0, search_result_count: null, attachments: null,
  };
}

export function assistantTurn(chars: number | null, words: number | null, citations: number | null): AimTurn {
  return {
    identifier: null, parent: null, speaker: 'assistant', when: null, on_current_branch: true,
    text_chars: chars, text_words: words, citation_count: citations, search_result_count: null, attachments: null,
  };
}

// count turns, a question then an answer, the turn at index i with
// text_chars i, so a test can tell which were kept.
export function numberedTurns(count: number): AimTurn[] {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? userTurn(index, 1) : assistantTurn(index, 1, 0)));
}

export function thread(turns: AimTurn[], complete = true, blocks = Math.ceil(turns.length / 2)): ParsedThread {
  return { turns, blocks, complete };
}
