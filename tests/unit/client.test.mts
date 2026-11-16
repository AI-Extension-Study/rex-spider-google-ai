import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer, REQUEST_TIMEOUT_MS, RequestError, classify, createClient, retryAfterMs } from '../../src/client.mts';

const LIST = 'https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en';
const SORRY = 'https://www.google.com/sorry/index?continue=https://www.google.com/&q=x';

const answer = (status: number, headers: Record<string, string> = {}, url = LIST, text = ")]}'\n\n[]"): Answer => ({ status, url, headers, text });

// One case per row of the failure policy's table.
const TABLE: [string, Answer, string][] = [
  ['200', answer(200), 'ok'],
  ['204', answer(204, {}, LIST, ''), 'ok'],
  ['200 with an HTML body (the body is the parser\'s to judge)', answer(200, {}, LIST, '<html></html>'), 'ok'],
  ['200 with no final URL (a Response built by hand)', answer(200, {}, ''), 'ok'],
  ['401', answer(401), 'signed-out'],
  ['403', answer(403), 'refused'],
  ['404', answer(404), 'not-found'],
  ['400 (any other 4xx is a refusal)', answer(400), 'refused'],
  ['410', answer(410), 'refused'],
  ['429', answer(429), 'rate-limited'],
  ['503', answer(503), 'rate-limited'],
  ['Retry-After on a 500', answer(500, { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After on a 200', answer(200, { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After on a 403 (a wait beats a refusal)', answer(403, { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After on a 404 (a wait beats a refusal)', answer(404, { 'retry-after': '5' }), 'rate-limited'],
  ['Retry-After spelled with capitals', answer(200, { 'Retry-After': '5' }), 'rate-limited'],
  ['401 with Retry-After (signed out beats a wait)', answer(401, { 'retry-after': '5' }), 'signed-out'],
  ['a 200 at /sorry/', answer(200, {}, SORRY), 'challenge'],
  ['a 429 at /sorry/ (the unusual-traffic page beats a wait)', answer(429, { 'retry-after': '5' }, SORRY), 'challenge'],
  ['a 403 at /sorry/', answer(403, {}, SORRY), 'challenge'],
  ['a 503 at /sorry/', answer(503, {}, SORRY), 'challenge'],
  ['a 401 at /sorry/', answer(401, {}, SORRY), 'challenge'],
  ['/sorry/ on another Google host', answer(200, {}, 'https://ipv4.google.com/sorry/index?continue=x'), 'challenge'],
  ['/sorry/ only in the query', answer(200, {}, 'https://www.google.com/search?q=/sorry/'), 'ok'],
  ['a path that starts /sorry without the slash', answer(200, {}, 'https://www.google.com/sorryabout'), 'ok'],
  ['/sorry/ deeper in the path', answer(200, {}, 'https://www.google.com/x/sorry/index'), 'ok'],
  ['500', answer(500), 'server'],
  ['502', answer(502), 'server'],
  ['504', answer(504), 'server'],
  ['a redirect that was not followed', answer(302, {}, LIST, ''), 'server'],
];

for (const [name, given, expected] of TABLE) {
  test(`classify: ${name} is ${expected}`, () => {
    assert.equal(classify(given), expected);
  });
}

const NOW = Date.parse('2026-11-12T10:00:00Z');

test('retryAfterMs reads a number of seconds into milliseconds', () => {
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '120' }), NOW), 120_000);
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '0' }), NOW), 0);
  assert.equal(retryAfterMs(answer(429, { 'Retry-After': ' 7 ' }), NOW), 7000);
});

test('retryAfterMs reads an HTTP date as the wait from now', () => {
  assert.equal(retryAfterMs(answer(503, { 'retry-after': 'Thu, 12 Nov 2026 10:02:00 GMT' }), NOW), 120_000);
});

test('retryAfterMs is 0 for an HTTP date that has passed', () => {
  assert.equal(retryAfterMs(answer(503, { 'retry-after': 'Thu, 12 Nov 2026 09:00:00 GMT' }), NOW), 0);
});

