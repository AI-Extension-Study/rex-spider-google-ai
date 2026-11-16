import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FOLWR_TEXT_CAP, unchunk } from '../../src/stream.mts';
import { DATA_CHUNK, DATA_FRAME, END_FRAME, HEADER_FRAME, ROOT_FRAME, fillFrame, fillMarker, placeholder, simpleStream, streamBody, streamChunks } from './thread-fixtures.mts';

const ROOT = `<div><div>${placeholder(1)}</div>${placeholder(8)}</div>`;

function whole(body: string): string {
  const result = unchunk(body);
  assert.ok(result !== null, 'the walk failed');
  assert.equal(result.whole, true, 'the stream was not whole');
  return result.html;
}

test('the cap is 40 Mi UTF-16 units', () => {
  assert.equal(FOLWR_TEXT_CAP, 40 * 1024 * 1024);
});

test('frames and HTML fragments unchunk to the root with each placeholder filled', () => {
  assert.equal(whole(simpleStream(['<p class="n6owBd">Made-up ', 'answer text.</p>'])), '<div><div><p class="n6owBd">Made-up answer text.</p></div></div>');
});

test('no frame, data chunk or marker reaches the HTML', () => {
  const html = whole(simpleStream(['<p>Text.</p>']));
  for (const piece of [HEADER_FRAME, ROOT_FRAME, END_FRAME, DATA_FRAME, DATA_CHUNK, fillFrame(1), fillMarker(1), 'stcn', 'data-async-ph']) {
    assert.equal(html.includes(piece), false, `the HTML holds ${piece}`);
  }
});

test('lengths count UTF-16 units, so emoji with modifiers and no-break spaces unchunk exactly', () => {
  const fragments = ['<p>Thumbs 👍🏽 up</p>', '<p>9:41\u202fAM\u00a0and 🍅🍅</p>', '<p>café 𝔸</p>'];
  // The fixture tells the readings apart: each fragment's UTF-16 length
  // differs from its UTF-8 byte length and from its code point count.
  for (const fragment of fragments) {
    assert.notEqual(Buffer.byteLength(fragment, 'utf8'), fragment.length);
    assert.notEqual([...fragment].length, fragment.length);
  }
  assert.equal(whole(simpleStream(fragments)), `<div><div>${fragments.join('')}</div></div>`);
});

test('a fill nested in a fill is placed where its placeholder is, in either arrival order', () => {
  const inner = { n: 3, chunks: ['<b>inner</b>'] };
  const outer = { n: 1, chunks: [`<i>before ${placeholder(3)} after</i>`] };
  const expected = '<div><div><i>before <b>inner</b> after</i></div></div>';
  assert.equal(whole(streamBody(streamChunks([ROOT], [outer, inner, { n: 8, chunks: [''] }]))), expected);
  assert.equal(whole(streamBody(streamChunks([ROOT], [inner, outer, { n: 8, chunks: [''] }]))), expected);
});

test('fills nested thousands deep expand without overflowing the stack', () => {
  const depth = 5000;
  const fills = Array.from({ length: depth }, (_, index) => ({ n: index + 10, chunks: [`<div>${index}${index + 1 < depth ? placeholder(index + 11) : ''}`, '</div>'] }));
  const root = `<div>${placeholder(10)}</div>`;
  const html = whole(streamBody(streamChunks([root], fills)));
  assert.equal(html.split('<div>').length - 1, depth + 1);
  assert.ok(html.includes('<div>4999</div>'));
});

test('a length that runs past the end of the body gives null', () => {
  const body = simpleStream(['<p>Text.</p>']);
  assert.equal(unchunk(`${body}ff;short`), null);
  assert.equal(unchunk(body.slice(0, -3)), null);
});

test('a body without the guard gives null', () => {
  const body = simpleStream(['<p>Text.</p>']);
  assert.equal(unchunk(body.slice(")]}'\n".length)), null);
  assert.equal(unchunk(body.replace(")]}'\n", ")]}'")), null);
  assert.equal(unchunk(''), null);
  assert.equal(unchunk('<!doctype html><html></html>'), null);
});

