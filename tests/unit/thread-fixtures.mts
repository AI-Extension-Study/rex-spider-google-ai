// Synthetic folwr streams in the captured form, for the stream, turn and read
// tests. The frames, the placeholder spans and the markers have the captured
// shapes; every id is made up, and every text is made up.
//
// A stream is Google's JSON guard and a newline, then chunks written as
// <hex length>;<payload>, the length in UTF-16 units. The payloads are a
// header frame and [2,null,"0"], the root's HTML, [9,null,"0"] and the root's
// empty marker, then the fills: [6,"<placeholder>","0"], the fill's HTML
// chunks, [9,null,"0"] and a marker chunk. One [8,null,"0"] and the JSON chunk
// after it fall between two fills, as in every capture.

// A made-up ei in the captured form: 23 characters of [A-Za-z0-9_-].
export const EI = 'FakeEi-0123456789_abcde';

export const placeholderId = (n: number): string => `_${EI}_${n}`;
export const placeholder = (n: number): string => `<span data-async-ph="${placeholderId(n)}"></span>`;

export const HEADER_FRAME = JSON.stringify([EI, '1234', null, [4, 0, 1, 1, 0]]);
export const ROOT_FRAME = '[2,null,"0"]';
export const END_FRAME = '[9,null,"0"]';
export const DATA_FRAME = '[8,null,"0"]';
export const DATA_CHUNK = '[[1,"made-up data"],null]';
export const fillFrame = (n: number): string => JSON.stringify([6, placeholderId(n), '0']);
// The marker forms seen: <ei>_stcn_<k>, <ei>_stcr_<k> and <ei>_stcc_<Name>_<k>.
export const fillMarker = (k: number, name = ''): string => `${EI}_stc${name === '' ? 'n' : 'c'}_${name === '' ? '' : `${name}_`}${k}`;

export interface Fill {
  readonly n: number;
  readonly chunks: readonly string[];
  // The marker chunk after [9,null,"0"]; a well-formed one when absent.
  readonly marker?: string;
}

// The payloads of a whole stream: the root's chunks, then each fill, with the
// data frame after the first fill.
export function streamChunks(root: readonly string[], fills: readonly Fill[]): string[] {
  const chunks = [HEADER_FRAME, ROOT_FRAME, ...root, END_FRAME, ''];
  fills.forEach((fill, index) => {
    chunks.push(fillFrame(fill.n), ...fill.chunks, END_FRAME, fill.marker ?? fillMarker(index + 1));
    if (index === 0) {
      chunks.push(DATA_FRAME, DATA_CHUNK);
    }
  });
  return chunks;
}

// The body Google sends for these payloads.
export function streamBody(chunks: readonly string[]): string {
  return `)]}'\n${chunks.map((payload) => `${payload.length.toString(16)};${payload}`).join('')}`;
}

// A whole stream whose root holds one placeholder, filled with html in the
// given chunks, plus the root's second placeholder, filled empty last, as in
// the captures.
export function simpleStream(htmlChunks: readonly string[]): string {
  return streamBody(streamChunks([`<div><div>${placeholder(1)}</div>${placeholder(8)}</div>`], [{ n: 1, chunks: htmlChunks }, { n: 8, chunks: [''] }]));
}
