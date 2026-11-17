import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_CODES, type BackoffState, LIMITED_BACKOFF_MS, backoffDecision, isBackoffState, nextBackoff } from '../../src/backoff.mts';

const NOW = Date.UTC(2026, 10, 20, 12);
const MINUTE = 60_000;
const refused = (retryAfterMs?: number | null, now = NOW) => ({ kind: 'refused' as const, now, code: 'rate-limited' as const, retryAfterMs });

test('the back-off is 5 minutes, doubling with each refusal in a row, to at most 6 hours', () => {
  assert.equal(BACKOFF_BASE_MS, 5 * MINUTE);
  assert.equal(BACKOFF_CAP_MS, 6 * 60 * MINUTE);
  let state: BackoffState | null = null;
  const waits: number[] = [];
  for (let refusal = 0; refusal < 9; refusal += 1) {
    state = nextBackoff(state, refused());
    waits.push(((state as BackoffState).until - NOW) / MINUTE);
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 320, 360, 360]);
  assert.equal(state?.failures, 9);
  assert.equal(state?.code, 'rate-limited');
});

test('a Retry-After lengthens the wait and never shortens it, and the cap bounds it too', () => {
  assert.equal(nextBackoff(null, refused(60 * MINUTE))?.until, NOW + 60 * MINUTE);
  // 120 s asks for less than the 5 minutes the schedule gives.
  assert.equal(nextBackoff(null, refused(120_000))?.until, NOW + 5 * MINUTE);
  let three: BackoffState | null = null;
  for (let refusal = 0; refusal < 3; refusal += 1) {
    three = nextBackoff(three, refused());
  }
  // The fourth refusal's schedule is 40 minutes, longer than the 30 the header asks.
  assert.equal(nextBackoff(three, refused(30 * MINUTE))?.until, NOW + 40 * MINUTE);
  assert.equal(nextBackoff(null, refused(48 * 60 * MINUTE))?.until, NOW + BACKOFF_CAP_MS);
});

test('a Retry-After that is absent or not a positive number leaves the schedule as it is', () => {
  for (const retryAfterMs of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(nextBackoff(null, refused(retryAfterMs))?.until, NOW + 5 * MINUTE, String(retryAfterMs));
  }
});

// Google's limited page (read.mts) lasts tens of minutes, not the minutes a
// 429 asks for, so it has its own base.
const limited = (now = NOW) => ({ kind: 'refused' as const, now, code: 'limited' as const });

test('the codes are the 429 or 503, Google\'s /sorry/ page and its limited thread page', () => {
  assert.deepEqual([...BACKOFF_CODES], ['rate-limited', 'challenge', 'limited']);
});

test('Google\'s limited page sets a back-off of 60 minutes, doubling with each in a row, to at most 6 hours', () => {
  assert.equal(LIMITED_BACKOFF_MS, 3_600_000);
  let state: BackoffState | null = null;
  const waits: number[] = [];
  for (let refusal = 0; refusal < 6; refusal += 1) {
    state = nextBackoff(state, limited());
    waits.push(((state as BackoffState).until - NOW) / MINUTE);
  }
  assert.deepEqual(waits, [60, 120, 240, 360, 360, 360]);
  assert.deepEqual([state?.failures, state?.code], [6, 'limited']);
  assert.deepEqual(backoffDecision(nextBackoff(null, limited()), NOW + MINUTE), { skip: true, until: NOW + 60 * MINUTE, code: 'limited' });
  assert.deepEqual(backoffDecision(nextBackoff(null, limited()), NOW + 60 * MINUTE), { skip: false });
});

test('the 429 and the /sorry/ page keep their 5-minute base', () => {
  assert.equal(nextBackoff(null, refused())?.until, NOW + 5 * MINUTE);
  assert.equal(nextBackoff(null, { kind: 'refused', now: NOW, code: 'challenge' })?.until, NOW + 5 * MINUTE);
});

// One count of refusals in a row, whatever asked for each, as the 429 and the
// /sorry/ page already share; each wait is from the base of the code that
// asked for it.
test('refusals in a row are counted across codes, and each wait is from its own code\'s base', () => {
  const twice = nextBackoff(nextBackoff(null, refused()), refused());
  const third = nextBackoff(twice, limited()) as BackoffState;
  assert.deepEqual([third.failures, (third.until - NOW) / MINUTE, third.code], [3, 240, 'limited']);
  const fourth = nextBackoff(third, refused()) as BackoffState;
  assert.deepEqual([fourth.failures, (fourth.until - NOW) / MINUTE, fourth.code], [4, 40, 'rate-limited']);
});

test('the code a refusal carries is kept, for the skipped passes\' reason', () => {
  assert.equal(nextBackoff(null, { kind: 'refused', now: NOW, code: 'challenge' })?.code, 'challenge');
});

test('a pass is skipped while the back-off runs, and not once it has run out', () => {
  const state = nextBackoff(null, refused()) as BackoffState;
  assert.deepEqual(backoffDecision(state, NOW + MINUTE), { skip: true, until: NOW + 5 * MINUTE, code: 'rate-limited' });
  assert.deepEqual(backoffDecision(state, NOW + 5 * MINUTE), { skip: false });
  assert.deepEqual(backoffDecision(null, NOW), { skip: false });
});

test('a stored wait more than 6 hours ahead is ignored: no schedule writes one, so the clock has gone back', () => {
  const state: BackoffState = { until: NOW + BACKOFF_CAP_MS + 1, failures: 3, code: 'rate-limited' };
  assert.deepEqual(backoffDecision(state, NOW), { skip: false });
  assert.deepEqual(backoffDecision({ ...state, until: NOW + BACKOFF_CAP_MS }, NOW), { skip: true, until: NOW + BACKOFF_CAP_MS, code: 'rate-limited' });
});

test('a pass that read a list page without a refusal clears it', () => {
  assert.equal(nextBackoff(nextBackoff(null, refused()), { kind: 'ok' }), null);
});

test('only a stored value of the back-off\'s own form is trusted', () => {
  assert.equal(isBackoffState({ until: NOW, failures: 1, code: 'rate-limited' }), true);
  assert.equal(isBackoffState({ until: NOW, failures: 2, code: 'challenge' }), true);
  assert.equal(isBackoffState({ until: NOW, failures: 3, code: 'limited' }), true);
  for (const bad of [null, 'x', [], {}, { until: NOW, failures: 0, code: 'rate-limited' }, { until: NOW, failures: 1.5, code: 'rate-limited' },
    { until: Number.NaN, failures: 1, code: 'rate-limited' }, { until: NOW, failures: 1, code: 'provider-refused' }, { until: NOW, failures: 1 }]) {
    assert.equal(isBackoffState(bad), false, JSON.stringify(bad));
  }
});
