// The parser against what real brokers answered (testing/fixtures/prometheus, M0-25): five RabbitMQ
// versions with statistics on and off, and LavinMQ. Nothing here is hand-written text.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { chunked, parseAll } from './test-support.ts';

const ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'prometheus',
);

interface Page {
  readonly key: string;
  readonly text: string;
  readonly prefix: 'rabbitmq' | 'lavinmq';
}

function pages(): Page[] {
  if (!existsSync(ROOT)) return [];
  const out: Page[] = [];
  for (const target of readdirSync(ROOT).sort()) {
    for (const mode of readdirSync(join(ROOT, target)).sort()) {
      for (const file of readdirSync(join(ROOT, target, mode)).sort()) {
        if (!file.endsWith('.prom')) continue;
        out.push({
          key: `${target}/${mode}/${file}`,
          text: readFileSync(join(ROOT, target, mode, file), 'utf8'),
          prefix: target.startsWith('lavinmq') ? 'lavinmq' : 'rabbitmq',
        });
      }
    }
  }
  return out;
}

const ALL = pages();

describe('golden Prometheus pages', () => {
  it('AC-5 the recordings are there: five RabbitMQ versions in two modes and LavinMQ', () => {
    const targets = new Set(ALL.map((page) => page.key.split('/')[0]));
    expect([...targets].sort()).toEqual([
      '3.13.7',
      '4.0.9',
      '4.1.8',
      '4.2.9',
      '4.3.6',
      'lavinmq-2.10.2',
    ]);
    // Aggregated page and detailed queue page, per version and mode: 10 x 2 + 1 x 2.
    expect(ALL).toHaveLength(22);
  });

  it('AC-5 every page parses to exactly its sample lines, with nothing malformed', async () => {
    for (const page of ALL) {
      // Independent of the parser: a sample line is a non-empty line that is not a comment.
      const expected = page.text
        .split('\n')
        .filter(
          (line) => line.trim() !== '' && !line.trimStart().startsWith('#'),
        ).length;
      const whole = await parseAll(chunked(page.text, [1 << 30]));
      expect(whole.summary, page.key).toMatchObject({
        samples: expected,
        malformed: 0,
        oversizedLines: 0,
      });
      expect(expected, page.key).toBeGreaterThan(5);
      // The same samples when the socket hands the body over in 1,000-byte pieces.
      const pieces = await parseAll(chunked(page.text, [1000]));
      expect(pieces.samples, page.key).toEqual(whole.samples);
    }
  });

  it('AC-5 the metrics the engine keeps are in the pages, under the product prefix', async () => {
    for (const page of ALL) {
      if (!page.key.endsWith('prometheus.metrics.prom')) continue;
      const { samples } = await parseAll(chunked(page.text, [4096]), {
        wanted: (name) => name.startsWith(`${page.prefix}_queue_messages`),
      });
      const names = new Set(samples.map((sample) => sample.name));
      for (const family of ['ready', 'unacked', '']) {
        const name = `${page.prefix}_queue_messages${family === '' ? '' : `_${family}`}`;
        expect(names.has(name), `${page.key}: ${name}`).toBe(true);
      }
    }
  });

  it('AC-5 the detailed queue pages carry vhost and queue labels, also with LavinMQ spacing', async () => {
    for (const page of ALL) {
      if (!page.key.endsWith('detailed-queues.prom')) continue;
      const { samples } = await parseAll(chunked(page.text, [333]), {
        wanted: (name) => name.endsWith('_detailed_queue_messages_ready'),
      });
      expect(samples.length, page.key).toBeGreaterThanOrEqual(4);
      for (const sample of samples) {
        expect(sample.labels.vhost, page.key).toBeTypeOf('string');
        expect(sample.labels.queue, page.key).toBeTypeOf('string');
      }
      expect(
        samples.some(
          (s) => s.labels.queue === 'golden.classic' && s.value === 3,
        ),
        page.key,
      ).toBe(true);
    }
  });
});
