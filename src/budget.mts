// The read budget, pure. Google answers the crawler's thread page with its
// limited page after about 40 requests in 7 to 25 minutes, at any pace (live
// runs, 2026-11-17), so a detail pass reads at most READ_BUDGET.reads
// threads in any READ_BUDGET.windowMs, counted across passes. The times are
// what the store keeps under READS_KEY (store.mts, AimStore's reads): the
// pass counts them before each thread read, and stores withRead's list just
// before the read's page request, so a read that fails counts too.
import { CLOCK_SKEW_MS } from './mode.mts';

export interface ReadBudget {
  readonly reads: number;
  readonly windowMs: number;
}

// A thread read is two requests (the page and folwr), so 15 reads are 30
// thread requests an hour; a first sweep of 60 threads takes about 4 hours.
// To be checked in a live run before release.
export const READ_BUDGET: ReadBudget = { reads: 15, windowMs: 3_600_000 };

// A thread page with none of the four data- attributes is taken for Google's
// limited page only when at least this many reads are stored in the
// LIMITED_WINDOW_MS before it; with fewer it is a layout failure, with its
// summary and memo. On the one account tested live (2026-11-17), the limit
// came only after 19 to 36 thread reads, never on an early read, while a
// change to Google's markup that drops the four would show from the first.
export const LIMITED_AFTER_READS = 5;

// The window LIMITED_AFTER_READS counts over: 3 hours, not the read budget's
// hour. The reads that met Google's limit are about an hour old when its
// 60-minute back-off ends, so a limit that outlasts the back-off must still
// read as limited, or the first reads after it would go out as layout
// failures and the clean list read would clear the back-off. The store keeps
// the newest READ_BUDGET.reads times whatever their age (withRead), so up to
// 15 count here.
export const LIMITED_WINDOW_MS = 3 * 3_600_000;

// A stored time further ahead of now than CLOCK_SKEW_MS was written under a
// clock that ran fast, as the mode record's start (mode.mts): kept, it would
// count until the clock caught up. One less far ahead still counts, so a
// clock that went back makes no read uncounted.
const believable = (now: number) => (time: number): boolean => time <= now + CLOCK_SKEW_MS;

// The reads that count against the budget now: those less than windowMs old.
export function readsInWindow(times: readonly number[], now: number, budget: ReadBudget): number {
  return times.filter((time) => believable(now)(time) && now - time < budget.windowMs).length;
}

// The times to store for a read that starts now: the believable ones and
// now, oldest first, kept to the newest budget.reads, as no more can count.
export function withRead(times: readonly number[], now: number, budget: ReadBudget): number[] {
  return [...times.filter(believable(now)), now].sort((a, b) => a - b).slice(-budget.reads);
}
