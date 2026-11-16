// The requests the spider makes, one pattern per URL form, for rex-spider's
// allowedUrls. rex-page-manipulation turns each into a priority-1000 allow
// rule for script and xmlhttprequest requests from any page (a
// declarativeNetRequest regexFilter, so RE2: no look-around, and a small
// compiled size, so no long counted repeats). On an arm that redirects
// google.<tld>/search...udm=50 to its block page, the thread page request
// gets through only by its pattern, and a pattern that matched a request
// Google's own pages make would open AI Mode to the participant. So each is
// anchored at both ends and pinned to the crawler's form: its host, its
// path, its parameters in the crawler's order, and each value in the
// characters its encoding can produce, never .*. Google's own requests use
// other forms (tests/unit/allowed.test.mts lists them).
import { PAGE_SIZE } from './list.mts';

const ORIGIN = '^https://www\\.google\\.com/';

// A value in id form: the list reads mstk, mtid and the cursor so
// (list.mts), and encodeURIComponent leaves those characters as they are.
const ID = '[A-Za-z0-9_-]+';

// A value URLSearchParams wrote: letters, digits and *-._ as they are, any
// other character as %XX, so one class of those characters and %. The folwr
// values are taken from the page as any run without white space, a quote, <,
// > or & (read.mts), so the + that URLSearchParams writes for a space never
// occurs. Not (?:[...]|%[0-9A-F]{2})+: Chrome refuses the folwr pattern
// written so, as over its 2 KB compiled limit, and a refused rule fails
// rex-page-manipulation's whole rule update, the block rules with it.
const ENCODED = '[A-Za-z0-9*._%-]+';

export const ALLOWED_URL_PATTERNS: readonly string[] = Object.freeze([
  // The home page (home.mts, HOME_URL).
  `${ORIGIN}\\?hl=en$`,
  // A list page (list.mts, listUrl): reqpld is [null,<page size>,0,null,<cursor>]
  // as encodeURIComponent writes it, the cursor null or a quoted id.
  `${ORIGIN}httpservice/web/AimThreadsService/ListThreads\\?hl=en&reqpld=%5Bnull%2C${PAGE_SIZE}%2C0%2Cnull%2C(?:null|%22${ID}%22)%5D&msc=gwsclient$`,
  // A thread page (read.mts, threadPageUrl).
  `${ORIGIN}search\\?udm=50&mstk=${ID}&mtid=${ID}&csuir=1&hl=en$`,
  // A thread's folwr (read.mts, folwrUrl): the five parameters, async first.
  `${ORIGIN}async/folwr\\?async=_fmt%3Aprog%2C_xsrf%3A${ENCODED}&garc=${ENCODED}&mlro=${ENCODED}&mlros=${ENCODED}&ei=${ENCODED}$`,
]);
