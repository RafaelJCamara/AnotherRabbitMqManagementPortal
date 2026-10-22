// A scrape read to samples. The composition root builds it over the BrokerScheduler's scrape wrapper
// (`schedulePromScrape`), so the slot the scheduler holds ends when the parser has read the body to
// its end, or stopped early and cancelled it. A service gets this port and never sees a chunk or the
// adapter (blueprint 2.2).
import type { PromReadPort, PromScrapePort } from '@app/ports';

import { parseExposition } from './parser.ts';

export function createPromReader(scrape: PromScrapePort): PromReadPort {
  return {
    async read(request, sink, options, signal) {
      const body = await scrape.scrape(request, signal);
      const summary = await parseExposition(body, sink, {
        signal,
        ...(options.wanted === undefined ? {} : { wanted: options.wanted }),
        ...(options.maxSamples === undefined
          ? {}
          : { maxSamples: options.maxSamples }),
        ...(options.maxBodyBytes === undefined
          ? {}
          : { maxBodyBytes: options.maxBodyBytes }),
      });
      return {
        bytes: summary.bytes,
        samples: summary.samples,
        skipped: summary.skipped,
        malformed: summary.malformed,
        oversizedLines: summary.oversizedLines,
        ...(summary.truncated === undefined
          ? {}
          : { truncated: summary.truncated }),
      };
    },
  };
}
