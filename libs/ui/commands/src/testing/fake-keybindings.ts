// The engine's keybinding document as a fake engine handler: `keybindings.get` and `keybindings.put` over a map
// the spec can read and make fail with a Problem. Never part of the library build.
import type { Problem } from '@app/contracts';
import {
  jsonResponse,
  problemResponse,
  type FakeHandler,
} from '@app/ui-platform/testing';

const KEYBINDINGS_URL = /^\/api\/v1\/keybindings$/;

const problem = (
  status: number,
  code: Problem['code'],
  title: string,
): Problem => ({
  type: 'about:blank',
  title,
  status,
  code,
  correlationId: 'fake-engine',
  retryable: false,
});

export class FakeKeybindings {
  /** The document the engine keeps. */
  document: Record<string, string | null> = {};
  /** Every body of a `keybindings.put` it received, in order. */
  readonly puts: Record<string, string | null>[] = [];
  gets = 0;
  failGet: Problem | null = null;
  failPut: Problem | null = null;
  /** While set, a keybindings.put waits for it (a save that is in flight). */
  hold: Promise<void> | null = null;

  constructor(initial: Record<string, string | null> = {}) {
    this.document = { ...initial };
  }

  /** Makes the next reads fail (a 503 Problem). */
  failReads(title = 'The engine could not read your keybindings'): void {
    this.failGet = problem(503, 'INTERNAL', title);
  }

  failWrites(title = 'The engine could not save your keybindings'): void {
    this.failPut = problem(503, 'INTERNAL', title);
  }

  readonly handler: FakeHandler = async (request) => {
    const url = new URL(request.url, 'http://engine.test');
    if (!KEYBINDINGS_URL.test(url.pathname)) {
      return problemResponse(problem(404, 'NOT_FOUND', 'Not found'));
    }
    if (request.method === 'GET') {
      this.gets += 1;
      if (this.failGet !== null) return problemResponse(this.failGet);
      return jsonResponse(200, { bindings: this.document });
    }
    if (request.method === 'PUT') {
      if (this.hold !== null) await this.hold;
      if (this.failPut !== null) return problemResponse(this.failPut);
      const body = JSON.parse(
        typeof request.body === 'string' ? request.body : '{}',
      ) as {
        bindings: Record<string, string | null>;
      };
      this.puts.push(body.bindings);
      this.document = { ...body.bindings };
      return jsonResponse(200, {});
    }
    return problemResponse(
      problem(405, 'VALIDATION_FAILED', 'Method not allowed'),
    );
  };
}
