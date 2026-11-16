// The allow patterns against the crawler's own URLs and the URLs Google's
// pages request. On an arm that blocks AI Mode, rex-page-manipulation turns
// each pattern into an allow rule that outranks the block, for script and
// xmlhttprequest requests from any page, so a pattern that matched one of
// Google's own requests would open AI Mode to the participant. Google's
// forms below are the ones the capture recorded (parameter names, order and
// value forms); every value is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALLOWED_URL_PATTERNS } from '../../src/allowed.mts';
import { HOME_URL } from '../../src/home.mts';
import { listUrl } from '../../src/list.mts';
import { folwrUrl, folwrValues, threadPageUrl } from '../../src/read.mts';
import { MSTK, MTID, listEntry } from './fixtures.mts';
import { FOLWR_VALUES, threadPage } from './thread-fixtures.mts';

const matches = (url: string): string[] => ALLOWED_URL_PATTERNS.filter((pattern) => new RegExp(pattern).test(url));

// Ids at the longest the list accepts: an mtid of 64, an mstk and a cursor of
// 1,024, in id form.
const LONG_MTID = `${'Ab_-'.repeat(15)}Zz09`;
const LONG_MSTK = 'Mk_-0189'.repeat(128);
const LONG_CURSOR = 'Cu-_7'.repeat(204) + 'Cu-_';
const idEntry = (mstk: string, mtid: string) => listEntry({ 0: [mstk, mtid], 22: [['mtid', mtid], ['csuir', '1'], ['mstk', mstk], ['udm', '50']] });

// Every character folwrValues takes from a page (anything but white space, a
// quote, <, > and &), non-ASCII included, as each of the five values.
const ODD = '!#$%()*+,-./09:;=?@AZ[\\]^_`az{|}~é\u{1F345}';

test('the spider asks for four forms of URL, one pattern each, and every URL it builds matches exactly one', () => {
  assert.equal(ALLOWED_URL_PATTERNS.length, 4);
  const built: [string, string][] = [
    ['home', HOME_URL],
    ['list, first page', listUrl(null)],
    ['list, after a cursor', listUrl('Cursor-AAAAAAAAAAAAAAAAAAAAAAAAA1')],
    ['list, the longest cursor', listUrl(LONG_CURSOR)],
    ['thread page', threadPageUrl(listEntry())],
    ['thread page, the longest ids', threadPageUrl(idEntry(LONG_MSTK, LONG_MTID))],
    ['folwr', folwrUrl(FOLWR_VALUES)],
    ['folwr, every value odd', folwrUrl({ garc: ODD, mlro: ODD, mlros: ODD, xsrf: ODD, ei: ODD })],
  ];
  const used = new Set<string>();
  for (const [name, url] of built) {
    const hit = matches(url);
    assert.equal(hit.length, 1, `${name} matches ${hit.length} patterns`);
    used.add(hit[0]);
  }
  assert.equal(used.size, ALLOWED_URL_PATTERNS.length, 'a pattern no request of the spider uses');
});

test('a folwr URL built from a page whose values hold every character the page reader takes still matches', () => {
  const values = folwrValues(threadPage({ garc: ODD, mlro: ODD, mlros: ODD, xsrf: ODD, ei: ODD }));
  assert.ok(values !== null, 'Test setup invalid: the page reader did not take the values');
  assert.equal(matches(folwrUrl(values)).length, 1);
});

test('no pattern holds .* or .+, every dot is escaped, and each is anchored to https://www.google.com/ at the start and $ at the end', () => {
  for (const pattern of ALLOWED_URL_PATTERNS) {
    assert.ok(pattern.startsWith('^https://www\\.google\\.com/'), pattern);
    assert.ok(pattern.endsWith('$'), pattern);
    assert.ok(!pattern.includes('.*') && !pattern.includes('.+'), pattern);
    // Outside character classes, every dot is a literal one.
    const outsideClasses = pattern.replace(/\[[^\]]*\]/g, '');
    assert.ok(!/(^|[^\\])\./.test(outsideClasses), `an unescaped dot in ${pattern}`);
    assert.doesNotThrow(() => new RegExp(pattern));
  }
});

