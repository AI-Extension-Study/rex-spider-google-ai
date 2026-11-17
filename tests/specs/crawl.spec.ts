// @ts-nocheck

// The spider in a real MV3 service worker: rex-core, rex-spider and this
// module bundled as the extension bundles them, www.google.com answered by a
// route (google-site.ts), and each pass started by the message the
// extension's alarm sends, or by doBackgroundCrawl where a spec needs two at
// once. Records are read back from a module registered with rex-core, as the
// data-upload module gets them, beside the AI Mode case's output for each
// (tests/src/service-worker.ts). Every id, title and text is made up.
import { createHash } from 'node:crypto'

import { countText } from '../../src/text.mts'
import { MARKERS, NUMBERS } from '../unit/entry-fixtures.mts'
import { ANSWER_CITATIONS, answerText, question } from '../unit/thread-fixtures.mts'
import { test as base, expect } from './fixtures'
import { GoogleSite, SorryPage, blocksOf, createdOf, mstk, mtid, titleOf } from './google-site'

const LOGIN = 'https://www.google.com/'
const DAY = 86_400
// A list time a year before these specs were written: far enough back that
// no spec but the re-send ones depends on the clock.
const T = 1_763_300_000

// After each spec, the site was asked for nothing it did not expect, and
// every request the crawler made is in a form its allow patterns name.
const test = base.extend<{ google: GoogleSite }>({
  google: async ({ context, serviceWorker }, use) => {
    const site = new GoogleSite()
    await site.listen(context)
    await use(site)
    expect(site.unexpected).toEqual([])
    const patterns: string[] = await serviceWorker.evaluate(() => self.rexGoogleAIPlugin.allowedUrls())
    expect(site.urls.filter((url) => !patterns.some((pattern) => new RegExp(pattern).test(url)))).toEqual([])
  },
})

// rex-core answers store messages only once its database is open; a pass
// started before then would end on its storage deadline.
async function untilStoreOpen(serviceWorker) {
  await expect.poll(() => serviceWorker.evaluate(() => new Promise((resolve) => {
    try {
      const handled = self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key: 'rex-spider-google-ai-probe' }, null, () => resolve(true))
      if (!handled) resolve(false)
    } catch {
      resolve(false)
    }
  })), { timeout: 15000 }).toBe(true)
}

// The served config as rex-spider applies it on a refresh. crawl_delay is
// small so a pass takes seconds; the pass still waits its 3 s settle after
// the records and between thread reads. rex-spider starts a crawl once more
// than sleep_delay ms have passed since the last; -1 lets the next start at
// once. No summarize is detail mode.
async function configure(serviceWorker, served = {}) {
  await serviceWorker.evaluate((block) => self.rexSpiderPlugin.updateConfiguration({ spiders: { 'google-ai': block } }), { enabled: true, crawl_delay: 10, sleep_delay: -1, ...served })
}

// One round of the extension's alarm, and the events rex-core dispatched
// during it. rex-spider clears its own crawling flag just after the round
// answers; until then a new round would skip the spider.
async function crawl(serviceWorker) {
  const round = await serviceWorker.evaluate(() => {
    self.eventRecorder.clear()
    return new Promise((resolve) => {
      self.rexCorePlugin.handleMessage({ messageType: 'beginBackgroundCrawls' }, null, (result) => resolve({ result, events: self.eventRecorder.events, redacted: self.eventRecorder.redacted }))
    })
  })
  await expect.poll(() => serviceWorker.evaluate(() => self.rexGoogleAIPlugin.isCrawling())).toBe(false)
  return round
}

const fetchValue = (serviceWorker, key: string) => serviceWorker.evaluate((asked) => new Promise((resolve) => {
  self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key: asked }, null, resolve)
}), key)

const storeValue = (serviceWorker, key: string, value: unknown) => serviceWorker.evaluate(([asked, given]) => new Promise((resolve) => {
  self.rexCorePlugin.handleMessage({ messageType: 'storeValue', key: asked, value: given }, null, resolve)
}), [key, value])

const records = (round) => round.events.filter((event) => event.name === 'rex-conversation')

const reasons = (round) => round.events.filter((event) => event.event_name === 'rex-spider-google-ai-complete').map((event) => event.event_details.reason)

// Each completion event as [crawled_count, crawled_ids, reason], the reason
// without the pass's wall-clock time.
const completions = (round) => round.events
  .filter((event) => event.event_name === 'rex-spider-google-ai-complete')
  .map(({ event_details: details }) => [details.crawled_count, details.crawled_ids, details.reason.replace(/ ms=\d+$/, '')])

