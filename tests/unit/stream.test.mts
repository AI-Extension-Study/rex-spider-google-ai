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