// Made-up values in the captured forms.
const SRTST = 'MadeUpSrtst_0123456789abcdefGHIJKLmnopqrstUVWXYZ';
const VED = '2ahUKEwMadeUpVed0123456789abcdefGHIJKLmnopqrstUV';
const VET = '12ahUKEwMadeUpVet0123456789abcdefGHIJKLmnopqrstUVW..i';
const ELRC = 'MadeUpElrc0123456789abcdefGHIJKLmnopqrstUVWXYZ'.repeat(4);
const XSRF = encodeURIComponent(FOLWR_VALUES.xsrf);
// The crawler's own async value, so Google's forms below differ from the
// crawler's in their form alone.
const ASYNC = encodeURIComponent(`_fmt:prog,_xsrf:${FOLWR_VALUES.xsrf}`);
const Q = 'how+do+made+up+tomatoes+grow%3F';
const { garc: GARC, mlro: MLRO, mlros: MLROS, ei: EI } = FOLWR_VALUES;
const G = 'https://www.google.com';
const query = (pairs: [string, string][]) => pairs.map(([name, value]) => `${name}=${value}`).join('&');

// The requests Google's own pages made in the capture, by the phase they came
// in, and the documents a participant opens.
const GOOGLE_PAGE_URLS: [string, string][] = [
  ['folwr loading a thread (16 parameters)', `${G}/async/folwr?${query([['srtst', SRTST], ['garc', GARC], ['mlro', MLRO], ['mlros', MLROS], ['ei', EI], ['yv', '3'], ['vet', VET], ['ved', VED], ['hl', 'en'], ['udm', '50'], ['stkp', '1'], ['cs', '1'], ['mstk', MSTK], ['csuir', '1'], ['elrc', ELRC], ['async', ASYNC]])}`],
  ['folwr for an AI Mode question (14 parameters)', `${G}/async/folwr?${query([['srtst', SRTST], ['garc', GARC], ['mlro', MLRO], ['mlros', MLROS], ['ei', EI], ['q', Q], ['yv', '3'], ['vet', VET], ['ved', VED], ['hl', 'en'], ['udm', '50'], ['stkp', '1'], ['cs', '1'], ['async', ASYNC]])}`],
  ['folif opening a thread from the history list', `${G}/async/folif?${query([['srtst', SRTST], ['ei', EI], ['q', Q], ['yv', '3'], ['vet', VET], ['ved', VED], ['aep', '26'], ['hl', 'en'], ['udm', '50'], ['stkp', '1'], ['cs', '1'], ['mstk', MSTK], ['csuir', '1'], ['elrc', ELRC], ['async', ASYNC]])}`],
  ['folif for an AI Mode follow-up', `${G}/async/folif?${query([['srtst', SRTST], ['ei', EI], ['yv', '3'], ['hl', 'en'], ['udm', '50'], ['stkp', '1'], ['cs', '1'], ['csuir', '1'], ['elrc', ELRC], ['mstk', MSTK], ['q', Q], ['ved', VED], ['async', ASYNC]])}`],
  ['folif for an AI Overview follow-up', `${G}/async/folif?${query([['ei', EI], ['yv', '3'], ['aioh', '1'], ['hl', 'en'], ['udm', '50'], ['cs', '1'], ['csuir', '1'], ['elrc', ELRC], ['mstk', MSTK], ['q', Q], ['ved', VED], ['aep', '211'], ['async', ASYNC]])}`],
  ['the tab URL after opening a thread from the history list', `${G}/search?${query([['udm', '50'], ['hl', 'en'], ['atvm', '1'], ['sxsrf', XSRF], ['mstk', MSTK], ['mtid', MTID], ['csuir', '1'], ['aep', '26'], ['q', Q], ['ved', VED]])}`],
  ['an AI Overview search', `${G}/search?q=${Q}&hl=en`],
  ['an AI Mode question', `${G}/search?udm=50&hl=en&q=${Q}`],
  ['the AI Mode start page', `${G}/search?udm=50&hl=en`],
  ['the chrome:// form, new tab', 'chrome://new-tab-page/?udm=50'],
  ['the chrome:// form, with a query', `chrome://new-tab-page/search?q=${Q}&udm=50`],
  ['the page\'s own ListThreads', `${G}/httpservice/web/AimThreadsService/ListThreads?hl=en&udm=50&reqpld=%5Bnull%2Cnull%2C0%5D&msc=gwsclient&opi=89978449`],
  ['the page\'s own ListThreads, reqpld as written', `${G}/httpservice/web/AimThreadsService/ListThreads?hl=en&udm=50&reqpld=[null,null,0]&msc=gwsclient&opi=89978449`],
  ['ListJourneys', `${G}/httpservice/web/AimThreadsService/ListJourneys?hl=en&udm=50&reqpld=[]&msc=gwsclient&opi=89978449`],
  ['bgasy', `${G}/async/bgasy?opi=89978449&hl=en&udm=50&ei=${EI}&yv=3&cs=1&async=_fmt:prog`],
  ['hpba', `${G}/async/hpba?opi=89978449&hl=en&udm=50&sp_imghp=false&sp_hpte=0&ei=${EI}&sp_hpep=1&stick=&aep=1&q=&mstk=${MSTK}&aioh=1&ntc=1&vet=${VET}&yv=3&cs=1&async=${ASYNC}`],
  ['the search box\'s completions', `${G}/complete/s?q=&client=gws-wiz-serp&xssi=t&hl=en`],
  ['folsrch, which block arms redirect', `${G}/async/folsrch?ei=${EI}&q=${Q}&async=${ASYNC}`],
];

