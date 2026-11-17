// @ts-nocheck

import { test as base, chromium, type BrowserContext } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url';

export const test = base.extend<{
  context: BrowserContext
  unexpected: string[],
  extensionId: string,
  serviceWorker:ServiceWorker,
}>({
  context: async ({ }, use) => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const pathToExtension = path.join(__dirname, '../extension')

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        `--enable-features=DeclarativeNetRequestFeedback`,
        // No host name resolves but 127.0.0.1, and no proxy is used (a
        // proxy from the OS settings would resolve the host itself), so a
        // request no route answers fails in the browser instead of reaching
        // a real site. Playwright does not route the request a redirect
        // leads to, nor any request made before the first route is in.
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--no-proxy-server',
      ],
    });

    // Closed once the test and every fixture built on it are done.
    await use(context)
    await context.close()
  },
  // The method and URL of every http(s) request no later route answers,
  // aborted; the spec fails on any. The route goes in just after launch,
  // before the worker is awaited. In every run seen it was in a few ms
  // before the worker's script ran, so a request made at load was kept here
  // too; that is an observed margin, not a guarantee. A startup request that
  // comes before the route is blocked by the resolver rule instead, so
  // nothing leaks, but it is not kept.
  unexpected: async ({ context }, use) => {
    const unexpected: string[] = []
    await context.route(/^https?:\/\//, async (route) => {
      unexpected.push(`${route.request().method()} ${route.request().url()}`)
      await route.abort()
    })
    await use(unexpected)
    base.expect(unexpected).toEqual([])
  },
  extensionId: async ({ context }, use) => {
    // for manifest v3:
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker');

    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
  // Takes unexpected so its route is in before the worker is awaited.
  serviceWorker: async ({ context, unexpected }, use) => {
    context.on('console', msg => {
      console.log(msg);
    })

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    await use(serviceWorker)
  },
});

export const expect = test.expect;
