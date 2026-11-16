// The folwr answer, undone: Google's JSON guard and a newline, then chunks
// written as <hex length>;<payload>, each length in UTF-16 units (JavaScript
// string length; a UTF-8 or code point reading breaks on the first emoji).
// The payloads are JSON frames, a root of HTML, and fills: [6,"<id>","0"],
// the fill's HTML chunks, [9,null,"0"] and a marker chunk. Each fill replaces
// the <span data-async-ph="<id>"></span> it names, in the root or in another
// fill, as the page's script does.
//
// The HTML comes back as the filled tree, each fill in its placeholder's
// place, not as the fragments joined in arrival order. On the captures both
// read the same, but in arrival order a parent's closing tags come before its
// fills' content, so text a fill adds inside an answer block would land
// outside it. The filled tree keeps every element's real extent.
//
// Pure, and it logs nothing: the HTML holds the thread's questions and
// answers.

// 40 Mi UTF-16 units, about 90 turns at the 25-turn capture's 430,000 a
// turn. A body over it is not read at all.
export const FOLWR_TEXT_CAP = 40 * 1024 * 1024;

const GUARD = ")]}'\n";

// Up to 8 hex digits: a chunk of 4 Gi units is far past the cap anyway.
const MAX_LENGTH_DIGITS = 8;

// <ei>_stcn_<k>, <ei>_stcr_<k> or <ei>_stcc_<Name>_<k>.
const MARKER = /^[A-Za-z0-9_-]+_stc[a-z]_(?:[A-Za-z]+_)?\d+$/;

const PLACEHOLDER = /<span data-async-ph="([^"]*)"><\/span>/g;

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

// The payloads in order, or null when the body has no guard, a length is not
// hex or has no semicolon, or a length runs past the end. A walk that returns
// chunks ended exactly at the body's end.
function chunksOf(body: string): string[] | null {
  if (!body.startsWith(GUARD)) {
    return null;
  }
  const chunks: string[] = [];
  let at = GUARD.length;
  while (at < body.length) {
    let length = 0;
    let digits = 0;
    while (at < body.length && body.charCodeAt(at) !== 0x3b) {
      const digit = hexDigit(body.charCodeAt(at));
      if (digit < 0 || digits === MAX_LENGTH_DIGITS) {
        return null;
      }
      length = length * 16 + digit;
      digits += 1;
      at += 1;
    }
    if (digits === 0 || at >= body.length) {
      return null;
    }
    at += 1;
    if (length > body.length - at) {
      return null;
    }
    chunks.push(body.slice(at, at + length));
    at += length;
  }
  return chunks;
}

// A JSON frame, or null for a chunk that is not a JSON array (HTML, a marker,
// or text).
function frameOf(chunk: string): unknown[] | null {
  if (chunk.charCodeAt(0) !== 0x5b) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(chunk);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

interface Sorted {
  root: string;
  fills: Map<string, string>;
  // Chunks where only a fill or a data frame may come, and markers that are
  // not in the marker form.
  stray: number;
  endsOnMarker: boolean;
}

// Sorts the payloads into the root and the fills. The root is the HTML before
// its [9,null,"0"]; its marker chunk (empty in every capture) is skipped. A
// fill counts once its marker arrives; a fill cut before that is dropped.
function sort(chunks: readonly string[]): Sorted {
  const root: string[] = [];
  const fills = new Map<string, string>();
  let state: 'root' | 'root-marker' | 'between' | 'data' | 'fill' | 'fill-marker' = 'root';
  let id = '';
  let parts: string[] = [];
  let stray = 0;
  let endsOnMarker = false;
  for (const chunk of chunks) {
    endsOnMarker = false;
    const frame = frameOf(chunk);
    switch (state) {
      case 'root':
        // The header frame and [2,null,"0"] carry no HTML.
        if (frame === null) {
          root.push(chunk);
        } else if (frame[0] === 9) {
          state = 'root-marker';
        }
        break;
      case 'root-marker':
        state = 'between';
        break;
      case 'between':
        if (frame !== null && frame[0] === 6 && typeof frame[1] === 'string') {
          id = frame[1];
          parts = [];
          state = 'fill';
        } else if (frame !== null && frame[0] === 8) {
          state = 'data';
        } else if (frame === null) {
          stray += 1;
        }
        break;
      case 'data':
        state = 'between';
        break;
      case 'fill':
        if (frame !== null && frame[0] === 9) {
          state = 'fill-marker';
        } else {
          parts.push(chunk);
        }
        break;
      case 'fill-marker':
        if (MARKER.test(chunk)) {
          fills.set(id, (fills.get(id) ?? '') + parts.join(''));
          endsOnMarker = true;
        } else {
          stray += 1;
        }
        state = 'between';
        break;
    }
  }
  return { root: root.join(''), fills, stray, endsOnMarker };
}

// The root with each placeholder replaced by its fill, depth first. The stack
// is explicit: a long thread nests fills hundreds deep. A fill is placed once;
// a second copy of its placeholder stays an empty span. open counts the
// placeholders met that have no fill.
function expand(root: string, fills: ReadonlyMap<string, string>): { html: string; placed: number; open: number } {
  const out: string[] = [];
  const placed = new Set<string>();
  let open = 0;
  const stack: { text: string; at: number }[] = [{ text: root, at: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    PLACEHOLDER.lastIndex = top.at;
    const match = PLACEHOLDER.exec(top.text);
    if (match === null) {
      out.push(top.text.slice(top.at));
      stack.pop();
      continue;
    }
    out.push(top.text.slice(top.at, match.index));
    top.at = match.index + match[0].length;
    const id = match[1];
    const fill = fills.get(id);
    if (fill === undefined) {
      open += 1;
      out.push(match[0]);
    } else if (placed.has(id)) {
      out.push(match[0]);
    } else {
      placed.add(id);
      stack.push({ text: fill, at: 0 });
    }
  }
  return { html: out.join(''), placed: placed.size, open };
}

// The thread's HTML, and whether the stream was whole: the walk ended exactly
// at the body's end, at least one fill arrived, every placeholder met has a
// fill closed by its marker, every fill found its placeholder (else its HTML
// would be lost), nothing came between fills but fills and data frames, and
// the last chunk is a fill's marker. Null when the body is over the cap, has
// no guard, or a length cannot be read or runs past the end.
export function unchunk(body: string): { html: string; whole: boolean } | null {
  if (body.length > FOLWR_TEXT_CAP) {
    return null;
  }
  const chunks = chunksOf(body);
  if (chunks === null) {
    return null;
  }
  const { root, fills, stray, endsOnMarker } = sort(chunks);
  const { html, placed, open } = expand(root, fills);
  return { html, whole: fills.size > 0 && open === 0 && placed === fills.size && stray === 0 && endsOnMarker };
}
