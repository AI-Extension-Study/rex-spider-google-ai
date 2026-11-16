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

// ---- a thread's HTML ----
//
// The tags, classes and structural attributes below are the captured ones:
// a turn block holds the question heading, the display time and an empty
// scaffold whose main-col and rhs-col each hold a numeric container id; the
// answer and the aside arrive after it as data-sn-op blocks aimed at those
// ids, one of them the controls block. All text, URLs and ids are made up.

// A citation marker as the page shows it: the wrapper, an empty source link
// and the chip button.
export function citation(n: number): string {
  const uuid = `0000000${n}-made-up-uuid`;
  return `<span class="WBgIic Wg1cdb notranslate" data-suuid="nCd0md|${uuid}-|" jsaction="made-up"><span class="NMq1me" data-animation-atomic="true"><span aria-hidden="true"></span><span class=""><span class="">`
    + `<a class="PMDqCb" target="_blank" rel="noopener" aria-label="Example Source" href="https://example.org/source-${n}"></a>`
    + `<button tabindex="0" data-amic="true" data-icl-uuid="${uuid}" aria-label="Example Source (+2) - Related results" class="vDOt8c oy7Apc qu4n2c"><div class="S9OuHf"><img class="IpiY3d" src="data:image/png;base64,AAAA" alt=""><span class="dNwgB"><span class="QNca8b">Example Source</span><span class="OkUHJe">+2</span></span></div><div style="display:none"></div></button>`
    + '</span></span></span></span>';
}

// A marker the page's stylesheet collapses: a DHPVt wrapper, no link.
export function collapsedCitation(n: number): string {
  const uuid = `1000000${n}-made-up-uuid`;
  return `<span class="DHPVt Wg1cdb notranslate" data-suuid="nCd0md|${uuid}-|"><span class="NMq1me" data-animation-atomic="true"><span aria-hidden="true"></span><span class=""><span class="">`
    + `<button tabindex="0" data-amic="true" data-icl-uuid="${uuid}" aria-label="Example (+1)" class="vDOt8c"><span class="pxxQye T6UJT"><div class="a14YJe"><svg class="EQxvpc MZhYme" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1h2v2z"></path></svg></div></span></button>`
    + '</span></span></span></span>';
}

export const opBlock = (target: string, inner: string): string => `<div data-sn-op="2" data-target-container-id="${target}">${inner}</div>`;

export const paragraph = (html: string): string => `<div class="n6owBd awi2gc" data-sfc-cp="" jsaction="made-up">${html}</div>`;

// The controls block: copy, share and feedback buttons, and status text that
// is not part of the answer.
export const controlsInner = (): string => '<div data-xid="Gd7Hsc" data-sfc-cp=""><div class="DBd2Wb"><div class="zkL70c"><div class="RkJvxe" data-ignore-copy="">'
  + '<div class="HN5tSb" aria-live="polite" role="status"><span class="Ml3Lu">CONTROLS-TEXT status made up</span></div>'
  + '<div class="YHsVn"><button class="bKxaof" aria-label="Copy"><span class="D2ixAc">CONTROLS-TEXT copy</span></button></div>'
  + '<div class="Y0iQ5c">CONTROLS-TEXT try without personalization</div>'
  + '</div></div></div></div>';

// The aside: its header and the source list with two cards and "Show all".
export const asideBlocks = (aside: string): string[] => [
  `<div data-xid="a2jnbe" class="hjPQm J8zDPb"><div class="srOP7c" role="button"><h1 class="zeIqo">ASIDE-TEXT header</h1><div class="iZvXTd">ASIDE-TEXT sites</div></div></div>`,
  `<div class="IQTBxd notranslate" data-animation-skip="true" dir="ltr" data-xid="aim-aside-initial-corroboration-container"><div class="eFSEae"><ul class="hJYS7c">`
    + [1, 2].map((n) => `<li class="Ioqnib"><div class="cRH23c g7lqo sYLMkd" data-src-id="2_${n}" data-src-fp="false" data-crb-el="kXllB"><a class="vIWmYe" target="_blank" aria-label="ASIDE-TEXT card" href="https://example.com/card-${n}"></a><div class="Wgphwb"><span class="k0vrc">ASIDE-TEXT card source ${n}</span><div class="gpZmoc Hnm1Fe"><span>ASIDE-TEXT card title ${n}</span></div><span data-crb-snippet-text="">ASIDE-TEXT card snippet ${n}</span></div></div></li>`).join('')
    + '</ul><div class="U0Yrcf">ASIDE-TEXT Show all</div></div></div>',
].map((inner) => opBlock(aside, inner));