// Whole seconds as a DateString writes them.
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const LIST_NUMBERS = Object.fromEntries(Object.entries(NUMBERS))

const metadataOf = (thread) => ({ title_hash: sha256(titleOf(thread.n)), created_at: iso(createdOf(thread)), updated_at: iso(thread.updated), list_numbers: LIST_NUMBERS })

// The records as the data-upload module receives them, every key, built from
// the design's tables rather than from the spider's code.
const summaryRecord = (thread) => ({
  name: 'rex-conversation', platform: 'google-ai-mode', identifier: mtid(thread.n), format_version: 1, is_summary: true,
  date: thread.updated * 1000, started: iso(createdOf(thread)), ended: iso(thread.updated), turns: [], metadata: metadataOf(thread),
})

function turn(speaker: 'user' | 'assistant', text: string, citations: number) {
  const { chars, words } = countText(text)
  return { identifier: null, parent: null, speaker, when: null, on_current_branch: true, text_chars: chars, text_words: words, citation_count: citations, search_result_count: null, attachments: null }
}

// A folwr stream of default blocks: each question, then its answer with the
// fixture's markers.
const turnsOf = (blocks: number) => Array.from({ length: blocks }, (_, at) => [turn('user', question(at + 1), 0), turn('assistant', answerText(at + 1), ANSWER_CITATIONS)]).flat()

const detailRecord = (thread) => ({
  name: 'rex-conversation', platform: 'google-ai-mode', identifier: mtid(thread.n), format_version: 1, is_summary: false,
  date: createdOf(thread) * 1000, started: iso(createdOf(thread)), ended: iso(thread.updated), turns: turnsOf(blocksOf(thread)), turns_complete: true,
  metadata: { ...metadataOf(thread), turn_blocks: blocksOf(thread) },
})

const METADATA_KEYS = ['title_hash', 'created_at', 'updated_at', 'list_numbers']
const TURN_KEYS = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments']
// Every text the site plants: the list's markers, the titles and mstks, and
// the thread page's and stream's text, values and links.
const TEXT = [...MARKERS, 'SECRET-TITLE', 'MstkThread', 'GarcForThread', 'Made-up question', 'made-up highlight', 'A made-up heading', 'CONTROLS-TEXT', 'ASIDE-TEXT', 'SCRIPT-TEXT', 'TIME-TEXT', 'SITE-TEXT', 'FakeXsrf', 'Mlro-Token', 'example.', 'http']

// The design's rules for every record a round sent, whatever was expected:
// the AI Mode case keeps it as it is, so what the extension uploads is what
// was dispatched; the platform and format; metadata's keys exactly; turns
// with the standard keys only and their fixed values, two to a block; and
// no text the site planted.
function expectInLayout(round) {
  const sent = records(round)
  expect(round.redacted).toEqual(sent)
  for (const record of sent) {
    expect([record.platform, record.format_version, typeof record.is_summary]).toEqual(['google-ai-mode', 1, 'boolean'])
    expect(Object.keys(record.metadata).sort()).toEqual([...METADATA_KEYS, ...(record.is_summary ? [] : ['turn_blocks'])].sort())
    for (const each of record.turns) {
      expect(Object.keys(each)).toEqual(TURN_KEYS)
      expect([each.identifier, each.parent, each.when, each.on_current_branch]).toEqual([null, null, null, true])
    }
    expect(record.turns.length).toBe(record.is_summary ? 0 : 2 * record.metadata.turn_blocks)
  }
  const text = JSON.stringify(sent)
  expect(TEXT.filter((marker) => text.includes(marker))).toEqual([])
}

test('served summarize, a pass sends a summary record per listed thread through rex-core, newest first, and the next pass sends none', async ({ google, serviceWorker }) => {
  const [older, newer] = [{ n: 1, updated: T }, { n: 2, updated: T + 600 }]
  google.pages = [[newer, older]]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })

  const first = await crawl(serviceWorker)
  expect(google.requests.splice(0)).toEqual(['home', 'list 0'])
  expect(first.result).toEqual({ sitesCrawled: ['google-ai'], issues: [] })
  expect(records(first)).toEqual([summaryRecord(newer), summaryRecord(older)])
  expectInLayout(first)
  expect(completions(first)).toEqual([[2, [mtid(2), mtid(1)], 'ok seen=2 dispatched=2']])

  const second = await crawl(serviceWorker)
  expect(google.requests.splice(0)).toEqual(['home', 'list 0'])
  expect(records(second)).toEqual([])
  expect(completions(second)).toEqual([[0, [mtid(2), mtid(1)], 'ok seen=2 dispatched=0']])
})

