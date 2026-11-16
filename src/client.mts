// Requests to www.google.com with the browser's cookies, and the sorting of
// what comes back. A request that gets any HTTP answer resolves to that
// answer, so the caller sorts every status in one place (classify). A request
// that gets no answer, or none within the timeout, rejects with a
// RequestError that says only which of the two it was: a fetch error can name
// the URL, which holds a thread's ids or a list cursor, so its text goes no
// further than this file.

export type Answer = {
  status: number;
  // The URL fetch ended on, after any redirects. Google sends a session it
  // takes for automated traffic to its /sorry/ page, so classify reads it.
  // Empty for a Response built by hand, as in tests.
  url: string;
  headers: Record<string, string>;
  text: string;
};

export interface Client {
  get(url: string): Promise<Answer>;
}

export class RequestError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network') {
    super(kind === 'timeout' ? 'the request timed out' : 'the request failed');
    this.name = 'RequestError';
    this.kind = kind;
  }
}

// Chrome can stop an MV3 service worker after about 30 s without an extension
// call, so a request allowed 30 s could outlive the worker that made it.
export const REQUEST_TIMEOUT_MS = 20_000;

export interface ClientOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  // A cheap extension call, made before each request and not waited on, so a
  // request never adds its own length to a stretch without one.
  readonly keepAlive?: () => unknown;
  readonly log?: (line: string) => void;
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);
const defaultLog = (line: string) => console.log(`[rex-spider-google-ai] ${line}`);

// Makes the keep-alive call without waiting on it: the call resets the idle
// timer when it is made, and one that never answers must hold nothing up. One
// that throws or rejects is logged by its error's name only, and ignored.
function touch(keepAlive: () => unknown, log: (line: string) => void): void {
  const failed = (error: unknown) => {
    try {
      log(`keep-alive failed (${nameOf(error)})`);
    } catch {
      // A log that throws has nowhere left to report to.
    }
  };
  try {
    Promise.resolve(keepAlive()).catch(failed);
  } catch (error) {
    failed(error);
  }
}

export function createClient({ fetch: send = (url, init) => fetch(url, init), timeoutMs = REQUEST_TIMEOUT_MS, keepAlive, log = defaultLog }: ClientOptions = {}): Client {
  return {
    async get(url) {
      if (keepAlive !== undefined) {
        touch(keepAlive, log);
      }
      const controller = new AbortController();
      // Raced against the request and the body read, so the timeout holds even
      // where an abort does not reach them (a body that never finishes).
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      aborted.catch(() => {});
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // credentials: 'include' sends the participant's Google cookies, as
        // the old spider's requests did. No headers: the session is the
        // cookies.
        const response = await Promise.race([send(url, { method: 'GET', credentials: 'include', signal: controller.signal }), aborted]);
        const text = await Promise.race([response.text(), aborted]);
        // Headers hands its names back in lower case.
        const answered: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          answered[name] = value;
        });
        return { status: response.status, url: response.url, headers: answered, text };
      } catch {
        throw new RequestError(controller.signal.aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type Classification = 'ok' | 'signed-out' | 'refused' | 'not-found' | 'rate-limited' | 'challenge' | 'server';

function header(answer: Answer, name: string): string | undefined {
  for (const [key, value] of Object.entries(answer.headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

// Google's unusual-traffic page. Only the path is read, on any host, since
// the redirect need not stay on www.google.com, and a query can hold any text.
function atSorryPage(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/sorry/');
  } catch {
    return false;
  }
}

// The failure policy's table, first match wins. The /sorry/ page is read
// before any status, since it can come as a 200, a 403 or a 429. A 401 is
// read before a wait: it says the session is gone, and the pass ends as not
// signed in. A wait (429, 503, any Retry-After) is read before a refusal,
// since a 403 or 404 that names a wait is a wait, and the design stops the
// pass on any Retry-After. Any other 4xx is a refusal, and anything else that
// is not a 2xx (a 5xx, or a redirect that was not followed) is the server's.
// A 2xx is ok whatever its body: whether a body is a list or a page is for
// the parser that reads it.
export function classify(answer: Answer): Classification {
  const { status } = answer;
  if (atSorryPage(answer.url)) {
    return 'challenge';
  }
  if (status === 401) {
    return 'signed-out';
  }
  if (status === 429 || status === 503 || header(answer, 'retry-after') !== undefined) {
    return 'rate-limited';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status >= 400 && status <= 499) {
    return 'refused';
  }
  if (status >= 200 && status <= 299) {
    return 'ok';
  }
  return 'server';
}

// The wait a Retry-After header asks for, in milliseconds: a number of
// seconds, or an HTTP date taken from `now` (0 when it has passed). Null when
// there is no header or it is neither. A header that is not all digits is read
// as a date only if it has letters in it, because Date.parse reads "1.5" as a
// date in January.
export function retryAfterMs(answer: Answer, now: number = Date.now()): number | null {
  const raw = header(answer, 'retry-after')?.trim();
  if (raw === undefined || raw === '') {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  if (!/[A-Za-z]{3}/.test(raw)) {
    return null;
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
