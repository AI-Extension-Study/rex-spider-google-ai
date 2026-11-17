// www.google.com as the spider reads it, for the worker specs: the home page,
// ListThreads page by page, and each listed thread's page and folwr, built
// from the unit fixtures and answered by a route on the browser context,
// which sees the extension service worker's requests. A request is answered
// only when its URL is exactly one of the crawler's forms (the plan's request
// list) for a thread or page the site lists and it carries the browser's
// made-up Google session cookie, and is written down by a short label. Any
// other http(s) request, to any host, is aborted and kept in the fixtures'
// unexpected list, which fails the spec. A request no route sees (one a
// redirect leads to, or any made before the fixtures' first route is in)
// meets their resolver rules, with no proxy, so nothing reaches the real
// google.com. Every id, title and text is made up.
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { BrowserContext, Route } from '@playwright/test'

import { rawEntry } from '../unit/entry-fixtures.mts'
import { FOLWR_VALUES, limitedPage, threadPage, threadStream } from '../unit/thread-fixtures.mts'

// Thread n's ids in the list's forms: an mtid of 22 characters and an mstk
// of 31, and the garc its thread page carries, so a folwr request names its
// thread. The list cursor before page k (k >= 1) is in id form too.
export const mtid = (n: number): string => `MtidThread_${String(n).padStart(11, '0')}`
export const mstk = (n: number): string => `MstkThread-${String(n).padStart(20, '0')}`
const garcOf = (n: number): string => `GarcForThread${n}`
const cursorOf = (k: number): string => `Cursor-${String(k).padStart(26, '0')}`
export const titleOf = (n: number): string => `SECRET-TITLE of made-up thread ${n}`

// One listed thread: its number, its last use ([6]) in epoch seconds, and the
// turn blocks its folwr stream holds. It was created ([5]) an hour before.
export interface Thread {
  readonly n: number
  readonly updated: number
  readonly blocks?: number
}

export const createdOf = (thread: Thread): number => thread.updated - 3600
export const blocksOf = (thread: Thread): number => thread.blocks ?? 1

export const HOME_URL = 'https://www.google.com/?hl=en'
export const listUrl = (cursor: string | null): string => `https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=${encodeURIComponent(JSON.stringify([null, 20, 0, null, cursor]))}&msc=gwsclient`
export const pageUrl = (n: number): string => `https://www.google.com/search?udm=50&mstk=${mstk(n)}&mtid=${mtid(n)}&csuir=1&hl=en`
export const folwrUrl = (n: number): string => `https://www.google.com/async/folwr?${new URLSearchParams({ async: `_fmt:prog,_xsrf:${FOLWR_VALUES.xsrf}`, garc: garcOf(n), mlro: FOLWR_VALUES.mlro, mlros: FOLWR_VALUES.mlros, ei: FOLWR_VALUES.ei })}`

const SIGNED_IN = '<!doctype html><html><body><a href="https://accounts.google.com/SignOutOptions?hl=en">SITE-TEXT account</a></body></html>'
// A signed-out page still holds the SNlM0e token the old spider read.
const SIGNED_OUT = '<!doctype html><html><script>"SNlM0e":"made-up"</script><body><a aria-label="Sign in">SITE-TEXT Sign in</a></body></html>'

// The raw entry the list holds for a thread: the fixture's 31 positions with
// their markers, and this thread's ids, title and times.
function entryOf(thread: Thread): unknown[] {
  const { n } = thread
  return rawEntry({
    0: [mstk(n), mtid(n)], 1: titleOf(n), 5: [createdOf(thread), 741_739_000], 6: [thread.updated, 263_669_000],
    22: [['mtid', mtid(n)], ['csuir', '1'], ['mstk', mstk(n)], ['udm', '50']],
  })
}

const listBody = (entries: readonly unknown[], cursor: string | null): string => `)]}'\n\n${JSON.stringify(cursor === null ? [entries, null, 1] : [entries, null, 1, null, null, cursor])}`

// What a route answers with.
export interface Reply {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly contentType?: string
  readonly body?: string
}

const html = (body: string): Reply => ({ status: 200, contentType: 'text/html; charset=utf-8', body })