test('served no summarize, a pass reads each listed thread and sends detail records in the record layout, newest first, and the next pass sends none', async ({ google, serviceWorker }) => {
  const [one, three] = [{ n: 1, updated: T, blocks: 1 }, { n: 3, updated: T + 600, blocks: 3 }]
  google.pages = [[three, one]]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(google.requests.splice(0)).toEqual(['home', 'list 0', 'page 3', 'folwr 3', 'page 1', 'folwr 1'])
  expect(first.result).toEqual({ sitesCrawled: ['google-ai'], issues: [] })
  expect(records(first)).toEqual([detailRecord(three), detailRecord(one)])
  expect(records(first).map((record) => [record.identifier, record.is_summary, record.turns.length, record.metadata.turn_blocks])).toEqual([[mtid(3), false, 6, 3], [mtid(1), false, 2, 1]])
  expectInLayout(first)
  expect(completions(first)).toEqual([[2, [mtid(3), mtid(1)], 'ok seen=2 dispatched=2']])

  const second = await crawl(serviceWorker)
  expect(google.requests.splice(0)).toEqual(['home', 'list 0'])
  expect(records(second)).toEqual([])
  expect(completions(second)).toEqual([[0, [mtid(3), mtid(1)], 'ok seen=2 dispatched=0']])
})

// rex-spider's own summarize flag only ever turns on, so the spider keeps its
// own; each mode has its own upload key, and a switch re-sends, once, the
// threads used in the 90 days before the first pass that ran the new mode.
test('summarize true, then false, then true: each switch re-sends only the threads used in the 90 days before it, once', async ({ google, serviceWorker }) => {
  test.setTimeout(60_000)
  const now = Math.floor(Date.now() / 1000)
  const old = { n: 1, updated: now - 100 * DAY }
  const recent = { n: 2, updated: now - 3600 }
  google.pages = [[recent, old]]
  await untilStoreOpen(serviceWorker)
  const modeSince = async (from: number) => {
    const record = await fetchValue(serviceWorker, 'rex-spider-google-ai-mode')
    expect(record.since).toBeGreaterThanOrEqual(from)
    expect(record.since).toBeLessThanOrEqual(Date.now())
    return record.mode
  }

  await configure(serviceWorker, { summarize: true })
  let from = Date.now()
  const first = await crawl(serviceWorker)
  expect(records(first)).toEqual([summaryRecord(recent), summaryRecord(old)])
  expect(await modeSince(from)).toBe('summary')

  // A thread first listed while detail is served goes out in detail only.
  const fresh = { n: 3, updated: now - 60 }
  google.pages = [[fresh, recent, old]]
  google.requests.splice(0)
  await configure(serviceWorker)
  from = Date.now()
  const second = await crawl(serviceWorker)
  expect(google.requests.splice(0)).toEqual(['home', 'list 0', 'page 3', 'folwr 3', 'page 2', 'folwr 2'])
  expect(records(second)).toEqual([detailRecord(fresh), detailRecord(recent)])
  expectInLayout(second)
  expect(completions(second)).toEqual([[2, [mtid(3), mtid(2), mtid(1)], 'ok seen=3 dispatched=2']])
  expect(await modeSince(from)).toBe('detail')

  await configure(serviceWorker, { summarize: true })
  from = Date.now()
  const third = await crawl(serviceWorker)
  expect(records(third)).toEqual([summaryRecord(fresh)])
  expectInLayout(third)
  expect(completions(third)).toEqual([[1, [mtid(3), mtid(2), mtid(1)], 'ok seen=3 dispatched=1']])
  expect(await modeSince(from)).toBe('summary')

  const fourth = await crawl(serviceWorker)
  expect(records(fourth)).toEqual([])
  expect(completions(fourth)).toEqual([[0, [mtid(3), mtid(2), mtid(1)], 'ok seen=3 dispatched=0']])
})

