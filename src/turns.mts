// The turns of one AI Mode thread, read from the filled HTML of its folwr
// answer (stream.mts) by string scanning: an MV3 service worker has no DOM
// parser. One pass over the tags keeps a stack of open elements and gathers
// what the counts need; nothing of the text leaves this file but counts.
//
// Each div[data-scope-id="turn"] is one exchange, a question then an answer,
// in document order. The question is the turn's h2[data-rfsp] heading after
// its label: everything up to and including the heading's first colon ("You
// said:", "Du hast Folgendes gesagt:"). The h3 reply heading carries
// data-rfsp too, so only h2 counts. The answer is not in the turn block: its
// main-col holds an empty container whose numeric id the answer's
// data-sn-op blocks name in data-target-container-id, and the page's script
// moves them there. One of those blocks holds the copy, share and feedback
// controls (a child with data-xid="Gd7Hsc") and is not part of the answer.
// The aside's blocks name the rhs-col's id, so its source cards never reach
// the answer.
//
// Pure, and it logs nothing.
import type { AimTurn, ParsedThread } from './record.mts';
import { countText } from './text.mts';

// Elements whose content is text up to their closing tag. None of it is
// visible text here, so it is skipped unread.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'noscript']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Elements whose edges break a line in the visible text.
const BLOCK = new Set(['div', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'section', 'blockquote', 'pre']);
// Subtrees left out of the visible text, with hidden ones and the citation
// wrappers. Buttons are the citation chips and the controls.
const SKIP = new Set(['script', 'style', 'svg', 'button', 'template', 'noscript', 'textarea']);
const HIDES = /display\s*:\s*none|visibility\s*:\s*hidden/i;

// The inline citation marker: span[data-suuid^="nCd0md|"].
const MARKER_PREFIX = 'nCd0md|';
const CONTROLS_XID = 'Gd7Hsc';
const NUMERIC_ID = /^[0-9]+$/;

// ---- entities ----

const NAMED = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0'], ['ensp', '\u2002'], ['emsp', '\u2003'],
  ['thinsp', '\u2009'], ['shy', '\u00ad'], ['zwnj', '\u200c'], ['zwj', '\u200d'], ['lrm', '\u200e'], ['rlm', '\u200f'], ['ndash', '\u2013'],
  ['mdash', '\u2014'], ['hellip', '\u2026'], ['lsquo', '\u2018'], ['rsquo', '\u2019'], ['ldquo', '\u201c'], ['rdquo', '\u201d'],
  ['laquo', '\u00ab'], ['raquo', '\u00bb'], ['bull', '\u2022'], ['middot', '\u00b7'], ['deg', '\u00b0'], ['times', '\u00d7'],
  ['divide', '\u00f7'], ['plusmn', '\u00b1'], ['frac12', '\u00bd'], ['frac14', '\u00bc'], ['frac34', '\u00be'], ['copy', '\u00a9'],
  ['reg', '\u00ae'], ['trade', '\u2122'], ['euro', '\u20ac'], ['pound', '\u00a3'], ['cent', '\u00a2'], ['yen', '\u00a5'], ['sect', '\u00a7'],
  ['para', '\u00b6'], ['micro', '\u00b5'], ['iexcl', '\u00a1'], ['iquest', '\u00bf'],
]);

const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

// Numeric references to no character (0, a surrogate, past U+10FFFF) read
// as U+FFFD, as in a browser. An unknown name is left as written.
function decode(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(ENTITY, (whole: string, body: string) => {
    if (body[0] !== '#') {
      return NAMED.get(body) ?? whole;
    }
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
  });
}

// ---- tags ----

interface Visitor {
  // Attribute values as written; the caller decodes the few it reads. empty
  // is a void element or one closed by "/>".
  open(name: string, attrs: ReadonlyMap<string, string>, empty: boolean): void;
  close(name: string): void;
  text(raw: string): void;
}

const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
const isLetter = (code: number) => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
const isNameChar = (code: number) => isLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d;

