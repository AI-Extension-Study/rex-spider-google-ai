// @ts-nocheck

// The spider as the extension loads it, in a real service worker: the module
// registers one Google AI Mode spider with rex-spider, its flags follow every
// configuration update both ways, and Chrome takes its allow patterns as
// rules that let its own requests past a block arm's redirect and nothing
// else. A crawl against a mocked www.google.com is a later spec.
import { test, expect } from './fixtures'

test('the module registers one Google AI Mode spider with rex-spider', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    return {
      identifier: spider.identifier(),
      name: spider.name(),
      loginUrl: spider.loginUrl(),
      registered: self.rexSpiderPlugin.registeredSpiders.includes(spider),
      count: self.rexSpiderPlugin.registeredSpiders.filter((each) => each.identifier() === 'google-ai').length,
      flags: [typeof spider.summarizes, typeof spider.haltsOnError],
    }
  })
  expect(seen).toEqual({ identifier: 'google-ai', name: 'Google AI Mode', loginUrl: 'https://www.google.com/', registered: true, count: 1, flags: ['boolean', 'boolean'] })
})

test('summarize and halt_on_error take effect both ways on every configuration update', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    const summarizes = []
    for (const configuration of [{ summarize: true }, { summarize: false }, { summarize: true }, {}]) {
      spider.updateConfiguration(configuration)
      summarizes.push(spider.justSummarize())
    }
    const continues = []
    for (const configuration of [{ halt_on_error: false }, {}, { halt_on_error: false }, { halt_on_error: true }]) {
      spider.updateConfiguration(configuration)
      continues.push(spider.continueAfterError())
    }
    return { summarizes, continues }
  })
  expect(seen).toEqual({ summarizes: [true, false, true, false], continues: [true, false, true, false] })
})

test('the same holds through rex-spider\'s own refresh, which merges the default block under the spider\'s', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    const refresh = (block) => self.rexSpiderPlugin.updateConfiguration({ spiders: { default: { enabled: true, halt_on_error: false }, 'google-ai': block } })
    const states = []
    for (const block of [{ enabled: true, summarize: true }, { enabled: true, summarize: false }, { enabled: true }, { enabled: true, halt_on_error: true }]) {
      refresh(block)
      states.push([spider.justSummarize(), spider.continueAfterError()])
    }
    return states
  })
  expect(seen).toEqual([[true, true], [false, true], [false, true], [false, false]])
})

// The extension serves its data format as data_format in every spider block.
// Read at every update like summarize: a block without it, or with a value
// that is not a whole number from 1 to 999, is format 1, as before.
test('data_format takes effect both ways on every configuration update, and any other value than 1 to 999 reads as format 1', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    const formats = [spider.dataFormat()]
    for (const configuration of [{ data_format: 2 }, {}, { data_format: 999 }, { data_format: 3, summarize: true }, { summarize: true }]) {
      spider.updateConfiguration(configuration)
      formats.push(spider.dataFormat())
    }
    const others = []
    for (const value of [0, -1, 1.5, '2', null, 1000, true]) {
      spider.updateConfiguration({ data_format: 2 })
      spider.updateConfiguration({ data_format: value })
      others.push(spider.dataFormat())
    }
    return { formats, others }
  })
  expect(seen).toEqual({ formats: [1, 2, 1, 999, 3, 1], others: [1, 1, 1, 1, 1, 1, 1] })
})

test('data_format reaches the spider through rex-spider\'s refresh, from the default block or the spider\'s own, the spider\'s winning', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    const refresh = (spiders) => self.rexSpiderPlugin.updateConfiguration({ spiders })
    const formats = []
    for (const spiders of [
      { default: { enabled: true, data_format: 2 }, 'google-ai': { enabled: true } },
      { default: { enabled: true }, 'google-ai': { enabled: true } },
      { default: { enabled: true, data_format: 2 } },
      { default: { enabled: true, data_format: 2 }, 'google-ai': { enabled: true, data_format: 3 } },
      { 'google-ai': { enabled: true } },
    ]) {
      refresh(spiders)
      formats.push(spider.dataFormat())
    }
    return formats
  })
  expect(seen).toEqual([2, 1, 2, 3, 1])
})

test('a served enabled false and crawl_delay reach the spider, directly and through rex-spider\'s refresh', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(() => {
    const spider = self.rexGoogleAIPlugin
    const states = []
    spider.updateConfiguration({ enabled: true, crawl_delay: 1234 })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    spider.updateConfiguration({ enabled: false })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    self.rexSpiderPlugin.updateConfiguration({ spiders: { 'google-ai': { enabled: true, crawl_delay: 4321 } } })
    states.push([spider.isEnabled(), spider.fetchCrawlDelay()])
    return states
  })
  expect(seen).toEqual([[true, 1234], [false, 1234], [true, 4321]])
})