// The spider before this rewrite keyed both modes alike, by <mstk>_<mtid>
// and the list's [6] in ms. Its keys count as sent in the other mode, so the
// update re-sends, once, only the threads used in the 90 days before it.
for (const mode of ['summary', 'detail'] as const) {
  test(`after an update, served ${mode}, a thread the old spider sent goes out again only if used in the 90 days before, and one it never sent goes out`, async ({ google, serviceWorker }) => {
    test.setTimeout(60_000)
    const now = Math.floor(Date.now() / 1000)
    const oldSent = { n: 1, updated: now - 100 * DAY }
    const recentSent = { n: 2, updated: now - 3600 }
    const neverSent = { n: 3, updated: now - 120 * DAY }
    google.pages = [[recentSent, oldSent, neverSent]]
    await untilStoreOpen(serviceWorker)
    for (const thread of [oldSent, recentSent]) {
      expect(await storeValue(serviceWorker, `rex-spider-google-ai-conversation-upload-${mstk(thread.n)}_${mtid(thread.n)}-${thread.updated * 1000}`, Date.now())).toBe(true)
    }
    await configure(serviceWorker, mode === 'summary' ? { summarize: true } : {})

    const round = await crawl(serviceWorker)
    const build = mode === 'summary' ? summaryRecord : detailRecord
    expect(google.requests.splice(0)).toEqual(mode === 'summary' ? ['home', 'list 0'] : ['home', 'list 0', 'page 2', 'folwr 2', 'page 3', 'folwr 3'])
    expect(records(round)).toEqual([build(recentSent), build(neverSent)])
    expectInLayout(round)
    expect(completions(round)).toEqual([[2, [mtid(2), mtid(1), mtid(3)], 'ok seen=3 dispatched=2']])

    const next = await crawl(serviceWorker)
    expect(google.requests.splice(0)).toEqual(['home', 'list 0'])
    expect(records(next)).toEqual([])
  })
}

test('signed out, the pass ends at the home page with count -1, its reason in the issues, no list request and no back-off', async ({ google, serviceWorker }) => {
  google.signedIn = false
  google.pages = [[{ n: 1, updated: T }]]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const round = await crawl(serviceWorker)
  expect(google.requests).toEqual(['home'])
  expect(records(round)).toEqual([])
  const [reason] = reasons(round)
  expect(reason).toMatch(/^not-signed-in stage=home ms=\d+$/)
  expect(completions(round)).toEqual([[-1, [], 'not-signed-in stage=home']])
  expect(round.result).toEqual({ sitesCrawled: ['google-ai'], issues: [{ url: LOGIN, message: reason }] })
  expect(await fetchValue(serviceWorker, 'rex-spider-google-ai-backoff')).toBeNull()
})

// A Retry-After longer than the first back-off's 5 minutes, so the stored
// wait shows the header came through the worker's fetch.
test('a 429 on a thread read stops the pass after the record before it, and the back-off it sets skips the next pass with no request', async ({ google, serviceWorker }) => {
  const [first, second] = [{ n: 1, updated: T }, { n: 2, updated: T + 600 }]
  google.pages = [[second, first]]
  google.replies.set('folwr 1', { status: 429, headers: { 'Retry-After': '900' }, contentType: 'text/html', body: '<html>SITE-TEXT too many requests</html>' })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const before = Date.now()
  const round = await crawl(serviceWorker)
  const after = Date.now()
  expect(google.requests.splice(0)).toEqual(['home', 'list 0', 'page 2', 'folwr 2', 'page 1', 'folwr 1'])
  expect(records(round)).toEqual([detailRecord(second)])
  expectInLayout(round)
  expect(completions(round)).toEqual([[1, [mtid(2), mtid(1)], 'ok seen=2 dispatched=1 left=1 stop=rate-limited']])
  const backoff = await fetchValue(serviceWorker, 'rex-spider-google-ai-backoff')
  expect(backoff).toEqual({ until: expect.any(Number), failures: 1, code: 'rate-limited' })
  expect(backoff.until).toBeGreaterThanOrEqual(before + 900_000)
  expect(backoff.until).toBeLessThanOrEqual(after + 900_000)

  const skipped = await crawl(serviceWorker)
  const reason = `backoff until=${new Date(backoff.until).toISOString()} code=rate-limited`
  expect(google.requests).toEqual([])
  expect(completions(skipped)).toEqual([[-1, [], reason]])
  expect(skipped.result).toEqual({ sitesCrawled: ['google-ai'], issues: [{ url: LOGIN, message: reason }] })
})

