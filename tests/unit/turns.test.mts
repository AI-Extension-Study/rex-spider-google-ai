import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AimTurn, ParsedThread } from '../../src/record.mts';
import { unchunk } from '../../src/stream.mts';
import { countText } from '../../src/text.mts';
import { parseTurns } from '../../src/turns.mts';
import { ANSWER_CITATIONS, LABEL, type TurnSpec, answerInners, answerText, citation, collapsedCitation, controlsInner, opBlock, paragraph, question, threadHtml, threadStream } from './thread-fixtures.mts';

const TURN_KEYS = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments'];

function user(text: string | null): AimTurn {
  const counts = text === null ? null : countText(text);
  return {
    identifier: null, parent: null, speaker: 'user', when: null, on_current_branch: true,
    text_chars: counts?.chars ?? null, text_words: counts?.words ?? null, citation_count: 0, search_result_count: null, attachments: null,
  };
}

function assistant(text: string | null, citations: number | null): AimTurn {
  const counts = text === null ? null : countText(text);
  return {
    identifier: null, parent: null, speaker: 'assistant', when: null, on_current_branch: true,
    text_chars: counts?.chars ?? null, text_words: counts?.words ?? null, citation_count: citations, search_result_count: null, attachments: null,
  };
}

// The turns a thread of default turns gives: each question after its label,
// each answer's hand-written text and its markers.
const defaultTurns = (count: number): AimTurn[] => Array.from({ length: count }, (_, at) => [user(question(at + 1)), assistant(answerText(at + 1), ANSWER_CITATIONS)]).flat();

// Every turn has exactly the ten keys in order, a speaker of the two, and
// nothing but numbers and nulls in its counts.
function wellFormed(thread: ParsedThread): ParsedThread {
  for (const turn of thread.turns) {
    assert.deepEqual(Object.keys(turn), TURN_KEYS);
    assert.ok(turn.speaker === 'user' || turn.speaker === 'assistant');
  }
  return thread;
}

// Extra HTML at the end of the thread, inside its root.
const beforeEnd = (html: string, extra: string): string => {
  assert.ok(html.endsWith('</div></div>'));
  return `${html.slice(0, -'</div></div>'.length)}${extra}</div></div>`;
};

const parse = (turns: readonly TurnSpec[]): ParsedThread => wellFormed(parseTurns(threadHtml(turns)));

// One turn whose answer is these blocks, read for its assistant turn.
const answerOf = (blocks: readonly string[], spec: TurnSpec = {}): AimTurn => parse([{ ...spec, answer: blocks }]).turns[1];

for (const count of [1, 2, 5]) {
  test(`${count} turn block(s) give ${2 * count} turns, a question then an answer each, in order`, () => {
    const thread = parse(Array.from({ length: count }, () => ({})));
    assert.deepEqual(thread, { turns: defaultTurns(count), blocks: count, complete: true });
  });
}

test('the stream of a 5-turn thread gives the same turns as its filled tree', () => {
  const turns = Array.from({ length: 5 }, () => ({}));
  const stream = unchunk(threadStream(turns));
  assert.ok(stream !== null && stream.whole);
  assert.equal(stream.html, threadHtml(turns));
  assert.deepEqual(parseTurns(stream.html), { turns: defaultTurns(5), blocks: 5, complete: true });
});

