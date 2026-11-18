// The back-off, pure. The state is what the store keeps under BACKOFF_KEY, so
// a refusal outlives the service worker: rex-spider's addRecrawlDelay is in
// memory only, a 429 can come without a Retry-After, and a refusal can last
// hours. The pass asks backoffDecision when it starts and applies nextBackoff
// to how it ended.

export const BACKOFF_BASE_MS = 5 * 60_000;
// Google's limited thread page lasted about 40 minutes with no other Google
// page loaded (live runs, 2026-11-17), so its first wait is an hour.
export const LIMITED_BACKOFF_MS = 3_600_000;
export const BACKOFF_CAP_MS = 6 * 60 * 60_000;

// What asked for the wait: a 429, a 503 or a Retry-After, or a redirect to
// Google's unusual-traffic page (/sorry/), by the same names as client.mts's
// classify; or a thread page that holds none of the four data- attributes
// that carry the thread values, Google's limited page (read.mts). Reported
// on each skipped pass.
export const BACKOFF_CODES = ['rate-limited', 'challenge', 'limited'] as const;
export type BackoffCode = (typeof BACKOFF_CODES)[number];

export interface BackoffState {
  // Epoch ms before which a pass is skipped.
  readonly until: number;
  // Refusals in a row, whatever asked for each; the wait doubles with each.
  readonly failures: number;
  readonly code: BackoffCode;
}

export type BackoffEvent =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'refused';
      readonly now: number;
      readonly code: BackoffCode;
      // The wait a Retry-After asked for, when the answer had one that could
      // be read; anything but a positive finite number counts as none.
      readonly retryAfterMs?: number | null;
    };

export type BackoffDecision = { readonly skip: true; readonly until: number; readonly code: BackoffCode } | { readonly skip: false };

// 5, 10, 20, ... minutes, or 60, 120, 240, ... for the limited page, from the
// base of the code that asks; nextBackoff applies the cap.
const scheduledMs = (failures: number, code: BackoffCode): number => (code === 'limited' ? LIMITED_BACKOFF_MS : BACKOFF_BASE_MS) * 2 ** (failures - 1);

// The state after a pass: null once a pass has read a list page with no
// refusal, a longer wait after one that was refused.
export function nextBackoff(previous: BackoffState | null, event: BackoffEvent): BackoffState | null {
  if (event.kind === 'ok') {
    return null;
  }
  const failures = (previous?.failures ?? 0) + 1;
  const asked = event.retryAfterMs;
  const askedMs = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 0;
  // The header lengthens a wait but never shortens the schedule, and the cap
  // bounds both, so a bogus header cannot park the spider for days.
  return { until: event.now + Math.min(Math.max(scheduledMs(failures, event.code), askedMs), BACKOFF_CAP_MS), failures, code: event.code };
}

// The state to write after a refusal: next, but never a shorter wait or a
// lower count than the stored state, which the pass may not have read at its
// start. A stored until more than BACKOFF_CAP_MS ahead is not kept:
// backoffDecision ignores it, so kept it would never be honoured again. The
// code is the one whose until is kept.
export function laterBackoff(next: BackoffState, stored: BackoffState | null, now: number): BackoffState {
  if (stored === null) {
    return next;
  }
  const failures = Math.max(next.failures, stored.failures);
  if (stored.until > next.until && stored.until - now <= BACKOFF_CAP_MS) {
    return { until: stored.until, failures, code: stored.code };
  }
  return { ...next, failures };
}

export function backoffDecision(state: BackoffState | null, now: number): BackoffDecision {
  if (state === null || now >= state.until) {
    return { skip: false };
  }
  // No schedule writes a wait this long: the clock that wrote it has since
  // gone back. Honoured, it would skip every pass until the clock caught up,
  // so the pass goes ahead, and the next refusal writes a wait from this clock.
  if (state.until - now > BACKOFF_CAP_MS) {
    return { skip: false };
  }
  return { skip: true, until: state.until, code: state.code };
}

// What the store trusts of what it reads back: rex-core returns whatever was
// written, by any build, so a value of another form counts as none.
export function isBackoffState(value: unknown): value is BackoffState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return typeof state.until === 'number' && Number.isFinite(state.until) && Number.isSafeInteger(state.failures) && (state.failures as number) >= 1 && BACKOFF_CODES.includes(state.code as BackoffCode);
}