// The browser's Google session, made up. Every crawler request must carry
// it: the spider reads the participant's account only through the cookies
// its fetch sends. SameSite=None so the route can see it: the cookie header
// a route reads for the worker's request holds only None cookies, though
// Chrome sends Lax and Strict ones with the request too.
export const SESSION_COOKIE = { name: 'MADE_UP_SID', value: 'made-up-session', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' as const }
const SESSION = `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}`

export class GoogleSite {
  // The list, page by page, newest first; each page but the last hands out
  // the next one's cursor. A spec may change it between passes.
  pages: Thread[][] = [[]]

  signedIn = true

  // The thread page read, counted from 1 over every pass, from which on the
  // site answers each thread page with Google's limited page (a 200 search
  // page with none of the five values), as Google did after about 40
  // requests; null for never.
  limitedFrom: number | null = null

  // Thread pages answered so far.
  private pageReads = 0

  // An answer in place of the site's own, by label, for every request with
  // that label until it is deleted.
  readonly replies = new Map<string, Reply>()

  // Each request answered, by label, in order: home, list <k>, page <n>,
  // folwr <n>. A spec takes them with splice(0).
  readonly requests: string[] = []

  // The URL of every request answered, in order.
  readonly urls: string[] = []

  private readonly gates = new Map<string, { readonly reach: () => void; readonly released: Promise<void> }>()

  // The fixtures' list, which fails the spec on any entry.
  private readonly unexpected: string[]

  constructor(unexpected: string[]) {
    this.unexpected = unexpected
  }

  // Plants the session cookie and answers every http(s) request from now on.
  async listen(context: BrowserContext): Promise<void> {
    await context.addCookies([SESSION_COOKIE])
    await context.route(/^https?:\/\//, (route) => this.answer(route))
  }

  // Holds the next request with this label until release is called; reached
  // resolves when that request comes.
  hold(label: string): { reached: Promise<void>; release: () => void } {
    let reach: () => void = () => {}
    let release: () => void = () => {}
    const reached = new Promise<void>((resolve) => { reach = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    this.gates.set(label, { reach, released })
    return { reached, release }
  }

  // Every thread the list holds now.
  threads(): Thread[] {
    return this.pages.flat()
  }

  // The label of a URL in one of the crawler's forms for what the site lists
  // now, or null.
  private labelOf(url: string): string | null {
    if (url === HOME_URL) return 'home'
    for (let k = 0; k < this.pages.length; k += 1) {
      if (url === listUrl(k === 0 ? null : cursorOf(k))) return `list ${k}`
    }
    for (const { n } of this.threads()) {
      if (url === pageUrl(n)) return `page ${n}`
      if (url === folwrUrl(n)) return `folwr ${n}`
    }
    return null
  }

  private ownReply(label: string): Reply {
    const [kind, at] = label.split(' ')
    const index = Number(at)
    if (kind === 'home') return html(this.signedIn ? SIGNED_IN : SIGNED_OUT)
    if (kind === 'list') {
      const cursor = index + 1 < this.pages.length ? cursorOf(index + 1) : null
      return { status: 200, contentType: 'application/json; charset=utf-8', body: listBody(this.pages[index].map(entryOf), cursor) }
    }
    if (kind === 'page') return html(threadPage({ garc: garcOf(index) }))
    const thread = this.threads().find((each) => each.n === index)
    const blocks = thread === undefined ? 1 : blocksOf(thread)
    return { status: 200, contentType: 'application/json; charset=utf-8', body: threadStream(Array.from({ length: blocks }, () => ({}))) }
  }

  private async answer(route: Route): Promise<void> {
    const request = route.request()
    const url = request.url()
    const label = request.method() === 'GET' ? this.labelOf(url) : null
    if (label === null) {
      this.unexpected.push(`${request.method()} ${url}`)
      await route.abort()
      return
    }
    const cookies = ((await request.allHeaders()).cookie ?? '').split(/;\s*/)
    if (!cookies.includes(SESSION)) {
      this.unexpected.push(`${request.method()} ${url} without the session cookie`)
      await route.abort()
      return
    }
    this.requests.push(label)
    this.urls.push(url)
    if (label.startsWith('page ')) this.pageReads += 1
    const limited = label.startsWith('page ') && this.limitedFrom !== null && this.pageReads >= this.limitedFrom
    const gate = this.gates.get(label)
    if (gate !== undefined) {
      this.gates.delete(label)
      gate.reach()
      await gate.released
    }
    await route.fulfill(this.replies.get(label) ?? (limited ? html(limitedPage()) : this.ownReply(label)))
  }
}

// Google's unusual-traffic page, where it sends a session it takes for a bot,
// served from loopback. Playwright routes only the first request of a
// redirect chain, so a route cannot answer the request a redirect leads to;
// the fixtures' resolver rules let only loopback through, and the spider
// reads the page's path on any host. It answers 200, so only the URL the
// fetch ended on can make it a challenge.
export class SorryPage {
  // The path and query of each request it answered.
  readonly requests: string[] = []

  private readonly server: Server = createServer((request, response) => {
    this.requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><body>SITE-TEXT unusual traffic</body></html>')
  })

  static readonly PATH = '/sorry/index?continue=made-up&q=SITE-TEXT'

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${SorryPage.PATH}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