// The answer blocks of turn i, in the kinds the captures held: an empty
// block, hidden companions, a paragraph with a highlight and two markers, an
// hr, a heading, a list with a marker per item, and a paragraph naming a
// source by an inline link. answerText(i) is its visible text, written out
// by hand, and ANSWER_CITATIONS its markers.
export function answerInners(i: number): string[] {
  return [
    '<div class="yhAwj" data-sfc-cp=""></div>',
    '<span style="display:none" data-key="made-up" data-value="0"></span><div data-mstk="made-up" style="display:none" data-subtree="aimfl"></div>',
    paragraph(`Answer ${i} opens with <mark class="b6AQX">a made-up highlight</mark>.${citation(1)}${collapsedCitation(2)}`),
    '<div style="display:none" data-suuid="made-up" data-crb-el="Hrp5ac"><!-- made-up --></div>',
    '<hr class="s6NV4e">',
    '<div class="ZLzG0d ncoeY E8xBUb" role="heading" aria-level="4">A made-up heading</div>',
    `<ul class="XSq4R KI3fJ" data-sfc-cp=""><li class="Z1qcYe"><span class="iNqyIf"><strong class="rQesXe MPyX">First point:</strong> made-up <em class="zhvwWe">detail</em>.</span>${citation(3)}</li>`
      + `<li class="Z1qcYe"><span class="iNqyIf"><strong class="rQesXe MPyX">Second point:</strong> more detail.</span>${citation(4)}</li></ul>`,
    paragraph(`Read more at <span class="R78TQ"><span class="APwqaf"><a class="gQWhZ" target="_blank" href="https://example.net/named-source">the named source</a></span></span> today.${citation(5)}`),
  ];
}

export const answerText = (i: number): string => `Answer ${i} opens with a made-up highlight.\nA made-up heading\nFirst point: made-up detail.\nSecond point: more detail.\nRead more at the named source today.`;
export const ANSWER_CITATIONS = 5;

export interface TurnSpec {
  // The heading's whole text; the English label and the question by default.
  // Null leaves the h2 out.
  readonly heading?: string | null;
  readonly question?: string;
  // The answer blocks' inner HTML, the default answer when absent.
  readonly answer?: readonly string[];
  // How many controls blocks aim at the answer's container.
  readonly controls?: number;
  // The id under main-col: the turn's own numeric id by default; null leaves
  // main-col out.
  readonly mainId?: string | null;
}

export const LABEL = 'You said:';
export const question = (i: number): string => `Made-up question number ${i} about tomatoes?`;

// Turn i's numeric ids: 100 i + 6 under main-col, 100 i + 20 under rhs-col,
// and others in the scaffold, as the captures' ids never repeat.
const idOf = (i: number, offset: number) => String(100 * i + offset);

