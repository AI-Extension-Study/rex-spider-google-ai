// @ts-nocheck

import { test as base, chromium, type BrowserContext } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url';

export const test = base.extend<{
  context: BrowserContext
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
        // No host name resolves but loopback's, so a request no route
        // answers fails in the browser instead of reaching a real site.
        // Playwright does not route the request a redirect leads to.
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    });

    // Closed once the test and every fixture built on it are done.
    await use(context)
    await context.close()
  },
  extensionId: async ({ context }, use) => {
    // for manifest v3:
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker');

    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
  serviceWorker: async ({ context }, use) => {
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
