// The raw list entries of fixtures.mts, in a module that imports nothing, so
// the worker specs can build list pages from them too: Playwright's loader
// does not strip types under node_modules, and fixtures.mts reaches
// rex-types through list.mts. A raw entry has the 31 positions the list
// capture found, each value in its captured form ([5] and [6] are seconds and
// nanoseconds, [22] the four [key, value] pairs), and every position that
// held text holds a made-up marker.

// Ids in the captured forms: an mtid of 22 characters, an mstk of 30 and
// more, both [A-Za-z0-9_-], sharing no run of characters a test could
// mistake for the other.
export const MTID = 'AbCdEfGhIjKlMnOpQrSt_1';
export const MSTK = 'Mstk-0123456789_zyxwvutsrqPONML';

export const CREATED_S = 1_763_300_000; // 2025-11-16T13:33:20Z
export const UPDATED_S = 1_763_303_600; // an hour later

// [1], the generated title, and its SHA-256 in hex from shasum -a 256.
export const TITLE = 'SECRET-TITLE of a synthetic thread';
export const TITLE_HASH = '47f1d91fc419d24e636e7c9d1378b9ad84c5e2dd952b0290f8613fe116bccedf';

// [14] held answer text on 3 records of the test exports, and [2] a URL on
// 10.
export const ANSWER_MARKER = 'ANSWER-MARKER-14 the answer the list carried';
export const URL_MARKER = 'https://example.com/URL-MARKER-2/image.png';

// Every string planted in a raw entry but the mtid, which a record carries as
// its identifier.
export const MARKERS = [
  TITLE, ANSWER_MARKER, URL_MARKER, MSTK, 'SECRET-TITLE', 'ANSWER-MARKER-14', 'URL-MARKER-2', 'NESTED-MARKER-4', 'FOLLOW-UP-MARKER-10',
  'FOLLOW-UP-MARKER-12', 'QUESTION-MARKER-20', 'TITLE-MARKER-21', 'TEXT-MARKER-24',
] as const;

// The list numbers the fixture plants, by position.
export const NUMBERS = { 3: 0, 11: 0, 13: 4, 17: 1, 18: 0, 23: 1, 25: 0, 26: 0, 27: 2, 30: 0 } as const;

export function rawEntry(changes: Record<number, unknown> = {}): unknown[] {
  const at: unknown[] = new Array(31).fill(null);
  at[0] = [MSTK, MTID];
  at[1] = TITLE;
  at[2] = URL_MARKER;
  at[4] = ['NESTED-MARKER-4', [URL_MARKER]];
  at[5] = [CREATED_S, 741_739_000];
  at[6] = [UPDATED_S, 263_669_000];
  at[10] = 'FOLLOW-UP-MARKER-10';
  at[12] = 'FOLLOW-UP-MARKER-12';
  at[14] = ANSWER_MARKER;
  at[20] = 'QUESTION-MARKER-20';
  at[21] = 'TITLE-MARKER-21';
  at[22] = [['mtid', MTID], ['csuir', '1'], ['mstk', MSTK], ['udm', '50']];
  at[24] = 'TEXT-MARKER-24';
  for (const [position, value] of Object.entries(NUMBERS)) {
    at[Number(position)] = value;
  }
  for (const [position, value] of Object.entries(changes)) {
    at[Number(position)] = value;
  }
  return at;
}
