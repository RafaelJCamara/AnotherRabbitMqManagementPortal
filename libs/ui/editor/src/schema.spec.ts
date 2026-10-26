import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CodeEditor } from './code-editor.component';
import {
  fakeHost,
  pick,
  provideFakeLoader,
  settle,
} from './editor-spec-support';
import { SchemaRegistry } from './schema';

const SCHEMA_A = { type: 'object', title: 'A' };
const SCHEMA_B = { type: 'array', title: 'B' };

describe('JSON schema support', () => {
  it('M1-46 AC-18 a schema applies to one model and leaves with it', async () => {
    const host = fakeHost();
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const mount = async (inputs: Record<string, unknown>) => {
      const fixture = TestBed.createComponent(CodeEditor);
      fixture.componentRef.setInput('ariaLabel', 'Body');
      for (const [name, value] of Object.entries(inputs)) {
        fixture.componentRef.setInput(name, value);
      }
      await settle(fixture);
      return fixture;
    };
    const last = () => host.schemaCalls.at(-1)?.map((e) => e.fileMatch[0]);

    const first = await mount({ language: 'json', schema: SCHEMA_A });
    const second = await mount({ language: 'json', schema: SCHEMA_B });
    const [uriA, uriB] = [
      pick(host.editors, 0).modelUri,
      pick(host.editors, 1).modelUri,
    ];
    expect(last()).toEqual([uriA, uriB]);
    const uris = host.schemaCalls.at(-1)?.map((e) => e.uri) ?? [];
    expect(new Set(uris).size).toBe(2);
    expect(uris.every((uri) => uri.includes('model/'))).toBe(true);
    expect(host.schemaCalls.at(-1)?.map((e) => e.schema)).toEqual([
      SCHEMA_A,
      SCHEMA_B,
    ]);

    // An editor without a schema never touches the global option.
    const calls = host.schemaCalls.length;
    const plain = await mount({ language: 'json' });
    plain.destroy();
    expect(host.schemaCalls).toHaveLength(calls);

    first.componentRef.setInput('schema', undefined);
    await settle(first);
    expect(last()).toEqual([uriB]);

    first.componentRef.setInput('schema', SCHEMA_A);
    await settle(first);
    expect(last()).toEqual([uriB, uriA]);
    first.componentRef.setInput('language', 'yaml');
    await settle(first);
    expect(last()).toEqual([uriB]);

    second.destroy();
    expect(last()).toEqual([]);
  });

  it('M1-46 slice B removing a model that has no schema calls nothing', () => {
    const lists: unknown[] = [];
    const registry = new SchemaRegistry({
      setSchemas: (entries) => lists.push(entries),
    });
    registry.remove('inmemory://model/1');
    expect(lists).toEqual([]);
    registry.set('inmemory://model/1', SCHEMA_A);
    registry.remove('inmemory://model/1');
    registry.remove('inmemory://model/1');
    expect(lists).toHaveLength(2);
  });
});
