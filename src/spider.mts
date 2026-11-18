// The spider rex-spider runs for Google AI Mode: its name, the URLs the
// extension lets it reach, the served mode, halt_on_error and data format,
// and a crawl that is one pass (src/pass.mts). src/service-worker.mts makes the instance
// and registers it.
import { sha256 } from '@bric/rex-core/common';
import rexCorePlugin, { dispatchEvent } from '@bric/rex-core/service-worker';
import { REXSpider, type REXSpiderCrawlResult } from '@bric/rex-spider/service-worker';

import { ALLOWED_URL_PATTERNS } from './allowed.mts';
import { createClient } from './client.mts';
import { dataFormatOf } from './format.mts';
import { HOME_URL, isSignedIn } from './home.mts';
import { KEY_PREFIX } from './keys.mts';
import { sleep } from './pacing.mts';
import { runPass } from './pass.mts';
import { createStore } from './store.mts';

// A key nothing stores. Reading it is the cheap extension call that keeps the
// worker awake through a wait or a slow call (src/pacing.mts).
const KEEP_ALIVE_KEY = `${KEY_PREFIX}keep-alive`;

const keepAlive = () => chrome.storage.local.get(KEEP_ALIVE_KEY);

export class GoogleAISpider extends REXSpider {
  // summarize as served on the last refresh: true is summary mode, absent or
  // false is detail. rex-spider keeps a flag of its own that only ever turns
  // on, so a config that turned summary off again would not take.
  summarizes = false;

  // halt_on_error as served on the last refresh: true, rex-spider's default,
  // ends a pass's thread reads at the first that fails. rex-spider's own flag
  // only ever turns off.
  haltsOnError = true;

  // data_format as served on the last refresh (format.mts): the extension
  // serves its own. Absent or out of form is format 1, as before.
  dataFormatServed = 1;

  // Whether a pass is running, set the moment a crawl starts. rex-spider's
  // own flag is set only once rex-core has stored the crawl's start, so a
  // second round could start a second pass before it, and two passes would
  // read threads at once.
  passRunning = false;

  // rex-spider calls this on each refresh whose config has a block for this
  // spider or a default one, with the blocks merged. With neither, what was
  // last served stays until the worker restarts, as enabled does.
  updateConfiguration(configuration: Parameters<REXSpider['updateConfiguration']>[0]): void {
    super.updateConfiguration(configuration);
    this.summarizes = configuration.summarize === true;
    this.haltsOnError = configuration.halt_on_error !== false;
    // rex-spider's config type has no data_format, so it is read as unknown,
    // as a property like the keys above: rex-spider hands on a served block
    // that is not an object as it is, and the in operator would throw on it.
    this.dataFormatServed = dataFormatOf((configuration as { data_format?: unknown }).data_format);
  }

  justSummarize(): boolean {
    return this.summarizes;
  }

  dataFormat(): number {
    return this.dataFormatServed;
  }

  continueAfterError(): boolean {
    return !this.haltsOnError;
  }

  // rex-spider skips a spider that says it is crawling, and records that.
  isCrawling(): boolean {
    return this.passRunning || super.isCrawling();
  }

  // As before. Nothing in rex-spider calls these two.
  fetchUrls(): string[] {
    return [];
  }

  fetchInitialUrls(): string[] {
    return [];
  }

  name(): string {
    return 'Google AI Mode';
  }

  // rex-spider names this spider's keys after it (rex-spider-google-ai-...),
  // and src/keys.mts writes under the same prefix.
  identifier(): string {
    return 'google-ai';
  }

  loginUrl(): string {
    return 'https://www.google.com/';
  }

  // The four request forms of a pass (src/allowed.mts).
  allowedUrls(): string[] {
    return [...ALLOWED_URL_PATTERNS];
  }

  // Whether the home page holds SignOutOptions. Nothing in rex-spider calls
  // it; it resolves false on any failure.
  async checkLogin(): Promise<boolean> {
    try {
      const home = await createClient({ keepAlive }).get(HOME_URL);
      return home.status >= 200 && home.status <= 299 && isSignedIn(home.text);
    } catch {
      return false;
    }
  }

  // The base stamps the crawl's start and sets its crawling flag. The pass
  // never throws, and its outcome is the crawl's one completion event, which
  // clears the flag again. A crawl started while a pass runs starts none and
  // sends no event, so the running pass's flag stays as it is.
  async doBackgroundCrawl(): Promise<REXSpiderCrawlResult> {
    if (this.passRunning) {
      return { sitesCrawled: [this.identifier()], issues: [{ url: this.loginUrl(), message: 'a pass is already running' }] };
    }
    this.passRunning = true;
    try {
      return await this.crawlOnce();
    } finally {
      this.passRunning = false;
    }
  }

  private async crawlOnce(): Promise<REXSpiderCrawlResult> {
    const result = await super.doBackgroundCrawl();
    const outcome = await runPass({
      client: createClient({ keepAlive }),
      framework: this,
      store: createStore(rexCorePlugin.handleMessage),
      // A shallow copy: rex-core's EventPayload has an index signature.
      dispatch: (record) => dispatchEvent({ ...record }),
      sleep: (ms) => sleep(ms, { keepAlive }),
      keepAlive,
      hash: sha256,
    }, Date.now);
    if (outcome.count === -1) {
      result.issues.push({ url: this.loginUrl(), message: outcome.reason });
    }
    this.signalCrawlComplete(outcome.count, outcome.ids, outcome.reason);
    return result;
  }
}