// The crawler's four request forms, and requests a block arm must keep
// blocked, all with made-up values.
const G = 'https://www.google.com'
const MSTK = 'MstkThread-00000000000000000001'
const MTID = 'MtidThread_00000000001'
const CRAWLER = [
  `${G}/?hl=en`,
  `${G}/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=%5Bnull%2C20%2C0%2Cnull%2Cnull%5D&msc=gwsclient`,
  `${G}/search?udm=50&mstk=${MSTK}&mtid=${MTID}&csuir=1&hl=en`,
  `${G}/async/folwr?async=_fmt%3Aprog%2C_xsrf%3AMadeUpXsrf0123%3A1763300000000&garc=MadeUpGarc0123&mlro=Made-Up_Mlro0123&mlros=MadeUp0123&ei=MadeUpEi-0123456789_abc`,
]
const THREAD_PAGE = CRAWLER[2]
const BLOCKED = [
  ['an AI Mode question, as a page', `${G}/search?udm=50&hl=en&q=made+up`, 'main_frame'],
  ['an AI Mode question, as a request', `${G}/search?udm=50&hl=en&q=made+up`, 'xmlhttprequest'],
  ['a thread opened from the history list', `${G}/search?udm=50&hl=en&atvm=1&sxsrf=MadeUp&mstk=${MSTK}&mtid=${MTID}&csuir=1&aep=26&q=made+up&ved=MadeUp`, 'main_frame'],
  ['the crawler\'s thread page form, opened as a page', THREAD_PAGE, 'main_frame'],
]

test('Chrome takes every allow pattern as a rule, and with a block arm\'s redirect the crawler\'s requests get through while AI Mode stays blocked', async ({ serviceWorker }) => {
  const seen = await serviceWorker.evaluate(async ({ crawler, blocked }) => {
    const dnr = chrome.declarativeNetRequest
    const patterns = self.rexGoogleAIPlugin.allowedUrls()
    // Case-insensitive, as rex-page-manipulation's rules are (it does not set
    // isUrlFilterCaseSensitive).
    const supported = []
    for (const regex of patterns) supported.push(await dnr.isRegexSupported({ regex, isCaseSensitive: false }))
    // Room under Chrome's 2 KB compiled limit: each pattern still fits with two
    // more parameters of the widest value class any form has used. A pattern
    // Chrome refuses fails rex-page-manipulation's whole rule update, every
    // arm's redirects with it, and fetchAllowedURLs hands it every enabled
    // spider's patterns.
    const GROW = '&x=[A-Za-z0-9*._%-]+&y=[A-Za-z0-9*._%-]+'
    const grown = []
    for (const regex of patterns) grown.push(await dnr.isRegexSupported({ regex: `${regex.slice(0, -1)}${GROW}$`, isCaseSensitive: false }))
    const fromModule = await new Promise((resolve) => self.rexSpiderPlugin.handleMessage({ messageType: 'fetchAllowedURLs' }, null, resolve))
    // As rex-page-manipulation builds them: the block arm's redirect, and an
    // allow rule at priority 1000 for each pattern.
    const BLOCK = 9100
    const types = ['script', 'xmlhttprequest', 'websocket', 'webtransport']
    const rules = [
      { id: BLOCK, priority: 1, condition: { regexFilter: '^https?://(www\\.)?google\\.(com|ca|co\\.uk)/search.*[?&]udm=50(&|$)', resourceTypes: ['main_frame', 'sub_frame', ...types] }, action: { type: 'redirect', redirect: { url: 'https://example.com/restricted.html' } } },
      ...patterns.map((regexFilter, index) => ({ id: 9000 + index, priority: 1000, condition: { regexFilter, resourceTypes: types }, action: { type: 'allow' } })),
    ]
    const outcome = {}
    try {
      await dnr.updateDynamicRules({ addRules: rules })
      outcome.added = (await dnr.getDynamicRules()).length
      const winner = async (url, type) => (await dnr.testMatchOutcome({ url, type, method: 'get', initiator: 'https://www.google.com' })).matchedRules.map((rule) => rule.ruleId)
      outcome.crawler = []
      for (const url of crawler) outcome.crawler.push(await winner(url, 'xmlhttprequest'))
      outcome.blocked = []
      for (const [, url, type] of blocked) outcome.blocked.push(await winner(url, type))
    } catch (error) {
      outcome.error = String(error)
    } finally {
      await dnr.updateDynamicRules({ removeRuleIds: rules.map((rule) => rule.id) })
    }
    return { patterns, supported, grown, fromModule, ...outcome }
  }, { crawler: CRAWLER, blocked: BLOCKED })
  expect(seen.error).toBeUndefined()
  expect(seen.patterns.length).toBe(4)
  expect(seen.supported).toEqual(seen.patterns.map(() => ({ isSupported: true })))
  expect(seen.grown).toEqual(seen.patterns.map(() => ({ isSupported: true })))
  expect([...seen.fromModule].sort()).toEqual([...seen.patterns].sort())
  expect(seen.added).toBe(5)
  // Each crawler request matches its own allow rule, the thread page past the redirect.
  expect(seen.crawler).toEqual([[9000], [9001], [9002], [9003]])
  expect(seen.blocked).toEqual(BLOCKED.map(() => [9100]))
})
