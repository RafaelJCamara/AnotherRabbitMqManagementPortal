import { describe, expect, it } from 'vitest';

import { leakedKeys, squash } from './spec-support';
import { field, mount, settle, typeInto } from './studio-bed';

describe('<app-publish-studio> words and first paint', () => {
  it('puts every word of the studio through a translation, and states each as it is', async () => {
    const bed = await mount('/c/c1/publish');
    expect(bed.el.querySelector('h1')?.textContent).toBe('Publish a message');
    const text = squash(bed.el.textContent);
    for (const sentence of [
      'Your draft stays in memory while this page is open.',
      'Where to publish',
      'Message properties',
      'Message body',
      'Body encoding',
      'Text (UTF-8)',
      'Binary (base64 text)',
      'Highlighting',
      'Plain text JSON XML YAML',
      'XML and YAML are coloured only; they are not checked.',
      '0 of 1048576 bytes.',
    ]) {
      expect(text, sentence).toContain(sentence);
    }
    expect(bed.el.querySelector('ul.facts')?.getAttribute('aria-label')).toBe(
      'Delivery settings that cannot be changed',
    );
    const labels = [...bed.el.querySelectorAll('.field label, legend')].map(
      (el) => squash(el.textContent),
    );
    for (const label of [
      'Virtual host',
      'Exchange',
      'Routing key',
      'Copies',
      'Wait for each confirm (milliseconds)',
      'Body encoding',
      'Highlighting',
    ]) {
      expect(labels, label).toContain(label);
    }
    // Only the exchange carries the hint about the default exchange.
    expect(field(bed, 'f-exchange').getAttribute('aria-describedby')).toBe(
      'f-exchange-hint',
    );
    expect(field(bed, 'f-exchange').getAttribute('spellcheck')).toBe('false');
    expect(bed.el.querySelector('#f-exchange-hint')?.textContent).toContain(
      'Leave empty for the default exchange',
    );
    expect(bed.el.querySelectorAll('.hint').length).toBeGreaterThan(0);
    expect(
      bed.el.querySelector('#f-vhost-hint, #f-routingKey-hint, #f-copies-hint'),
    ).toBeNull();
    // The editor is named and has its way out in words.
    expect(bed.host.editors[0]?.options.ariaLabel).toBe('Message body');
    expect(text).toContain('Press Ctrl+M to let the Tab key leave the editor.');
    expect(leakedKeys(bed.el)).toEqual([]);

    // Every word of every kind of problem is a real one, and a single problem is counted.
    typeInto(field(bed, 'f-vhost'), '');
    await settle(bed.harness);
    expect(bed.el.querySelector('#f-vhost-error')?.textContent).toContain(
      'This is required.',
    );
    expect(bed.el.querySelector('[role="status"]')?.textContent).toContain(
      '1 to fix before this can be sent.',
    );
    typeInto(field(bed, 'f-vhost'), '/');
    const encoding = bed.el.querySelector<HTMLSelectElement>('#f-encoding');
    if (encoding === null) throw new Error('no encoding');
    encoding.value = 'base64';
    encoding.dispatchEvent(new Event('change', { bubbles: true }));
    bed.host.editors[0]?.type('not base64!');
    await settle(bed.harness);
    expect(squash(bed.el.textContent)).toContain(
      'This is not valid base64 text.',
    );
    expect(squash(bed.el.textContent)).toContain('0 of 1048576 bytes.');
    bed.host.editors[0]?.type('x'.repeat(1_398_104));
    await settle(bed.harness);
    expect(squash(bed.el.textContent)).toContain(
      'The body is over the limit of 1048576 bytes.',
    );
    expect(leakedKeys(bed.el)).toEqual([]);
    expect(bed.el.querySelector<HTMLSelectElement>('#f-encoding')?.value).toBe(
      'base64',
    );

    // A table-level header problem is shown under the table; the selects keep what the draft says after a visit.
    bed.el.querySelector<HTMLButtonElement>('button.mode-json')?.click();
    await settle(bed.harness);
    bed.host.editors[1]?.type('{"a"');
    await settle(bed.harness);
    expect(squash(bed.el.textContent)).toContain(
      'The headers JSON is not valid or is not a table of typed headers.',
    );
    const language = bed.el.querySelector<HTMLSelectElement>('#f-language');
    if (language === null) throw new Error('no language');
    language.value = 'yaml';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(bed.harness);
    expect(leakedKeys(bed.el)).toEqual([]);
    const before = bed.store.draft('c1')();
    await bed.harness.navigateByUrl('/c/c1/publish?other=1');
    await settle(bed.harness);
    // No address parameter of the studio's: the draft is not rewritten, and what it holds is still shown.
    expect(bed.store.draft('c1')()).toBe(before);
    expect(bed.el.querySelector<HTMLSelectElement>('#f-encoding')?.value).toBe(
      'base64',
    );
    expect(bed.el.querySelector<HTMLSelectElement>('#f-language')?.value).toBe(
      'yaml',
    );
  });

  it('opens on what the draft holds: the properties, the choices and the body', async () => {
    const bed = await mount('/c/c1/publish', {
      seed: (store) => {
        store.draft('c1').update((draft) => ({
          ...draft,
          props: {
            deliveryMode: 2,
            priority: 7,
            timestamp: 1_700_000_000,
            contentType: 'text/plain',
          },
          body: { encoding: 'base64', data: 'aGk=', language: 'yaml' },
          copies: 3,
          timeoutMs: 1_234,
        }));
      },
    });
    expect(
      bed.el.querySelector<HTMLSelectElement>('#prop-deliveryMode')?.value,
    ).toBe('2');
    expect(field(bed, 'prop-priority').value).toBe('7');
    expect(field(bed, 'prop-timestamp').value).toBe('1700000000');
    expect(field(bed, 'prop-contentType').value).toBe('text/plain');
    expect(field(bed, 'prop-appId').value).toBe('');
    expect(field(bed, 'f-copies').value).toBe('3');
    expect(field(bed, 'f-timeoutMs').value).toBe('1234');
    expect(bed.el.querySelector<HTMLSelectElement>('#f-encoding')?.value).toBe(
      'base64',
    );
    expect(bed.el.querySelector<HTMLSelectElement>('#f-language')?.value).toBe(
      'yaml',
    );
    expect(bed.host.editors[0]?.value).toBe('aGk=');
    expect(bed.host.editors[0]?.language).toBe('yaml');
    expect(bed.el.textContent).toContain('2 of 1048576 bytes');
    const one = await mount('/c/c1/publish', {
      seed: (store) => {
        store
          .draft('c1')
          .update((draft) => ({ ...draft, props: { deliveryMode: 1 } }));
      },
    });
    expect(
      one.el.querySelector<HTMLSelectElement>('#prop-deliveryMode')?.value,
    ).toBe('1');
  });
});
