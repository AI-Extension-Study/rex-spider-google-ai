// The entry point the extension imports: one Google AI Mode spider,
// registered with rex-spider when this module loads.
import rexSpiderPlugin from '@bric/rex-spider/service-worker';

import { GoogleAISpider } from './spider.mts';

const googleAISpider = new GoogleAISpider();

rexSpiderPlugin.registerSpider(googleAISpider);

export { GoogleAISpider };

export default googleAISpider;
