import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer, type Client, RequestError } from '../../src/client.mts';
import { type FolwrValues, type ReadResult, folwrUrl, folwrValues, readThread, threadPageUrl } from '../../src/read.mts';
import { FOLWR_TEXT_CAP } from '../../src/stream.mts';
import { parseTurns } from '../../src/turns.mts';
import { MSTK, MTID, listEntry } from './fixtures.mts';
import { FOLWR_VALUES, type PageValues, fillFrame, threadHtml, threadPage, threadStream } from './thread-fixtures.mts';

const PAGE_URL = `https://www.google.com/search?udm=50&mstk=${MSTK}&mtid=${MTID}&csuir=1&hl=en`;
// URLSearchParams writes ':' as %3A and ',' as %2C; the other values are
// letters, digits, '-' and '_', which it leaves as they are.
const FOLWR_URL = 'https://www.google.com/async/folwr?async=_fmt%3Aprog%2C_xsrf%3AAFakeXsrfToken0123456789abcdefGHIJ%3A1763300000000'
  + `&garc=${FOLWR_VALUES.garc}&mlro=${FOLWR_VALUES.mlro}&mlros=${FOLWR_VALUES.mlros}&ei=${FOLWR_VALUES.ei}`;

const answer = (status: number, text: string, url = '', headers: Record<string, string> = {}): Answer => ({ status, url, headers, text });

type Step = Answer | Error;

// A client that answers each request with the next step, and a pace() that
// writes to the same log, so a test sees the order of both.
function scripted(steps: readonly Step[]): { client: Client; pace: () => Promise<void>; events: string[] } {
  const queue = [...steps];
  const events: string[] = [];
  return {
    client: {
      async get(url) {
        events.push(`get ${url}`);
        const step = queue.shift();
        if (step === undefined) {
          throw new Error('Test setup invalid: no answer left');
        }
        if (step instanceof Error) {
          throw step;
        }
        return step;
      },
    },
    pace: async () => {
      events.push('pace');
    },
    events,
  };
}

const TWO_TURNS = [{}, {}];
const PAGE = answer(200, threadPage());
const STREAM = answer(200, threadStream(TWO_TURNS));

async function read(steps: readonly Step[]): Promise<{ result: ReadResult; events: string[] }> {
  const { client, pace, events } = scripted(steps);
  return { result: await readThread(client, listEntry(), pace), events };
}

test('threadPageUrl is the thread page in the exact form', () => {
  assert.equal(threadPageUrl(listEntry()), PAGE_URL);
});

test('folwrValues finds all five values on the page', () => {
  assert.deepEqual(folwrValues(threadPage()), FOLWR_VALUES);
});

for (const key of Object.keys(FOLWR_VALUES) as (keyof FolwrValues)[]) {
  test(`folwrValues is null when the page has no ${key}`, () => {
    assert.equal(folwrValues(threadPage({ [key]: null } as PageValues)), null);
  });
  test(`folwrValues is null when ${key} is empty`, () => {
    assert.equal(folwrValues(threadPage({ [key]: '' } as PageValues)), null);
  });
}

test('folwrValues is null for a value with an entity, a space or a bracket in it, rather than send it on', () => {
  assert.equal(folwrValues(threadPage({ xsrf: 'Made&amp;Up:1' })), null);
  assert.equal(folwrValues(threadPage({ mlros: 'made up' })), null);
  assert.equal(folwrValues(threadPage({ garc: 'made<up' })), null);
  assert.equal(folwrValues(threadPage({ ei: 'made up' })), null);
});

test('folwrValues does not take the folif token for the folwr one', () => {
  const page = threadPage({ xsrf: null });
  assert.ok(page.includes('data-xsrf-folif-token="'), 'Test setup invalid: no folif token');
  assert.equal(folwrValues(page), null);
});

test('folwrValues does not take a longer attribute whose name ends in a value\'s name', () => {
  const page = threadPage({ garc: null }).replace(' data-srtst=', ' data-old-data-garc="Other0123" data-srtst=');
  assert.ok(page.includes('data-old-data-garc="Other0123"'), 'Test setup invalid: no longer attribute');
  assert.equal(folwrValues(page), null);
});

test('folwrValues is null on a page that is not a thread page', () => {
  assert.equal(folwrValues('<!doctype html><html><body>Made-up sign-in page</body></html>'), null);
  assert.equal(folwrValues(''), null);
});

test('folwrUrl is the five-parameter form, in order', () => {
  assert.equal(folwrUrl(FOLWR_VALUES), FOLWR_URL);
  assert.deepEqual([...new URL(FOLWR_URL).searchParams.keys()], ['async', 'garc', 'mlro', 'mlros', 'ei']);
});

test('readThread makes exactly two requests, the page then folwr, with pace() between them', async () => {
  const { result, events } = await read([PAGE, STREAM]);
  assert.deepEqual(events, [`get ${PAGE_URL}`, 'pace', `get ${FOLWR_URL}`]);
  assert.deepEqual(result, { ok: true, thread: parseTurns(threadHtml(TWO_TURNS)) });
  assert.equal(result.ok && result.thread.complete, true);
  assert.equal(result.ok && result.thread.turns.length, 4);
});

