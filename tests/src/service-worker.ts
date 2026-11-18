import corePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'

import spiderPlugin from '@bric/rex-spider/service-worker'
import googleAISpider from '@bric/rex-spider-google-ai/service-worker'

import { redactGoogleAiMode } from '../../src/redact.mts'

// Keeps every event rex-core dispatches to its modules as JSON, as the
// data-upload module would get it, and for each rex-conversation point the
// AI Mode case's output, made from the point as dispatched, as the
// extension's content processor makes it: with the data format the spider
// was served, which in the extension is the processor's own.
class EventRecorder extends REXServiceWorkerModule {
  events: object[] = []
  redacted: object[] = []

  setup() {}

  moduleName() {
    return 'EventRecorder'
  }

  clear() {
    this.events = []
    this.redacted = []
  }

  logEvent(event: object) {
    this.events.push(JSON.parse(JSON.stringify(event)))
    if ((event as { name?: unknown }).name === 'rex-conversation') {
      this.redacted.push(JSON.parse(JSON.stringify(redactGoogleAiMode(event as Record<string, unknown>, googleAISpider.dataFormat()))))
    }
  }
}

const recorder = new EventRecorder()

registerREXModule(recorder)

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = spiderPlugin
self['rexGoogleAIPlugin'] = googleAISpider
self['eventRecorder'] = recorder

// The spider registers itself when its module loads, as in the extension,
// and nothing here registers it again, so a spec sees a registration that
// went missing.
corePlugin.setup()
