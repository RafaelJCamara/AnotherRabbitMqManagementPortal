import { hello } from './hello';

describe('hello', () => {
  it('greets by name', () => {
    expect(hello('engine')).toBe('Hello from engine');
  });
});