test('a length that is not hex, or has no semicolon, gives null', () => {
  const body = simpleStream(['<p>Text.</p>']);
  assert.equal(unchunk(`${body}zz;x`), null);
  assert.equal(unchunk(`${body}3`), null);
  assert.equal(unchunk(`${body};abc`), null);
  assert.equal(unchunk(`${body}123456789;x`), null);
});

test('a body over the cap is refused, and one at the cap is read', () => {
  const sized = (length: number) => {
    let padding = length;
    for (;;) {
      const body = simpleStream([`<p>${'x'.repeat(padding)}</p>`]);
      if (body.length === length) {
        return body;
      }
      padding += length - body.length;
    }
  };
  const atCap = sized(FOLWR_TEXT_CAP);
  assert.equal(atCap.length, FOLWR_TEXT_CAP);
  assert.equal(unchunk(atCap)?.whole, true);
  const overCap = sized(FOLWR_TEXT_CAP + 1);
  assert.equal(overCap.length, FOLWR_TEXT_CAP + 1);
  assert.equal(unchunk(overCap), null);
});

test('a stream cut at any chunk boundary is never called whole', () => {
  const chunks = streamChunks([ROOT], [
    { n: 1, chunks: ['<p>One', '</p>', `<p>${placeholder(2)}</p>`] },
    { n: 2, chunks: ['<p>Two</p>'] },
    { n: 8, chunks: [''] },
  ]);
  assert.equal(unchunk(streamBody(chunks))?.whole, true);
  for (let cut = 0; cut < chunks.length; cut += 1) {
    const result = unchunk(streamBody(chunks.slice(0, cut)));
    assert.ok(result !== null, `the walk failed at cut ${cut}`);
    assert.equal(result.whole, false, `cut ${cut} of ${chunks.length} was called whole`);
  }
});

test('a placeholder with no fill leaves the stream not whole', () => {
  const result = unchunk(streamBody(streamChunks([ROOT], [{ n: 1, chunks: [`<p>Text ${placeholder(5)}</p>`] }, { n: 8, chunks: [''] }])));
  assert.ok(result !== null);
  assert.equal(result.whole, false);
  assert.ok(result.html.includes('Text'));
});

test('a stream with no fill is not whole', () => {
  const result = unchunk(streamBody([HEADER_FRAME, ROOT_FRAME, '<div>Root only</div>', END_FRAME, '']));
  assert.ok(result !== null);
  assert.equal(result.whole, false);
  assert.equal(result.html, '<div>Root only</div>');
});

test('a fill whose marker is malformed does not count, and leaves the stream not whole', () => {
  const result = unchunk(streamBody(streamChunks([ROOT], [{ n: 1, chunks: ['<p>Text.</p>'], marker: '<p>not a marker</p>' }, { n: 8, chunks: [''] }])));
  assert.ok(result !== null);
  assert.equal(result.whole, false);
  assert.equal(result.html.includes('Text.'), false);
});

test('a stream that ends after a fill\'s end frame, before its marker, is not whole', () => {
  const chunks = streamChunks([ROOT], [{ n: 1, chunks: ['<p>Text.</p>'] }, { n: 8, chunks: [''] }]);
  assert.equal(unchunk(streamBody(chunks.slice(0, -1)))?.whole, false);
});

test('a stream whose fills are all placed but whose last chunk is not a marker is not whole', () => {
  const chunks = streamChunks([ROOT], [{ n: 1, chunks: ['<p>Text.</p>'] }, { n: 8, chunks: [''] }]);
  const result = unchunk(streamBody([...chunks, DATA_FRAME, DATA_CHUNK]));
  assert.ok(result !== null);
  assert.equal(result.whole, false);
  assert.equal(result.html, whole(streamBody(chunks)));
});