export function turnBlock(i: number, spec: TurnSpec = {}): string {
  const q = spec.question ?? question(i);
  const heading = spec.heading === undefined ? `${LABEL} ${q}` : spec.heading;
  const main = spec.mainId === undefined ? idOf(i, 6) : spec.mainId;
  const scaffold = (id: string) => `<div class="SGF5Lb" data-sfc-cp=""><div style="display:contents" data-container-id="${id}"></div><div style="display:none"></div></div>`;
  return `<div class="CKgc1d" data-scope-id="turn" jsname="CS7uPe" jsaction="made-up" jscontroller="made-up" data-sfc-root="">`
    + '<div style="display:contents"><div class="ilZyRc R7mRQb" data-rfsp="1">'
    + (heading === null ? '' : `<h2 class="iMqumd" data-rfsp="1">${heading}</h2>`)
    + '<div data-animation-skip="true"><div class="xEFZqe"><div class="tbIZh wQN2Jd Odbbif"><div class="AdmSkc"><div class="sUKAcb">'
    + `<span class="VndcI veK2kb" jsname="eFVkfb" tabindex="-1"><span jsname="y5v2y">${q}</span></span>`
    + '<div role="button" class="l1LGWd" aria-expanded="false" tabindex="0" style="display:none" aria-label="Expand"><div class="eacPZd"><svg class="EQxvpc" height="24" width="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 1h2v2z"></path></svg></div></div>'
    + '</div></div></div></div>'
    + '<div class="UYpEO"><div class="kwdzO">TIME-TEXT 9:41\u202fAM</div></div><div class="dcCF7d"></div></div>'
    + '</div></div>'
    + '<style data-ck="made-up">.made-up{color:red}</style>'
    + '<div data-subtree="aimc" data-sfc-cp=""><div class="Zkbeff" dir="ltr">'
    + '<h3 data-ignore-copy="" class="iMqumd" data-rfsp="1">AI Mode reply for made-up</h3>'
    + `<div class="pWvJNd"><div jsname="s7e4Od"><div style="display:contents" data-container-id="${idOf(i, 5)}"></div></div>`
    + (main === null ? '' : `<div dir="ltr" data-container-id="main-col" data-xid="VpUvz" jsname="KFl8ub" class="mZJni"><div style="display:contents" data-container-id="${main}"></div><div class="alk4p q4PqPb"><div class="IWPZAd"></div></div></div>`)
    + scaffold(idOf(i, 9)) + scaffold(idOf(i, 10))
    + '</div>'
    + `<div class="made-up"><div data-container-id="rhs-col" data-ignore-copy="" class="ofHStc OIPUDf"><div class="oRipZb"><div style="display:contents" data-container-id="${idOf(i, 20)}"></div></div></div></div>`
    + '<div data-xid="aQR2uf"></div>'
    + '<div class="qacuz Haco6c RVppL" role="alert"><button class="jqVAid RVppL">TIME-TEXT button</button></div>'
    + '</div></div></div>';
}

// Turn i as the stream's fills place it: the turn block, then its answer,
// aside and controls blocks with a style and a script between them.
export function turnPieces(i: number, spec: TurnSpec = {}): string[] {
  const main = spec.mainId ?? idOf(i, 6);
  const answer = (spec.answer ?? answerInners(i)).map((inner) => opBlock(main, inner));
  const [header, sources] = asideBlocks(idOf(i, 20));
  const controls = Array.from({ length: spec.controls ?? 1 }, () => opBlock(main, controlsInner()));
  return [
    '<style data-ck="made-up">.made-up{color:blue}</style>',
    turnBlock(i, spec),
    ...answer.slice(0, 2),
    header,
    ...answer.slice(2),
    '<script nonce="made-up">var madeUp = "SCRIPT-TEXT";</script>',
    sources,
    ...controls,
  ];
}

const ROOT_OPEN = `<div><div data-container-id="${EI}"></div><div eid="${EI}"></div><div>`;

// The filled tree of a thread with these turns.
export function threadHtml(turns: readonly TurnSpec[]): string {
  return `${ROOT_OPEN}${turns.flatMap((spec, i) => turnPieces(i + 1, spec)).join('')}</div></div>`;
}

// The same thread as a stream: the root holds the first placeholder and the
// empty one filled last, and each piece is a fill, cut in two chunks, that
// ends with the next piece's placeholder, so fills nest as deep as the
// pieces, as on long captures.
export function threadStream(turns: readonly TurnSpec[]): string {
  const pieces = turns.flatMap((spec, i) => turnPieces(i + 1, spec));
  const fills: Fill[] = pieces.map((piece, index) => {
    const html = piece + (index + 1 < pieces.length ? placeholder(index + 11) : '');
    const half = Math.floor(html.length / 2);
    return { n: index + 10, chunks: [html.slice(0, half), html.slice(half)] };
  });
  const root = `${ROOT_OPEN}${pieces.length > 0 ? placeholder(10) : ''}</div>${placeholder(8)}</div>`;
  return streamBody(streamChunks([root], [...fills, { n: 8, chunks: [''] }]));
}