test('retryAfterMs is null when there is no usable header', () => {
  assert.equal(retryAfterMs(answer(429), NOW), null);
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, { 'retry-after': 'soon' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '-5' }), NOW), null);
  // Date.parse reads both of these as a year or a month, so they are checked by shape first.
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '1.5' }), NOW), null);
  assert.equal(retryAfterMs(answer(429, { 'retry-after': '99999999999999999999' }), NOW), null);
});

test('retryAfterMs reads the clock when none is given', () => {
  const ms = retryAfterMs(answer(429, { 'retry-after': new Date(Date.now() + 60_000).toUTCString() }));
  assert.ok(ms !== null && ms > 50_000 && ms <= 60_000, `got ${ms}`);
});

interface Call {
  url: string;
  init: RequestInit;
}

const respond = (build: () => Response, calls: Call[] = []) => async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  return build();
};

// A Response built by hand has an empty url; fetch sets it to the final URL
// after redirects.
function redirected(response: Response, finalUrl: string): Response {
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

test('get sends a GET with the browser\'s cookies (credentials: include), no headers, and the abort signal', async () => {
  const calls: Call[] = [];
  const client = createClient({ fetch: respond(() => new Response('<html></html>'), calls) });
  await client.get('https://www.google.com/?hl=en');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.google.com/?hl=en');
  assert.deepEqual(Object.keys(calls[0].init).sort(), ['credentials', 'method', 'signal']);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('get answers any status with the final URL, its headers (lower-cased) and its body, and does not throw on 429', async () => {
  const client = createClient({
    fetch: respond(() => redirected(new Response('<html>unusual traffic</html>', { status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'text/html' } }), SORRY)),
  });
  const got = await client.get(LIST);
  assert.equal(got.status, 429);
  assert.equal(got.url, SORRY);
  assert.equal(got.text, '<html>unusual traffic</html>');
  assert.equal(got.headers['retry-after'], '30');
  assert.equal(got.headers['content-type'], 'text/html');
  assert.equal(classify(got), 'challenge');
});

test('get takes the URL fetch reports, not the one it asked for', async () => {
  const client = createClient({ fetch: respond(() => redirected(new Response('x'), 'https://www.google.com/after-redirect')) });
  assert.equal((await client.get('https://www.google.com/before')).url, 'https://www.google.com/after-redirect');
  const plain = createClient({ fetch: respond(() => new Response('x')) });
  assert.equal((await plain.get('https://www.google.com/before')).url, '');
});

// Under the service worker's idle limit of about 30 s, so a request cannot
// outlive the worker that made it.
test('requests time out after 20 s unless told otherwise', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 20_000);
});