const rawEnds = new Map([...RAW_TEXT].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])`, 'gi')]));

// Where a raw text element's content ends: its closing tag, or the end.
function rawEnd(html: string, name: string, from: number): number {
  const end = rawEnds.get(name);
  if (end === undefined) {
    return from;
  }
  end.lastIndex = from;
  return end.exec(html)?.index ?? html.length;
}

// One pass over the tags, comments skipped. A '<' that starts no tag is text.
// The first of two attributes of the same name wins, as in a browser.
function scan(html: string, on: Visitor): void {
  const length = html.length;
  let at = 0;
  while (at < length) {
    const lt = html.indexOf('<', at);
    if (lt < 0) {
      on.text(html.slice(at));
      return;
    }
    if (lt > at) {
      on.text(html.slice(at, lt));
    }
    at = lt;
    if (html.startsWith('<!--', at)) {
      const close = html.indexOf('-->', at + 4);
      at = close < 0 ? length : close + 3;
      continue;
    }
    const next = html.charCodeAt(at + 1);
    if (next === 0x21 || next === 0x3f) {
      const close = html.indexOf('>', at);
      at = close < 0 ? length : close + 1;
      continue;
    }
    const closing = next === 0x2f;
    let cursor = at + (closing ? 2 : 1);
    if (!isLetter(html.charCodeAt(cursor))) {
      on.text('<');
      at += 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < length && isNameChar(html.charCodeAt(cursor))) {
      cursor += 1;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (cursor < length) {
      const code = html.charCodeAt(cursor);
      if (isSpace(code)) {
        cursor += 1;
      } else if (code === 0x3e) {
        cursor += 1;
        break;
      } else if (code === 0x2f && html.charCodeAt(cursor + 1) === 0x3e) {
        selfClosing = true;
        cursor += 2;
        break;
      } else if (code === 0x2f || code === 0x3d) {
        cursor += 1;
      } else {
        const attrStart = cursor;
        while (cursor < length) {
          const c = html.charCodeAt(cursor);
          if (isSpace(c) || c === 0x3d || c === 0x3e || c === 0x2f) {
            break;
          }
          cursor += 1;
        }
        const attrName = html.slice(attrStart, cursor).toLowerCase();
        let probe = cursor;
        while (probe < length && isSpace(html.charCodeAt(probe))) {
          probe += 1;
        }
        let value = '';
        if (html.charCodeAt(probe) === 0x3d) {
          probe += 1;
          while (probe < length && isSpace(html.charCodeAt(probe))) {
            probe += 1;
          }
          const quote = html.charCodeAt(probe);
          if (quote === 0x22 || quote === 0x27) {
            const end = html.indexOf(quote === 0x22 ? '"' : "'", probe + 1);
            value = html.slice(probe + 1, end < 0 ? length : end);
            cursor = end < 0 ? length : end + 1;
          } else {
            let end = probe;
            while (end < length && !isSpace(html.charCodeAt(end)) && html.charCodeAt(end) !== 0x3e) {
              end += 1;
            }
            value = html.slice(probe, end);
            cursor = end;
          }
        }
        if (!attrs.has(attrName)) {
          attrs.set(attrName, value);
        }
      }
    }
    at = cursor;
    if (closing) {
      on.close(name);
      continue;
    }
    on.open(name, attrs, selfClosing || VOID.has(name));
    if (!selfClosing && RAW_TEXT.has(name)) {
      at = rawEnd(html, name, at);
    }
  }
}

// ---- links ----

// google.com and its subdomains; google.<country> (google.de, google.co.uk,
// google.com.au) and theirs; subdomains of Google's content hosts.
const GOOGLE = /^(?:[a-z0-9-]+\.)*google\.(?:com|(?:com?\.)?[a-z]{2})$/;
const GOOGLE_CONTENT = /^(?:[a-z0-9-]+\.)+(?:gstatic|googleusercontent|googleapis)\.com$/;

// An http or https URL to a host that is not Google's. A relative link
// resolves against the page, www.google.com. A link that cannot be read is
// external when it starts like a web address, so it errs toward a null count.
function isExternal(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href, 'https://www.google.com/');
  } catch {
    return /^\s*(?:https?:)?\/\//i.test(href);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname.replace(/\.$/, '');
  return !GOOGLE.test(host) && !GOOGLE_CONTENT.test(host);
}

// ---- the pass ----

// One data-sn-op block: its visible text and what the counts need.
interface Block {
  readonly target: string | null;
  readonly depth: number;
  parts: string[];
  text: string;
  markers: number;
  external: boolean;
  controls: boolean;
}

interface Turn {
  // The first h2[data-rfsp]'s text pieces, null when the turn has none.
  heading: string[] | null;
  // The first data-container-id under main-col, null when none was found.
  main: string | null;
  mainState: 'before' | 'inside' | 'done';
}

interface Open {
  readonly name: string;
  readonly skip: boolean;
  readonly block: Block | null;
  readonly turn: Turn | null;
  readonly heading: Turn | null;
  readonly mainCol: Turn | null;
}

const BREAK = /\n\s*/g;
const isLineSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0c;

// Each line break, with the spaces and tabs before it and all whitespace
// after it, becomes one; none at either end. It reads as
// /[ \t\r\f]*\n\s*/g -> '\n' would, but in linear time: that regex
// backtracks over every run of spaces not followed by a line break, and
// 200,000 spaces take it 15 s.
function lines(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(BREAK)) {
    let end = match.index;
    while (end > last && isLineSpace(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    out.push(text.slice(last, end), '\n');
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  const joined = out.join('');
  let start = 0;
  let stop = joined.length;
  while (start < stop && joined.charCodeAt(start) === 0x0a) {
    start += 1;
  }
  while (stop > start && joined.charCodeAt(stop - 1) === 0x0a) {
    stop -= 1;
  }
  return joined.slice(start, stop);
}

interface Scanned {
  turns: Turn[];
  blocks: Map<string, Block[]>;
  headings: number;
}

function walk(html: string): Scanned {
  const stack: Open[] = [];
  // How many elements of each name are open, so a closing tag that matches
  // none is dropped without searching the stack.
  const openNames = new Map<string, number>();
  // The stack indexes of open skipped elements, in increasing order.
  const skips: number[] = [];
  const openBlocks: Block[] = [];
  const openTurns: Turn[] = [];
  const turns: Turn[] = [];
  const blocks = new Map<string, Block[]>();
  let heading: { turn: Turn; depth: number } | null = null;
  let headings = 0;

  // Text inside the element at stack index depth is visible to it when no
  // skipped element is open at or below it.
  const visibleTo = (depth: number) => skips.length === 0 || skips[skips.length - 1] < depth;

  // Text goes to the innermost answer block, and to the question heading,
  // each when it is visible there.
  const add = (text: string) => {
    const block = openBlocks[openBlocks.length - 1];
    if (block !== undefined && visibleTo(block.depth)) {
      block.parts.push(text);
    }
    if (heading !== null && visibleTo(heading.depth)) {
      heading.turn.heading?.push(text);
    }
  };

  const closeTo = (index: number) => {
    while (stack.length > index) {
      const depth = stack.length - 1;
      const element = stack[depth];
      if (BLOCK.has(element.name) && !element.skip) {
        add('\n');
      }
      stack.pop();
      openNames.set(element.name, (openNames.get(element.name) ?? 1) - 1);
      if (element.skip) {
        skips.pop();
      }
      if (element.block !== null) {
        openBlocks.pop();
        element.block.text = lines(element.block.parts.join(''));
        element.block.parts = [];
        if (element.block.target !== null) {
          const list = blocks.get(element.block.target) ?? [];
          list.push(element.block);
          blocks.set(element.block.target, list);
        }
      }
      if (element.turn !== null) {
        openTurns.pop();
      }
      if (element.heading !== null) {
        heading = null;
      }
      if (element.mainCol !== null && element.mainCol.mainState === 'inside') {
        element.mainCol.mainState = 'done';
      }
    }
  };

  scan(html, {
    open(name, attrs, empty) {
      const depth = stack.length;
      const read = (key: string): string | undefined => {
        const value = attrs.get(key);
        return value === undefined ? undefined : decode(value);
      };
      const style = read('style');
      const marker = name === 'span' && (read('data-suuid') ?? '').startsWith(MARKER_PREFIX);
      const skip = SKIP.has(name) || attrs.has('hidden') || (style !== undefined && HIDES.test(style)) || marker;

      // The controls block is the one with a child carrying the controls'
      // data-xid.
      const parent = stack[depth - 1];
      if (parent?.block && read('data-xid') === CONTROLS_XID) {
        parent.block.controls = true;
      }
      const inBlock = openBlocks[openBlocks.length - 1];
      if (inBlock !== undefined) {
        if (marker) {
          inBlock.markers += 1;
        }
        const href = name === 'a' ? read('href') : undefined;
        if (href !== undefined && isExternal(href)) {
          inBlock.external = true;
        }
      }

      const turnHere = openTurns[openTurns.length - 1];
      let turn: Turn | null = null;
      if (read('data-scope-id') === 'turn') {
        turn = { heading: null, main: null, mainState: 'before' };
        turns.push(turn);
      }
      let headingOf: Turn | null = null;
      if (name === 'h2' && attrs.has('data-rfsp')) {
        headings += 1;
        if (turnHere !== undefined && turnHere.heading === null && heading === null) {
          turnHere.heading = [];
          heading = { turn: turnHere, depth };
          headingOf = turnHere;
        }
      }
      let mainCol: Turn | null = null;
      const container = read('data-container-id');
      if (container !== undefined && turnHere !== undefined) {
        if (turnHere.mainState === 'inside') {
          turnHere.main = container;
          turnHere.mainState = 'done';
        } else if (turnHere.mainState === 'before' && container === 'main-col') {
          turnHere.mainState = 'inside';
          mainCol = turnHere;
        }
      }
      let block: Block | null = null;
      if (attrs.has('data-sn-op')) {
        block = { target: read('data-target-container-id') ?? null, depth, parts: [], text: '', markers: 0, external: false, controls: false };
        openBlocks.push(block);
      }
      if (turn !== null) {
        openTurns.push(turn);
      }

      if (BLOCK.has(name) && !skip) {
        add('\n');
      }
      stack.push({ name, skip, block, turn, heading: headingOf, mainCol });
      openNames.set(name, (openNames.get(name) ?? 0) + 1);
      if (skip) {
        skips.push(depth);
      }
      if (empty) {
        closeTo(depth);
      }
    },
    close(name) {
      if ((openNames.get(name) ?? 0) === 0) {
        return;
      }
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].name === name) {
          closeTo(index);
          return;
        }
      }
    },
    text(raw) {
      if (openBlocks.length > 0 || heading !== null) {
        add(decode(raw));
      }
    },
  });
  closeTo(0);
  return { turns, blocks, headings };
}

// ---- turns ----

type Counts = { chars: number; words: number };

// The heading's text after the first colon, or null with no colon.
function questionOf(turn: Turn): Counts | null {
  if (turn.heading === null) {
    return null;
  }
  const text = turn.heading.join('').replace(/\s+/g, ' ').trim();
  const colon = text.indexOf(':');
  return colon < 0 ? null : countText(text.slice(colon + 1).trim());
}

// The answer body: the blocks aimed at the turn's numeric container, minus
// the one controls block. Not found (null) when the turn has no numeric id,
// shares its id with another turn, has not exactly one controls block, or
// has no other block. Its text is the blocks' visible texts, one line break
// between them.
function answerOf(turn: Turn, scanned: Scanned, uses: ReadonlyMap<string, number>): { counts: Counts; citations: number | null } | null {
  if (turn.main === null || !NUMERIC_ID.test(turn.main) || uses.get(turn.main) !== 1) {
    return null;
  }
  const all = scanned.blocks.get(turn.main) ?? [];
  const body = all.filter((block) => !block.controls);
  if (all.length - body.length !== 1 || body.length === 0) {
    return null;
  }
  const text = body.map((block) => block.text).filter((part) => part !== '').join('\n');
  const markers = body.reduce((sum, block) => sum + block.markers, 0);
  // With no marker at all, every link is outside every marker: an external
  // one means the answer cites in a way the count cannot see.
  const external = body.some((block) => block.external);
  return { counts: countText(text), citations: markers > 0 ? markers : external ? null : 0 };
}

const turnOf = (speaker: 'user' | 'assistant', counts: Counts | null, citations: number | null): AimTurn => ({
  identifier: null,
  parent: null,
  speaker,
  when: null,
  on_current_branch: true,
  text_chars: counts === null ? null : counts.chars,
  text_words: counts === null ? null : counts.words,
  citation_count: citations,
  search_result_count: null,
  attachments: null,
});

// Every turn block's question and answer, in document order. complete only
// when there is at least one block, every block gave its question and its
// answer body, and the h2[data-rfsp] headings number the blocks. Whether the
// stream was whole is the caller's to add.
export function parseTurns(html: string): ParsedThread {
  const scanned = walk(html);
  const uses = new Map<string, number>();
  for (const turn of scanned.turns) {
    if (turn.main !== null) {
      uses.set(turn.main, (uses.get(turn.main) ?? 0) + 1);
    }
  }
  const turns: AimTurn[] = [];
  let complete = scanned.turns.length > 0 && scanned.headings === scanned.turns.length;
  for (const turn of scanned.turns) {
    const asked = questionOf(turn);
    const answer = answerOf(turn, scanned, uses);
    complete = complete && asked !== null && answer !== null;
    turns.push(turnOf('user', asked, 0), turnOf('assistant', answer === null ? null : answer.counts, answer === null ? null : answer.citations));
  }
  return { turns, blocks: scanned.turns.length, complete };
}
