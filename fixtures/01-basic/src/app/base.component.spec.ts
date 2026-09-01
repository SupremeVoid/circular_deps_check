import { BaseComponent } from './base.component';

describe('BaseComponent', () => {
  it('creates', () => {
    expect(new BaseComponent().title).toBe('base');
  });
});

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (v: unknown) => { toBe(v: unknown): void };