test('turns follow document order, not the numbers in their ids', () => {
  const thread = parse([{ question: 'Short?' }, { question: 'A much longer made-up second question?' }]);
  assert.deepEqual(thread.turns.map((turn) => turn.speaker), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(thread.turns[0].text_chars, 6);
  assert.equal(thread.turns[2].text_chars, 38);
});

test('the question counts leave out the English label', () => {
  assert.deepEqual(parse([{ heading: `${LABEL} How tall do made-up plants grow?` }]).turns[0], user('How tall do made-up plants grow?'));
});

test('the question counts leave out the German label', () => {
  const thread = parse([{ heading: 'Du hast Folgendes gesagt: Wie hoch wachsen erfundene Pflanzen?' }]);
  assert.deepEqual(thread.turns[0], user('Wie hoch wachsen erfundene Pflanzen?'));
  assert.equal(thread.complete, true);
});

test('a question keeps a colon of its own after the label', () => {
  assert.deepEqual(parse([{ heading: `${LABEL} Ratio: how much made-up water?` }]).turns[0], user('Ratio: how much made-up water?'));
});

test('a heading with no label gives null question counts and an incomplete thread', () => {
  const thread = parse([{ heading: 'You said nothing like a label here' }, {}]);
  assert.deepEqual(thread.turns[0], user(null));
  assert.deepEqual(thread.turns.slice(1), [assistant(answerText(1), ANSWER_CITATIONS), ...defaultTurns(2).slice(2)]);
  assert.equal(thread.complete, false);
});

test('a turn block with no heading gives null question counts and an incomplete thread', () => {
  const thread = parse([{ heading: null }, {}]);
  assert.deepEqual(thread.turns[0], user(null));
  assert.equal(thread.blocks, 2);
  assert.equal(thread.complete, false);
});

test('an h2 heading outside every turn block makes headings and blocks disagree', () => {
  const html = beforeEnd(threadHtml([{}, {}]), '<h2 class="iMqumd" data-rfsp="1">You said: made-up stray</h2>');
  const thread = parseTurns(html);
  assert.deepEqual(thread.turns, defaultTurns(2));
  assert.equal(thread.complete, false);
});

test('the hidden h3 reply heading is not read as a question', () => {
  const thread = parse([{ heading: null }]);
  assert.equal(thread.turns[0].text_chars, null);
});

const MISSING: [string, TurnSpec][] = [
  ['no answer blocks aim at the container', { answer: [], controls: 0 }],
  ['no controls block', { controls: 0 }],
  ['two controls blocks', { controls: 2 }],
  ['only the controls block', { answer: [] }],
  ['no main-col', { mainId: null }],
  ['an id under main-col that is not numeric', { mainId: 'made-up-id' }],
];

for (const [name, spec] of MISSING) {
  test(`${name}: the answer body is not found, its counts are null and the thread incomplete`, () => {
    const thread = parse([{}, spec, {}]);
    assert.deepEqual(thread.turns[3], assistant(null, null));
    assert.deepEqual(thread.turns[2], user(question(2)));
    assert.deepEqual(thread.turns.slice(4), defaultTurns(3).slice(4));
    assert.deepEqual(thread.turns.slice(0, 2), defaultTurns(1));
    assert.equal(thread.blocks, 3);
    assert.equal(thread.complete, false);
  });
}

test('two turns under the same numeric id both lose their answer', () => {
  // Turn 1 has no blocks of its own, so without the rule it would take
  // turn 2's.
  const thread = parse([{ mainId: '777', answer: [], controls: 0 }, { mainId: '777' }, {}]);
  assert.deepEqual([thread.turns[1], thread.turns[3]], [assistant(null, null), assistant(null, null)]);
  assert.deepEqual(thread.turns[5], assistant(answerText(3), ANSWER_CITATIONS));
  assert.equal(thread.complete, false);
});

test('a thread with no turn blocks is never complete', () => {
  for (const html of ['', '<div></div>', threadHtml([])]) {
    assert.deepEqual(parseTurns(html), { turns: [], blocks: 0, complete: false });
  }
});

test('the answer text leaves out the display time, buttons, the source cards, the controls and scripts', () => {
  const text = JSON.stringify(parseTurns(threadHtml([{}])));
  assert.deepEqual(parseTurns(threadHtml([{}])).turns[1], assistant(answerText(1), ANSWER_CITATIONS));
  // The fixture puts these words only where the answer must not reach.
  const html = threadHtml([{}]);
  for (const word of ['TIME-TEXT', 'ASIDE-TEXT', 'CONTROLS-TEXT', 'SCRIPT-TEXT', 'Example Source']) {
    assert.ok(html.includes(word), `the fixture lacks ${word}`);
  }
  assert.equal(text.includes('TEXT'), false);
});

test('the visible text leaves out hidden elements, scripts, styles, svg, templates, noscript and textarea', () => {
  const hidden = [
    '<span hidden>HIDDEN-attribute</span>', '<span style="display: none">HIDDEN-style</span>', '<span style="color:red;visibility:hidden">HIDDEN-visibility</span>',
    '<script>HIDDEN-script</script>', '<style>.HIDDEN-style{}</style>', '<svg><text>HIDDEN-svg</text></svg>', '<template><p>HIDDEN-template</p></template>',
    '<noscript>HIDDEN-noscript</noscript>', '<textarea>HIDDEN-textarea</textarea>', '<button>HIDDEN-button</button>', '<div hidden=""><p>HIDDEN-nested <b>deep</b></p></div>',
  ];
  const turn = answerOf([paragraph(`Visible ${hidden.join('')}words only.`)]);
  assert.deepEqual(turn, assistant('Visible words only.', 0));
});

test('a visible element inside a hidden one stays hidden, and text after a hidden one is visible', () => {
  const turn = answerOf([paragraph('One <span style="display:none">gone <b style="display:inline">still gone</b></span>two'), paragraph('<div hidden><p>gone</p></div>three'), paragraph('in<div hidden>gone</div>line')]);
  assert.deepEqual(turn, assistant('One two\nthree\ninline', 0));
});

test('entities in the answer and the question are decoded before counting', () => {
  const thread = parse([{ heading: `${LABEL} Salt &amp; pepper?`, answer: [paragraph('Fish &amp; chips&nbsp;&#8212; &#x1F345; &quot;fresh&quot; &lt;tag&gt; &#39;ok&#39;')] }]);
  assert.deepEqual(thread.turns[0], user('Salt & pepper?'));
  assert.deepEqual(thread.turns[1], assistant('Fish & chips\u00a0\u2014 \u{1F345} "fresh" <tag> \'ok\'', 0));
});

test('an unknown entity name is kept as written, and a reference to no character reads as U+FFFD', () => {
  assert.deepEqual(answerOf([paragraph('a &madeupname; b &#0; c &#xD800;')]), assistant('a &madeupname; b \ufffd c \ufffd', 0));
});

test('blocks and block elements are separated by one line break, and runs of blank lines collapse', () => {
  const turn = answerOf([paragraph('First line'), '<div class="yhAwj"></div>', paragraph('<p>Second</p><p>Third <br>Fourth</p>')]);
  assert.deepEqual(turn, assistant('First line\nSecond\nThird\nFourth', 0));
});

test('text inside a citation wrapper is left out, outside its button too', () => {
  const marker = '<span class="WBgIic Wg1cdb notranslate" data-suuid="nCd0md|made-up-|">wrapper words<span>more</span><button>chip</button></span>';
  assert.deepEqual(answerOf([paragraph(`Cited.${marker} After.`)]), assistant('Cited. After.', 1));
});

test('a long run of spaces is read in linear time', () => {
  // A backtracking line rule takes about 30 s on this; a linear one a few ms.
  const run = ' '.repeat(300_000);
  const started = Date.now();
  const turn = answerOf([paragraph(`Wide${run}gap ${run}\n${run}next`)]);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.deepEqual(turn, assistant(`Wide${run}gap\nnext`, 0));
});

test('closing tags that match no open element are read in linear time, under many open ones', () => {
  // Searching the whole stack for each stray close takes about 11 s here.
  const started = Date.now();
  const turn = answerOf([paragraph(`${'<span>'.repeat(100_000)}kept${'</p>'.repeat(100_000)}`)]);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(turn.text_chars, 4);
});

test('citation_count counts every marker, collapsed or not, inside hidden parts too', () => {
  const turn = answerOf([paragraph(`One.${citation(1)}${collapsedCitation(2)}`), `<div style="display:none">${citation(3)}</div>`, paragraph(`Two.${collapsedCitation(4)}`)]);
  assert.deepEqual(turn, assistant('One.\nTwo.', 4));
});

test('markers in the aside or the controls block do not count', () => {
  const aside = opBlock('120', paragraph(`Aside${citation(1)}`));
  const controls = opBlock('106', controlsInner().replace('</div></div></div></div>', `${citation(2)}</div></div></div></div>`));
  const html = beforeEnd(threadHtml([{ answer: [paragraph('Plain answer.')], controls: 0 }]), `${aside}${controls}`);
  const thread = parseTurns(html);
  assert.deepEqual(thread.turns[1], assistant('Plain answer.', 0));
  assert.equal(thread.complete, true);
});

test('with no marker, an external link outside every marker makes citation_count null', () => {
  const turn = answerOf([paragraph('See <a class="gQWhZ" href="https://example.net/page">this made-up site</a> now.')]);
  assert.deepEqual(turn, assistant('See this made-up site now.', null));
});

test('with markers, an external link outside them does not change the count', () => {
  const turn = answerOf([paragraph(`See <a href="https://example.net/page">a site</a>.${citation(1)}`)]);
  assert.equal(turn.citation_count, 1);
});

const HREFS: [string, boolean][] = [
  ['https://example.net/a', true],
  ['http://example.net/a', true],
  ['https://www.youtube.com/watch?v=made-up', true],
  ['//example.net/protocol-relative', true],
  ['HTTPS://EXAMPLE.NET/upper', true],
  ['https://notgoogle.com/x', true],
  ['https://google.com.example.net/x', true],
  ['https://exa mple.net/unreadable', true],
  ['https://www.google.com/search?q=made-up&amp;kgmid=/m/0', false],
  ['https://google.com/maps', false],
  ['https://maps.google.com/x', false],
  ['https://www.google.de/search?q=x', false],
  ['https://www.google.co.uk/x', false],
  ['https://www.google.com.au/x', false],
  ['https://fonts.gstatic.com/x', false],
  ['https://gstatic.com/x', false],
  ['https://googleusercontent.com/x', false],
  ['https://googleapis.com/x', false],
  ['https://www.google.com./x', false],
  ['https://example.net./x', true],
  ['https://notgstatic.com/x', true],
  ['https://lh3.googleusercontent.com/x', false],
  ['https://www.googleapis.com/x', false],
  ['/search?q=made-up', false],
  ['search?q=made-up', false],
  ['#fragment', false],
  ['mailto:someone@example.net', false],
  ['javascript:void(0)', false],
  ['', false],
];

for (const [href, external] of HREFS) {
  test(`with no marker, a link to ${JSON.stringify(href)} gives citation_count ${external ? 'null' : '0'}`, () => {
    assert.equal(answerOf([paragraph(`Link <a href="${href}">here</a>.`)]).citation_count, external ? null : 0);
  });
}

test('a link with no href, or an external link outside the answer body, does not make the count null', () => {
  assert.equal(answerOf([paragraph('An <a name="x">anchor</a>.')]).citation_count, 0);
  const html = threadHtml([{ answer: [paragraph('Plain.')] }]);
  assert.match(html, /href="https:\/\/example\.com\/card-1"/);
  assert.equal(parseTurns(html).turns[1].citation_count, 0);
});

test('search_result_count and attachments are null on every turn', () => {
  const thread = parse([{}, { heading: 'no label' }, { controls: 0 }]);
  assert.equal(thread.turns.length, 6);
  for (const turn of thread.turns) {
    assert.equal(turn.search_result_count, null);
    assert.equal(turn.attachments, null);
  }
});

test('markers planted in every attribute, script, style and comment change no count and reach no output', () => {
  const PLANT = 'PLANTED-MARKER';
  const base = threadHtml([{}, {}]);
  const planted = base
    .replace(/<([a-z][a-z0-9]*)(?=[\s>])/g, `<$1 data-planted="${PLANT}-attr" title="${PLANT}-title"`)
    .replace(/<script([^>]*)>/g, `<script$1>var planted = "${PLANT}-script";`)
    .replace(/<style([^>]*)>/g, `<style$1>.planted::after{content:"${PLANT}-style"}`)
    .replace(/<!--/g, `<!-- ${PLANT}-comment`);
  assert.ok(planted.split(PLANT).length > 100, 'Test setup invalid: too few markers planted');
  const thread = parseTurns(planted);
  assert.deepEqual(thread, parseTurns(base));
  const text = JSON.stringify(thread);
  for (const word of [PLANT, 'Made-up', 'made-up', 'tomatoes', 'Answer', 'example']) {
    assert.equal(text.includes(word), false, `the output holds ${word}`);
  }
});

test('the answer of a turn whose blocks come before its turn block is still found', () => {
  const html = threadHtml([{ answer: [], controls: 0 }]).replace('<div class="CKgc1d"', `${opBlock('106', paragraph('Early answer.'))}${opBlock('106', controlsInner())}<div class="CKgc1d"`);
  assert.deepEqual(parseTurns(html).turns[1], assistant('Early answer.', 0));
});

// ---- fix round 1: the parser's edges ----

test('an h2 without data-rfsp is neither the question nor a heading that counts', () => {
  const thread = parse([{ answer: [paragraph('Before.'), '<h2 class="made-up">A plain heading</h2>', paragraph('After.')] }]);
  assert.deepEqual(thread.turns[1], assistant('Before.\nA plain heading\nAfter.', 0));
  assert.equal(thread.complete, true);
  const html = threadHtml([{}]).replace('<h2 class="iMqumd" data-rfsp="1">', '<h2 class="made-up">Not this: one</h2><h2 class="iMqumd" data-rfsp="1">');
  assert.deepEqual(parseTurns(html).turns[0], user(question(1)));
});

test('attribute values are decoded where the rules read them', () => {
  assert.equal(answerOf([paragraph('Link <a href="https&#58;//example.net/x">here</a>.')]).citation_count, null);
  assert.deepEqual(answerOf([paragraph('Cited.<span data-suuid="nCd0md&#124;made-up-|">wrapped</span>')]), assistant('Cited.', 1));
  assert.deepEqual(answerOf([paragraph('Shown <span style="display&#58;none">gone</span>text.')]), assistant('Shown text.', 0));
  const html = threadHtml([{}]).replace('data-scope-id="turn"', 'data-scope-id="t&#117;rn"').replace('data-container-id="main-col"', 'data-container-id="main&#45;col"');
  assert.deepEqual(parseTurns(html).turns, defaultTurns(1));
});

test('only a block whose child carries Gd7Hsc is the controls block, not one with it deeper', () => {
  const deep = '<div class="made-up"><div class="made-up"><div data-xid="Gd7Hsc">Deep made-up text</div></div></div>';
  assert.deepEqual(answerOf([paragraph('Answer.'), deep]), assistant('Answer.\nDeep made-up text', 0));
});

test('the answer\'s container is the first one under main-col, not a later one', () => {
  const html = threadHtml([{}]).replace('<div class="alk4p q4PqPb">', '<div style="display:contents" data-container-id="999"></div><div class="alk4p q4PqPb">');
  assert.ok(html.includes('data-container-id="999"'), 'Test setup invalid: no second container');
  assert.deepEqual(parseTurns(html).turns[1], assistant(answerText(1), ANSWER_CITATIONS));
});

test('the search for the answer\'s container ends where main-col does', () => {
  // main-col emptied, and the answer aimed at the scaffold container after it.
  const html = threadHtml([{}]).replace('<div style="display:contents" data-container-id="106"></div>', '').replaceAll('data-target-container-id="106"', 'data-target-container-id="109"');
  assert.ok(html.includes('data-container-id="109"') && !html.includes('"106"'), 'Test setup invalid');
  const thread = parseTurns(html);
  assert.deepEqual(thread.turns[1], assistant(null, null));
  assert.equal(thread.complete, false);
});

test('only a span whose data-suuid starts with nCd0md| is a citation marker', () => {
  const near = [
    '<span data-suuid="nCd0mdX|made-up-|">one</span>',
    '<span data-suuid="other|made-up-|">two</span>',
    '<span data-suuid="x nCd0md|made-up-|">three</span>',
    '<span data-suuid="nCd0md">four</span>',
  ];
  const turn = answerOf([paragraph(`Start ${near.join(' ')}.`), '<div data-suuid="nCd0md|made-up-|">five</div>']);
  assert.deepEqual(turn, assistant('Start one two three four.\nfive', 0));
});

test('an answer block inside which a turn block opens is not an answer', () => {
  const thread = parse([{ answer: [...answerInners(1), '<div class="CKgc1d" data-scope-id="turn"><div>made-up</div></div>'] }]);
  assert.deepEqual(thread.turns[0], user(question(1)));
  assert.deepEqual(thread.turns[1], assistant(null, null));
  assert.equal(thread.complete, false);
});

test('answer blocks nested tens of thousands deep, each holding a heading, are read in linear time', () => {
  // Marking every open block at each heading takes about 4 s here.
  const depth = 100_000;
  const nested = `${'<div data-sn-op="2" data-target-container-id="1"><h2 class="iMqumd" data-rfsp="1">made-up</h2>'.repeat(depth)}${'</div>'.repeat(depth)}`;
  const started = Date.now();
  const thread = parseTurns(threadHtml([{ answer: [nested] }]));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.deepEqual(thread.turns[1], assistant(null, null));
  assert.equal(thread.complete, false);
});

test('an answer block inside which an h2[data-rfsp] opens is not an answer', () => {
  const thread = parse([{ answer: [...answerInners(1), paragraph('<h2 class="iMqumd" data-rfsp="1">You said: made-up</h2>')] }, {}]);
  assert.deepEqual(thread.turns[0], user(question(1)));
  assert.deepEqual(thread.turns[1], assistant(null, null));
  assert.deepEqual(thread.turns.slice(2), defaultTurns(2).slice(2));
  assert.equal(thread.complete, false);
});
