// A secret that cannot be printed by accident (I-10). It is held in a private field, so it is not an
// enumerable property: `JSON.stringify`, `String`, a template literal, `util.inspect` and a log field
// all show the same fixed marker. The one way to the value is `reveal()`, which the code that puts
// the secret on the wire calls and nothing else.
const MARKER = '[secret]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The value. Call it only where the secret is sent to the broker. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MARKER;
  }

  toJSON(): string {
    return MARKER;
  }

  [Symbol.toPrimitive](): string {
    return MARKER;
  }

  [INSPECT](): string {
    return MARKER;
  }
}