test('HTML between fills, outside any fill, leaves the stream not whole', () => {
  const chunks = streamChunks([ROOT], [{ n: 1, chunks: ['<p>Text.</p>'] }, { n: 8, chunks: [''] }]);
  chunks.splice(chunks.length - 4, 0, '<p>stray</p>');
  assert.equal(unchunk(streamBody(chunks))?.whole, false);
});

test('a fill that no placeholder takes leaves the stream not whole, since its HTML would be lost', () => {
  const result = unchunk(streamBody(streamChunks([ROOT], [{ n: 1, chunks: ['<p>Text.</p>'] }, { n: 8, chunks: [''] }, { n: 40, chunks: ['<p>Orphan.</p>'] }])));
  assert.ok(result !== null);
  assert.equal(result.whole, false);
});

test('a placeholder that appears twice is filled once', () => {
  const root = `<div>${placeholder(1)}${placeholder(1)}</div>`;
  const result = unchunk(streamBody(streamChunks([root], [{ n: 1, chunks: ['<p>Once.</p>'] }])));
  assert.ok(result !== null);
  assert.equal(result.html.split('Once.').length - 1, 1);
});

test('an HTML chunk that does not start with a tag is kept', () => {
  assert.equal(whole(simpleStream(['<p>Start ', 'middle text ', 'end</p>'])), '<div><div><p>Start middle text end</p></div></div>');
});

// ---- fix round 1: the walk's edges ----

const TWO_FILLS = [{ n: 1, chunks: ['<p>Text.</p>'] }, { n: 8, chunks: [''] }];

test('a body cut anywhere inside its last chunk gives null, and cut at that chunk\'s start is not whole', () => {
  const chunks = streamChunks([ROOT], TWO_FILLS);
  const body = streamBody(chunks);
  const last = chunks[chunks.length - 1];
  const start = body.length - (last.length.toString(16).length + 1 + last.length);
  assert.equal(body.slice(start), `${last.length.toString(16)};${last}`, 'Test setup invalid: the last chunk is not where expected');
  for (let cut = start + 1; cut < body.length; cut += 1) {
    assert.equal(unchunk(body.slice(0, cut)), null, `a cut ${body.length - cut} unit(s) before the end was read`);
  }
  assert.equal(unchunk(body.slice(0, start))?.whole, false);
  assert.equal(unchunk(body)?.whole, true);
});

test('a guard without its newline gives null, whatever follows it', () => {
  const rest = simpleStream(['<p>Text.</p>']).slice(")]}'\n".length);
  assert.equal(unchunk(`)]}'x${rest}`), null);
  assert.equal(unchunk(`)]}' ${rest}`), null);
  assert.equal(unchunk(`)]}'\n${rest}`)?.whole, true);
});

test('a length with a character that is not a hex digit gives null', () => {
  const rest = simpleStream(['<p>Text.</p>']).slice(")]}'\n".length);
  for (const character of ['g', 'G', 'x', ' ', '-', '+', '.']) {
    assert.equal(unchunk(`)]}'\n${character}${rest}`), null, `a length starting ${JSON.stringify(character)} was read`);
  }
  // A non-hex digit last: read as -1, "1g" would be 15, this payload's
  // length, and the stream would read whole.
  const payload = '<p>Made up.</p>';
  assert.equal(payload.length, 15);
  const chunks = streamChunks([ROOT], [{ n: 1, chunks: [payload] }, { n: 8, chunks: [''] }]);
  assert.equal(unchunk(streamBody(chunks))?.whole, true);
  const body = `)]}'\n${chunks.map((chunk) => `${chunk === payload ? '1g' : chunk.length.toString(16)};${chunk}`).join('')}`;
  assert.equal(unchunk(body), null);
});

test('a semicolon with no length before it gives null', () => {
  const body = simpleStream(['<p>Text.</p>']);
  assert.equal(unchunk(`${body};`), null);
  assert.equal(unchunk(`)]}'\n;${body.slice(")]}'\n".length)}`), null);
});