test('a redirect to /sorry/ ends the pass as a challenge, read from the URL the fetch ended on, and the back-off skips the next pass', async ({ google, serviceWorker }) => {
  const sorry = new SorryPage()
  google.pages = [[{ n: 1, updated: T }]]
  google.replies.set('list 0', { status: 302, headers: { Location: await sorry.start() } })
  try {
    await untilStoreOpen(serviceWorker)
    await configure(serviceWorker, { summarize: true })

    const before = Date.now()
    const round = await crawl(serviceWorker)
    const after = Date.now()
    expect(google.requests.splice(0)).toEqual(['home', 'list 0'])
    expect(sorry.requests).toEqual([SorryPage.PATH])
    expect(records(round)).toEqual([])
    const [reason] = reasons(round)
    expect(reason).toMatch(/^challenge stage=list status=200 ms=\d+$/)
    expect(completions(round)).toEqual([[-1, [], 'challenge stage=list status=200']])
    expect(round.result).toEqual({ sitesCrawled: ['google-ai'], issues: [{ url: LOGIN, message: reason }] })
    const backoff = await fetchValue(serviceWorker, 'rex-spider-google-ai-backoff')
    expect(backoff).toEqual({ until: expect.any(Number), failures: 1, code: 'challenge' })
    expect(backoff.until).toBeGreaterThanOrEqual(before + 300_000)
    expect(backoff.until).toBeLessThanOrEqual(after + 300_000)

    const skipped = await crawl(serviceWorker)
    expect(google.requests).toEqual([])
    expect(sorry.requests).toEqual([SorryPage.PATH])
    expect(completions(skipped)).toEqual([[-1, [], `backoff until=${new Date(backoff.until).toISOString()} code=challenge`]])
  } finally {
    await sorry.stop()
  }
})

test('a list of three pages is walked by its cursors, and every thread on it goes out, newest first', async ({ google, serviceWorker }) => {
  const threads = [5, 4, 3, 2, 1].map((n) => ({ n, updated: T + n * 600 }))
  google.pages = [threads.slice(0, 2), threads.slice(2, 4), threads.slice(4)]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })

  const round = await crawl(serviceWorker)
  expect(google.requests).toEqual(['home', 'list 0', 'list 1', 'list 2'])
  expect(records(round)).toEqual(threads.map(summaryRecord))
  expectInLayout(round)
  expect(completions(round)).toEqual([[5, threads.map((thread) => mtid(thread.n)), 'ok seen=5 dispatched=5']])
})

// rex-spider serves these patterns, and rex-page-manipulation makes each an
// allow rule, the only way the thread page request gets past a block arm's
// redirect. Each URL matches exactly one pattern, its own form's.
test('every request a pass makes is in a form allowedUrls() names, as rex-spider serves them, each form its own pattern', async ({ google, serviceWorker }) => {
  google.pages = [[{ n: 2, updated: T + 600 }], [{ n: 1, updated: T }]]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  await crawl(serviceWorker)
  expect(google.requests).toEqual(['home', 'list 0', 'list 1', 'page 2', 'folwr 2', 'page 1', 'folwr 1'])
  const served: string[] = await serviceWorker.evaluate(() => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'fetchAllowedURLs' }, null, resolve)
  }))
  expect(served).toEqual(await serviceWorker.evaluate(() => self.rexGoogleAIPlugin.allowedUrls()))
  const matching = (url: string) => served.flatMap((pattern, index) => (new RegExp(pattern).test(url) ? [index] : []))
  expect(google.urls.map(matching)).toEqual([[0], [1], [1], [2], [3], [2], [3]])
})

// The alarm starts a round every minute, and a pass can take longer.
// rex-spider's own crawling flag is set only once the store write made at the
// start of a crawl is answered, so the spider's flag is checked at once. The
// first pass is held at its home page request.
test('a second crawl while a pass runs starts none and makes no request, and the spider says it is crawling from the moment the first starts until it ends', async ({ google, serviceWorker }) => {
  google.pages = [[{ n: 1, updated: T }]]
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })
  const home = google.hold('home')
  let second
  let whileHeld
  try {
    const atStart = await serviceWorker.evaluate(() => {
      self.eventRecorder.clear()
      self.firstPass = self.rexGoogleAIPlugin.doBackgroundCrawl()
      return self.rexGoogleAIPlugin.isCrawling()
    })
    expect(atStart).toBe(true)
    await home.reached
    second = await serviceWorker.evaluate(async () => {
      const crawling = self.rexGoogleAIPlugin.isCrawling()
      return { crawling, result: await self.rexGoogleAIPlugin.doBackgroundCrawl() }
    })
    whileHeld = [...google.requests]
  } finally {
    home.release()
  }
  expect(second).toEqual({ crawling: true, result: { sitesCrawled: ['google-ai'], issues: [{ url: LOGIN, message: 'a pass is already running' }] } })
  expect(whileHeld).toEqual(['home'])

  expect(await serviceWorker.evaluate(() => self.firstPass)).toEqual({ sitesCrawled: ['google-ai'], issues: [] })
  await expect.poll(() => serviceWorker.evaluate(() => self.rexGoogleAIPlugin.isCrawling())).toBe(false)
  expect(google.requests).toEqual(['home', 'list 0'])
  const events = await serviceWorker.evaluate(() => self.eventRecorder.events)
  expect(completions({ events })).toEqual([[1, [mtid(1)], 'ok seen=1 dispatched=1']])
})