test('a request with no answer within the timeout is aborted and throws a timeout', { timeout: 2000 }, async () => {
  let signal: AbortSignal | null = null;
  const client = createClient({
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal ?? null;
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  });
  await assert.rejects(client.get(LIST), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('a fetch that ignores the abort still ends at the timeout', { timeout: 2000 }, async () => {
  const client = createClient({ timeoutMs: 20, fetch: () => new Promise(() => {}) });
  await assert.rejects(client.get(LIST), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
});

test('a body that never finishes is cut at the same timeout', { timeout: 2000 }, async () => {
  const client = createClient({ timeoutMs: 20, fetch: respond(() => new Response(new ReadableStream({ start() {} }))) });
  await assert.rejects(client.get(LIST), (error: unknown) => error instanceof RequestError && error.kind === 'timeout');
});

test('a client made without a timeout aborts at 20 s, not before', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createClient({ fetch: () => new Promise(() => {}) });
  let settled = false;
  const outcome = client.get(LIST).then(
    () => {
      settled = true;
      return 'answered';
    },
    (error: unknown) => {
      settled = true;
      return error instanceof RequestError ? error.kind : 'other';
    },
  );
  t.mock.timers.tick(19_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'ended before 20 s');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'still waiting at 20 s');
  assert.equal(await outcome, 'timeout');
});

// The keep-alive is a cheap extension call that resets the worker's idle
// timer when it is made. It is not waited on: one that never answers must hold
// nothing up.
test('each request makes one keep-alive call, before the fetch, and does not wait on it', { timeout: 2000 }, async () => {
  const events: string[] = [];
  const client = createClient({
    keepAlive: () => {
      events.push('keep-alive');
      return new Promise(() => {});
    },
    fetch: async (url) => {
      events.push(`fetch ${url}`);
      return new Response('x');
    },
  });
  await client.get('https://www.google.com/a');
  await client.get('https://www.google.com/b');
  assert.deepEqual(events, ['keep-alive', 'fetch https://www.google.com/a', 'keep-alive', 'fetch https://www.google.com/b']);
});

test('a keep-alive that throws or rejects does not break the request, and only its error name is logged', async () => {
  const failing: [() => unknown, string][] = [
    [() => {
      throw new TypeError('SECRET-TITLE no storage');
    }, 'keep-alive failed (TypeError)'],
    [() => Promise.reject(new RangeError('SECRET-TITLE gone')), 'keep-alive failed (RangeError)'],
  ];
  for (const [keepAlive, expected] of failing) {
    const lines: string[] = [];
    const client = createClient({ keepAlive, log: (line) => lines.push(line), fetch: respond(() => new Response(")]}'\n\n[]")) });
    const got = await client.get(LIST);
    assert.deepEqual({ status: got.status, text: got.text }, { status: 200, text: ")]}'\n\n[]" });
    // A rejection is handled a turn later.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lines, [expected]);
  }
});

test('without a log, a failed keep-alive is printed with the module prefix', async (t) => {
  const printed: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  const client = createClient({
    keepAlive: () => {
      throw new TypeError('SECRET-TITLE');
    },
    fetch: respond(() => new Response('x')),
  });
  await client.get(LIST);
  assert.deepEqual(printed, ['[rex-spider-google-ai] keep-alive failed (TypeError)']);
});

test('a request that answered leaves no timer behind to abort its signal later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null = null;
  const client = createClient({
    fetch: async (_url, init) => {
      signal = init.signal ?? null;
      return new Response('x');
    },
  });
  await client.get(LIST);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  assert.equal((signal as AbortSignal | null)?.aborted, false, 'a timer aborted a request that had already answered');
});

const THREAD = 'https://www.google.com/search?udm=50&mstk=SECRET-MSTK&mtid=SECRET-MTID&csuir=1&hl=en';

test('a fetch that rejects throws a network error that carries nothing from the failure', async () => {
  const client = createClient({
    fetch: async (url) => {
      throw new TypeError(`Failed to fetch ${url} SECRET-TITLE`);
    },
  });
  await assert.rejects(client.get(THREAD), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.kind, 'network');
    const shown = `${error.name} ${error.message} ${String(error.stack).split('\n')[0]} ${JSON.stringify(error)} ${String((error as { cause?: unknown }).cause)}`;
    for (const secret of ['SECRET-TITLE', 'SECRET-MSTK', 'SECRET-MTID', 'google.com']) {
      assert.ok(!shown.includes(secret), `the error shows ${secret}`);
    }
    return true;
  });
});

test('a body read that fails throws a network error too', async () => {
  const client = createClient({
    fetch: respond(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('SECRET-TITLE body failed'));
            },
          }),
        ),
    ),
  });
  await assert.rejects(client.get(THREAD), (error: unknown) => error instanceof RequestError && error.kind === 'network' && !error.message.includes('SECRET'));
});

test('a timeout error carries no URL either', { timeout: 2000 }, async () => {
  const client = createClient({ timeoutMs: 10, fetch: () => new Promise(() => {}) });
  await assert.rejects(client.get(THREAD), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    const shown = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    for (const secret of ['SECRET-MSTK', 'SECRET-MTID', 'google.com']) {
      assert.ok(!shown.includes(secret), `the error shows ${secret}`);
    }
    return true;
  });
});