test('none of the URLs Google\'s own pages request, nor the AI Mode documents a participant opens, matches any pattern', () => {
  for (const [name, url] of GOOGLE_PAGE_URLS) {
    assert.deepEqual(matches(url), [], name);
  }
});

// Each is one of the crawler's own URLs with one thing changed, so the
// anchors, the parameter order and the host are each what keeps it out.
test('a URL one step away from the crawler\'s forms matches no pattern', () => {
  const page = threadPageUrl(listEntry());
  const folwr = folwrUrl(FOLWR_VALUES);
  const near: [string, string][] = [
    ['the thread page with a query appended', `${page}&q=${Q}`],
    ['the thread page in German', page.replace('hl=en', 'hl=de')],
    ['the thread page with mtid before mstk', `${G}/search?udm=50&mtid=${MTID}&mstk=${MSTK}&csuir=1&hl=en`],
    ['the thread page with hl moved up', `${G}/search?udm=50&hl=en&mstk=${MSTK}&mtid=${MTID}&csuir=1`],
    ['the thread page on google.de', page.replace('www.google.com', 'www.google.de')],
    ['the thread page without www', page.replace('www.google.com', 'google.com')],
    ['the thread page over http', page.replace('https:', 'http:')],
    ['the thread page with a fragment', `${page}#made-up`],
    ['folwr with srtst first', folwr.replace('folwr?', `folwr?srtst=${SRTST}&`)],
    ['folwr with a query appended', `${folwr}&q=${Q}`],
    ['folwr with mstk appended', `${folwr}&mstk=${MSTK}`],
    ['folif in the folwr form', folwr.replace('/folwr?', '/folif?')],
    ['the list with opi appended', `${listUrl(null)}&opi=89978449`],
    ['the list with udm', listUrl(null).replace('hl=en&', 'hl=en&udm=50&')],
    ['the list with no page size', `${G}/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=%5Bnull%2Cnull%2C0%5D&msc=gwsclient`],
    ['the home page without hl', `${G}/`],
    ['the home page with a query', `${G}/?hl=en&q=${Q}`],
  ];
  for (const [name, url] of near) {
    assert.deepEqual(matches(url), [], name);
  }
});