test('a length of up to 8 hex digits is read, leading zeros included, and one of 9 gives null', () => {
  const chunks = streamChunks([ROOT], TWO_FILLS);
  const padded = (width: number) => `)]}'\n${chunks.map((payload) => `${payload.length.toString(16).padStart(width, '0')};${payload}`).join('')}`;
  assert.deepEqual(unchunk(padded(8)), unchunk(streamBody(chunks)));
  assert.equal(unchunk(padded(8))?.whole, true);
  assert.equal(unchunk(padded(9)), null);
});

test('hex lengths are read in either case', () => {
  const chunks = streamChunks([ROOT], TWO_FILLS);
  const upper = `)]}'\n${chunks.map((payload) => `${payload.length.toString(16).toUpperCase()};${payload}`).join('')}`;
  assert.notEqual(upper, streamBody(chunks), 'Test setup invalid: no length holds a letter');
  assert.deepEqual(unchunk(upper), unchunk(streamBody(chunks)));
  assert.equal(unchunk(upper)?.whole, true);
});

test('a fill cut before its marker adds no HTML', () => {
  const root = `<div>${placeholder(1)}${placeholder(2)}</div>`;
  const chunks = streamChunks([root], [{ n: 1, chunks: ['<p>Kept text.</p>'] }, { n: 2, chunks: ['<p>Partial ', 'text.</p>'] }]);
  const first = chunks.indexOf('<p>Partial ');
  // After the fill's first chunk, after its second, and after its end frame.
  for (const cut of [first + 1, first + 2, first + 3]) {
    const result = unchunk(streamBody(chunks.slice(0, cut)));
    assert.ok(result !== null, `the walk failed at cut ${cut}`);
    assert.equal(result.whole, false);
    assert.ok(result.html.includes('Kept text.'));
    assert.equal(result.html.includes('Partial'), false, `cut ${cut} kept the partial fill`);
  }
});

test('after the root\'s end frame only an empty chunk or a marker may come', () => {
  const chunks = streamChunks([ROOT], TWO_FILLS);
  const markerAt = chunks.indexOf(END_FRAME) + 1;
  assert.equal(chunks[markerAt], '', 'Test setup invalid: the root\'s marker is not empty');
  const replaced = (payload: string) => streamBody(chunks.map((chunk, index) => (index === markerAt ? payload : chunk)));
  assert.equal(unchunk(replaced(fillMarker(99)))?.whole, true);
  for (const payload of ['<p>stray</p>', 'text', DATA_FRAME, HEADER_FRAME, fillFrame(1)]) {
    assert.equal(unchunk(replaced(payload))?.whole, false, `${payload} after the root was accepted`);
  }
});

test('a fill\'s text that reads like a frame is text', () => {
  for (const text of ['[9,null,"1"]', '[9]', '[9, null, "0"]', '[6,"x","0"]']) {
    const result = unchunk(simpleStream(['<p>', text, '</p>']));
    assert.ok(result !== null);
    assert.equal(result.whole, true, `${text} ended or broke the fill`);
    assert.equal(result.html, `<div><div><p>${text}</p></div></div>`);
  }
});

test('root text that reads like a frame is root HTML', () => {
  const result = unchunk(streamBody(streamChunks(['<div>', '[1]', `${placeholder(1)}${placeholder(8)}</div>`], [{ n: 1, chunks: ['<p>x</p>'] }, { n: 8, chunks: [''] }])));
  assert.deepEqual(result, { html: '<div>[1]<p>x</p></div>', whole: true });
});

test('between fills, anything but a fill frame or a data frame in its exact form is stray', () => {
  const chunks = streamChunks([ROOT], TWO_FILLS);
  const at = chunks.indexOf(fillFrame(8));
  for (const near of ['[7,null,"0"]', '[2,null,"0"]', HEADER_FRAME, '[6, "_x_1", "0"]']) {
    const changed = [...chunks.slice(0, at), near, ...chunks.slice(at)];
    assert.equal(unchunk(streamBody(changed))?.whole, false, `${near} between fills was accepted`);
  }
});