test('a stream that is not whole gives its turns, with complete false', async () => {
  // Cut at a chunk boundary before the root's empty fill, so its
  // placeholder stays open.
  const body = threadStream(TWO_TURNS);
  const frame = fillFrame(8);
  const at = body.lastIndexOf(`${frame.length.toString(16)};${frame}`);
  assert.ok(at > 0, 'Test setup invalid: no empty fill');
  const cut = body.slice(0, at);
  const { result } = await read([PAGE, answer(200, cut)]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.thread, { ...parseTurns(threadHtml(TWO_TURNS)), complete: false });
});

for (const key of Object.keys(FOLWR_VALUES) as (keyof FolwrValues)[]) {
  test(`a thread page without ${key} is a layout failure, after one request and no pace()`, async () => {
    const page = answer(200, threadPage({ [key]: null } as PageValues));
    const { result, events } = await read([page]);
    assert.deepEqual(result, { ok: false, failure: 'layout', answer: page });
    assert.deepEqual(events, [`get ${PAGE_URL}`]);
  });
}

const BROKEN: [string, string][] = [
  ['an empty body', ''],
  ['a body without the guard', '<!doctype html><html><body>Made-up</body></html>'],
  ['a length past the end', `)]}'\nff;short`],
  ['a length that is not hex', `)]}'\nzz;x`],
];

for (const [name, text] of BROKEN) {
  test(`${name} from folwr is a stream failure`, async () => {
    const stream = answer(200, text);
    const { result, events } = await read([PAGE, stream]);
    assert.deepEqual(result, { ok: false, failure: 'stream', answer: stream });
    assert.equal(events.length, 3);
  });
}

test('a folwr body over the cap is too large, and one at the cap is read as a stream', async () => {
  const over = answer(200, `)]}'\n${'x'.repeat(FOLWR_TEXT_CAP)}`);
  assert.ok(over.text.length > FOLWR_TEXT_CAP);
  assert.deepEqual((await read([PAGE, over])).result, { ok: false, failure: 'too-large', answer: over });
  const at = answer(200, over.text.slice(0, FOLWR_TEXT_CAP));
  assert.deepEqual((await read([PAGE, at])).result, { ok: false, failure: 'stream', answer: at });
});

const SORRY = 'https://www.google.com/sorry/index?continue=made-up';
const CLASSIFIED: [string, Answer, string][] = [
  ['401', answer(401, ''), 'signed-out'],
  ['403', answer(403, ''), 'refused'],
  ['404', answer(404, ''), 'not-found'],
  ['429', answer(429, ''), 'rate-limited'],
  ['503', answer(503, ''), 'rate-limited'],
  ['a 200 with Retry-After', answer(200, threadPage(), '', { 'retry-after': '30' }), 'rate-limited'],
  ['the /sorry/ page', answer(200, '<html>Made-up</html>', SORRY), 'challenge'],
  ['500', answer(500, ''), 'server'],
  ['a redirect not followed', answer(302, ''), 'server'],
];

for (const [name, given, failure] of CLASSIFIED) {
  test(`${name} for the thread page is ${failure}, after one request and no pace()`, async () => {
    const { result, events } = await read([given]);
    assert.deepEqual(result, { ok: false, failure, answer: given });
    assert.deepEqual(events, [`get ${PAGE_URL}`]);
  });
  test(`${name} for folwr is ${failure}`, async () => {
    const { result, events } = await read([PAGE, given]);
    assert.deepEqual(result, { ok: false, failure, answer: given });
    assert.deepEqual(events, [`get ${PAGE_URL}`, 'pace', `get ${FOLWR_URL}`]);
  });
}

test('a request that gets no answer is a network failure, with no answer and nothing of the error', async () => {
  for (const kind of ['timeout', 'network'] as const) {
    const first = await read([new RequestError(kind)]);
    assert.deepEqual(first.result, { ok: false, failure: 'network', answer: null });
    assert.equal(first.events.length, 1);
    const second = await read([PAGE, new RequestError(kind)]);
    assert.deepEqual(second.result, { ok: false, failure: 'network', answer: null });
    assert.equal(second.events.length, 3);
    for (const { result } of [first, second]) {
      assert.equal(JSON.stringify(result).includes('timed out'), false);
      assert.equal(JSON.stringify(result).includes(kind === 'timeout' ? 'timeout' : 'request failed'), false);
    }
  }
});

test('a pace() that rejects rejects the read, before the folwr request', async () => {
  const { client, events } = scripted([PAGE, STREAM]);
  const pace = async () => {
    events.push('pace');
    throw new Error('stopped');
  };
  await assert.rejects(readThread(client, listEntry(), pace), /stopped/);
  assert.deepEqual(events, [`get ${PAGE_URL}`, 'pace']);
});

test('readThread logs nothing', async (t) => {
  const calls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => t.mock.method(console, name, () => {}));
  await read([PAGE, STREAM]);
  await read([answer(200, threadPage({ garc: null }))]);
  await read([PAGE, answer(200, 'broken')]);
  await read([new RequestError('timeout')]);
  await read([answer(429, '')]);
  assert.deepEqual(calls.map((mock) => mock.mock.callCount()), [0, 0, 0, 0, 0]);
});
