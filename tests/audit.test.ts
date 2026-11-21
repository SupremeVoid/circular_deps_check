/**
 * Cases found by differential testing against real ES-module execution (a fuzzer and hand-written
 * projects, each load order executed for real). Every project here states what the runtime did.
 */
import { describe, expect, it } from 'bun:test';
import { analyzeProject } from './tmp-project.js';

type Result = Awaited<ReturnType<typeof analyzeProject>>;
const name = (p: string): string => p.split('/').pop()!;
/** `file:line binding` of every read failing under a real entry, with the severity of its finding. */
const real = (r: Result): string[] =>
  r.findings
    .filter((f) => f.kind === 'runtime-break' || f.kind === 'test-break' || f.kind === 'possible-break')
    .flatMap((f) => f.failures.map((fp) => `${f.severity} ${name(fp.from)}:${fp.usage.line} ${fp.binding}`));

/** Two files: a.ts reads nothing of b at load, b.ts runs `extra` while a.ts is still loading (main imports a first). */
const pair = (extra: string): Record<string, string> => ({
  'src/main.ts': `import { A } from './a';\nexport const m = A;\n`,
  'src/a.ts': `import { B } from './b';\nexport const A = 1;\nexport const later = () => B;\n`,
  'src/b.ts': `import { A } from './a';\nexport const B = 2;\n${extra}\n`,
});

describe('missed crashes (runtime throws)', () => {
  it('a declaration is not initialised before its end: a call inside a multi-line class body reads the class', async () => {
    // Runtime: ReferenceError: Cannot access 'A' before initialization.
    const r = await analyzeProject({
      'src/main.ts': `import { A } from './a';\nexport const m = A;\n`,
      'src/a.ts': `import { f } from './b';\nexport class A {\n  static v = f();\n}\n`,
      'src/b.ts': `import { A } from './a';\nexport function f() { return A.name; }\n`,
    });
    expect(real(r)).toEqual(['critical a.ts:3 A']);
    // … same for a multi-line `const` initialiser
    const c = await analyzeProject({
      'src/main.ts': `import { CFG } from './a';\nexport const m = CFG;\n`,
      'src/a.ts': `import { f } from './b';\nexport const CFG = {\n  v: f(),\n};\n`,
      'src/b.ts': `import { CFG } from './a';\nexport function f() { return CFG; }\n`,
    });
    expect(real(c)).toEqual(['critical a.ts:3 CFG']);
  });

  it('still accepts a read of an earlier declaration on the same line', async () => {
    // Runtime: loads fine.
    const r = await analyzeProject({
      'src/main.ts': `import './m';\n`,
      'src/index.ts': `export * from './m';\n`,
      'src/m.ts': `import { early } from './index';\nexport const early = 1; export const x = early;\n`,
    });
    expect(real(r)).toEqual([]);
  });

  it('reads a member through `export * as ns` while the namespace target is still loading', async () => {
    // Runtime: ReferenceError: Cannot access 'B' before initialization.
    const r = await analyzeProject({
      'src/main.ts': `import { B } from './b';\nexport const m = B;\n`,
      'src/a.ts': `import { ns } from './idx';\nexport const A = 1;\nexport const viaNs = ns.B;\n`,
      'src/idx.ts': `export * as ns from './b';\n`,
      'src/b.ts': `import { A } from './a';\nexport const B = 2;\nexport const later = () => A;\n`,
    });
    expect(real(r)).toEqual(['critical a.ts:3 B']);
    expect(r.findings[0]!.title).toContain('`ns.B` read before initialisation');
  });

  it('follows `ns.Class.staticMethod()` on a namespace import', async () => {
    // Runtime (Node): ReferenceError: Cannot access 'A' before initialization.
    const r = await analyzeProject({
      'src/main.ts': `import { x } from './a';\nexport const m = x;\n`,
      'src/a.ts': `import * as b from './b';\nexport const x = b.K.make();\nexport const A = 1;\n`,
      'src/b.ts': `import { A } from './a';\nexport class K { static make() { return A; } }\n`,
    });
    expect(real(r)).toEqual(['critical a.ts:2 A']);
    expect(r.findings[0]!.title).toContain('`b.K.make()` reads `A`');
  });

  it('runs the inherited constructor and fields of a class instantiated at load', async () => {
    // Runtime: ReferenceError (B) – `new Derived()` runs the field initialiser of Base.
    const local = await analyzeProject({
      'src/main.ts': `import { B } from './b';\nexport const m = B;\n`,
      'src/b.ts': `import { d } from './a';\nexport class B {}\nexport const later = () => d;\n`,
      'src/a.ts': `import { B } from './b';\nclass Base { x = B.name; }\nclass Derived extends Base {}\nexport const d = new Derived();\n`,
    });
    expect(real(local)).toEqual(['critical a.ts:2 B']);
    // … and across files: a.ts does `new K()`, K extends a base whose constructor reads B.
    const imported = await analyzeProject({
      'src/main.ts': `import { B } from './b';\nexport const m = B;\n`,
      'src/b.ts': `import { k } from './a';\nexport const B = 1;\nexport const later = () => k;\n`,
      'src/a.ts': `import { K } from './k';\nexport const k = new K();\n`,
      'src/k.ts': `import { B } from './b';\nclass Base { v: number; constructor() { this.v = B; } }\nexport class K extends Base {}\n`,
    });
    expect(real(imported)).toEqual(['critical a.ts:2 B']);
    expect(imported.findings[0]!.failures[0]!.via!.map((v) => v.fn)).toEqual(['K', 'Base']);
  });

  it('does not invent a read of the base class binding when a derived class is instantiated', async () => {
    // Runtime: main loads fine. b.ts instantiates Derived (a.ts, finished) whose base is b's own Base, declared above.
    const r = await analyzeProject({
      'src/main.ts': `import { made } from './b';\nexport const m = made;\n`,
      'src/a.ts': `import { Base } from './base';\nimport { made } from './b';\nexport class Derived extends Base {}\nexport const later = () => made;\n`,
      'src/base.ts': `export class Base { tag = 'base'; }\n`,
      'src/b.ts': `import { Derived } from './a';\nexport const made = (() => 1)();\nexport const lazy = () => new Derived();\n`,
    });
    expect(real(r)).toEqual([]);
  });

  it('follows methods of a singleton object and static getters into other files', async () => {
    // Runtime: both throw "Cannot access 'A' before initialization".
    const method = await analyzeProject({
      'src/main.ts': `import { A } from './a';\nexport const m = A;\n`,
      'src/a.ts': `import { x } from './c';\nexport const A = 1;\nexport const later = () => x;\n`,
      'src/c.ts': `import { Utils } from './utils';\nexport const x = Utils.make();\n`,
      'src/utils.ts': `import { A } from './a';\nexport const Utils = { make() { return A; } };\n`,
    });
    expect(real(method)).toEqual(['critical c.ts:2 A']);
    expect(method.findings[0]!.title).toContain('`Utils.make()` reads `A`');
    const getter = await analyzeProject({
      'src/main.ts': `import { A } from './a';\nexport const m = A;\n`,
      'src/a.ts': `import { x } from './c';\nexport const A = 1;\nexport const later = () => x;\n`,
      'src/c.ts': `import { Cfg } from './cfg';\nexport const x = Cfg.value;\n`,
      'src/cfg.ts': `import { A } from './a';\nexport class Cfg { static get value() { return A; } }\n`,
    });
    expect(real(getter)).toEqual(['critical c.ts:2 A']);
    expect(getter.findings[0]!.summary).toContain('reads the getter `Cfg.value` at load time');
  });
});

describe('lazy chunks below a shared chunk', () => {
  /** A cycle that is safe when entered through g2 and crashes when entered through g1. */
  const CYCLE = {
    'src/g1.ts': `import { B } from './g2';\nexport class A { static make() { return new B(); } }\n`,
    'src/g2.ts': `import { A } from './g1';\nexport class B extends A {}\n`,
  };

  it('replays a nested chunk for every parent path that leaves different modules loaded', async () => {
    // Runtime: main > p1 > x > c loads; main > p2 > x > c throws "Cannot access 'A' before initialization".
    const r = await analyzeProject({
      'src/main.ts': `export const r = [() => import('./p1'), () => import('./p2')];\n`,
      'src/p1.ts': `import { B } from './g2';\nexport const P1 = B;\nexport const l = () => import('./x');\n`,
      'src/p2.ts': `export const P2 = 2;\nexport const l = () => import('./x');\n`,
      'src/x.ts': `export const X = 1;\nexport const l = () => import('./c');\n`,
      'src/c.ts': `import { A } from './g1';\nexport const C = A;\n`,
      ...CYCLE,
    });
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f).toBeDefined();
    expect(f.failures[0]!.entries.map((e) => `${e.kind}:${name(e.entry)}`)).toEqual(['lazy:c.ts']);
    expect(r.entries.filter((e) => e.kind === 'lazy').map((e) => name(e.entry)).sort()).toEqual(['c.ts', 'p1.ts', 'p2.ts', 'x.ts']);
  });

  it('follows lazy chunks to any depth and terminates on chunks that import each other lazily', async () => {
    // Runtime: main > c1 > … > c8 throws at c8.
    const chain: Record<string, string> = { 'src/main.ts': `export const l = () => import('./c1');\n` };
    for (let i = 1; i < 8; i++) chain[`src/c${i}.ts`] = `export const n${i} = ${i};\nexport const l = () => import('./c${i + 1}');\nexport const back = () => import('./c1');\n`;
    chain['src/c8.ts'] = `import { A } from './g1';\nexport const C = A;\n`;
    const r = await analyzeProject({ ...chain, ...CYCLE });
    expect(real(r)).toEqual(['critical g2.ts:2 A']);
    expect(r.entries.filter((e) => e.kind === 'lazy')).toHaveLength(8);
  });
});

describe('false alarms (runtime loads fine): possible, never certain', () => {
  it('a read in a branch at module level is a possible crash', async () => {
    for (const extra of [
      `export const x = typeof window !== 'undefined' ? A : null;`,
      `export let x: unknown;\nif (typeof document !== 'undefined') { x = A; }`,
      `export const x = (globalThis as { flag?: number }).flag ?? A;`,
      `function init(browser: boolean) { if (!browser) return 0; return A; }\nexport const x = init(false);`,
    ]) {
      const r = await analyzeProject(pair(extra));
      expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')).toEqual([]);
      const f = r.findings.find((x) => x.kind === 'possible-break')!;
      expect(f.severity).toBe('medium');
      expect(f.failures[0]!.uncertain).toContain('branch');
    }
  });

  it('code after a conditional return of a called function is a possible crash', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import { A } from './a';\nexport const m = A;\n`,
      'src/a.ts': `import { x } from './c';\nexport const A = 1;\nexport const later = () => x;\n`,
      'src/c.ts': `import { get } from './u';\nexport const x = get(true);\n`,
      'src/u.ts': `import { A } from './a';\nexport function get(cached: boolean) { if (cached) return 0; return A; }\n`,
    });
    expect(real(r)).toEqual(['medium c.ts:2 A']);
  });

  it('a callback only certainly runs for an array that certainly has elements', async () => {
    for (const extra of [
      `const registry: Record<string, number> = {};\nexport const xs = Object.keys(registry).map((k) => A + k);`,
      `export const xs = [B].sort(() => A);`,
      `export const xs = Array.from(new Set<number>(), () => A);`,
    ]) {
      const r = await analyzeProject(pair(extra));
      expect(real(r).map((x) => x.split(' ')[0])).toEqual(['medium']);
    }
    // … while these do run
    for (const extra of [`export const xs = [1].map(() => A);`, `export const xs = [1, 2].sort(() => A);`, `export const xs = Array.from({ length: 2 }, () => A);`]) {
      const r = await analyzeProject(pair(extra));
      expect(real(r).map((x) => x.split(' ')[0])).toEqual(['critical']);
    }
  });
});

describe('fix preview bookkeeping', () => {
  const GROUPS = {
    'src/a.ts': `import { helper } from './a2';\nexport const A = 1;\nexport const later = () => helper;\n`,
    'src/a2.ts': `import { A } from './a';\nimport './b2';\nexport const helper = 1;\nexport const copy = [A];\n`,
    'src/b1.ts': `import { B2 } from './b2';\nexport const B1 = 1;\nexport const l = () => B2;\n`,
    'src/b2.ts': `import { B1 } from './b1';\nexport const B2 = [B1];\n`,
  };
  const SPECS = { noTestEntries: false, testEntries: ['src/**/*.spec.ts'] };

  it('lists a crash that only specs hit today as the next crash when the fix moves it to app load', async () => {
    // Runtime after moving `helper` to a leaf file: main throws "Cannot access 'B1' before initialization".
    const r = await analyzeProject({ ...GROUPS, 'src/main.ts': `import './a';\nimport './b1';\n`, 'src/x.spec.ts': `import './b1';\nimport './a';\n` }, SPECS);
    const testOnly = r.findings.find((f) => f.kind === 'test-break')!;
    expect(testOnly.failures.map((fp) => `${name(fp.from)}:${fp.usage.line} ${fp.binding}`)).toEqual(['b2.ts:2 B1']);
    const plan = r.fixPlans.find((p) => p.cuts.some((c) => name(c.from) === 'a.ts'))!;
    expect(plan.preview!.steps[0]!.exposed.map((x) => `${name(x.from)}:${x.line} ${x.binding} ${x.entryKind} ${x.knownKind}`)).toEqual(['b2.ts:2 B1 main test-break']);
    expect(plan.preview!.steps[0]!.exposed[0]!.knownAs).toBe(testOnly.id);
  });

  it('does not call a finding resolved while it still fails under a spec that was not replayed', async () => {
    // Runtime after the first plan: b.spec still throws on b2.ts:2.
    const r = await analyzeProject({ ...GROUPS, 'src/main.ts': `export const x = 1;\n`, 'src/a.spec.ts': `import { A } from './a';\nexport const a = A;\n`, 'src/b.spec.ts': `import { B1 } from './b1';\nexport const b = B1;\n` }, SPECS);
    const a2 = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'a2.ts'))!;
    const b2 = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'b2.ts'))!;
    expect(b2.failures[0]!.entries.map((e) => name(e.entry))).toEqual(['b.spec.ts']);
    const plan = r.fixPlans.find((p) => p.cuts.some((c) => name(c.from) === 'a.ts'))!;
    expect(plan.preview!.entries).toBe(2); // main + a.spec; b.spec does not load a changed file
    expect(plan.preview!.steps[0]!.resolved).toEqual([a2.id]);
  });

  it('rewrites each import statement of a barrel in place when rewiring', async () => {
    // Runtime after rewriting both statements: main throws "Cannot access 'Z' before initialization".
    const r = await analyzeProject({
      'src/main.ts': `import './from';\n`,
      'src/from.ts': `import { a } from './lib';\nimport './z';\nimport { b } from './lib';\nexport const F = 1;\nexport const use = () => [a, b];\n`,
      'src/lib/index.ts': `export * from './a';\nexport * from './b';\nexport * from './w';\n`,
      'src/lib/a.ts': `export const a = 1;\n`,
      'src/lib/b.ts': `import { Z } from '../z';\nexport const b = [Z];\n`,
      'src/lib/w.ts': `import { F } from '../from';\nexport const W = [F];\n`,
      'src/z.ts': `import { b } from './lib/b';\nexport const Z = 1;\nexport const l = () => b;\n`,
    });
    const plan = r.fixPlans.find((p) => p.cuts[0]!.action === 'rewire-barrel')!;
    expect(plan.preview!.steps[0]!.exposed.map((x) => `${name(x.from)}:${x.line} ${x.binding}`)).toEqual(['b.ts:2 Z']);
  });

  it('rewrites an `export { x } from barrel` statement along with the imports', async () => {
    // Runtime after rewriting both statements of from.ts: main still throws on z.ts:2 (`b`), the w.ts crash is gone.
    const r = await analyzeProject({
      'src/main.ts': `import './from';
`,
      'src/from.ts': `export { b } from './lib';
import './z';
import { a } from './lib';
export const F = 1;
export const use = () => a;
`,
      'src/lib/index.ts': `export * from './a';
export * from './b';
export * from './w';
`,
      'src/lib/a.ts': `export const a = 1;
`,
      'src/lib/b.ts': `import { Z } from '../z';
export const b = 1;
export const l = () => Z;
`,
      'src/lib/w.ts': `import { F } from '../from';
export const W = [F];
`,
      'src/z.ts': `import { b } from './lib/b';
export const Z = [b];
`,
    });
    const w = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'w.ts'))!;
    const z = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'z.ts'))!;
    expect([w.severity, z.severity]).toEqual(['critical', 'critical']);
    const plan = r.fixPlans.find((p) => p.cuts[0]!.action === 'rewire-barrel')!;
    expect(plan.cuts[0]!.rewiredTo!.map(name).sort()).toEqual(['a.ts', 'b.ts']);
    expect(plan.preview!.steps[0]!.resolved).toEqual([w.id]); // the z.ts crash is not claimed
    expect(plan.preview!.steps[0]!.exposed).toEqual([]);
  });

  it('replays a move both ways: the new home of a symbol still loads what the symbol itself imports', async () => {
    // Runtime after moving `make` (which uses x.ts) to its own file: main still throws on y.ts:3 (`X`).
    // Had the using code been moved instead, x.ts would load later and y.ts:3 would be fine.
    const r = await analyzeProject({
      'src/main.ts': `import './p';
import './y';
`,
      'src/p.ts': `import { make } from './q';
export const P = 1;
export const later = () => make;
`,
      'src/q.ts': `import { P } from './p';
import { X } from './x';
export function make() { return X; }
export const Q = [P];
`,
      'src/x.ts': `import { Y } from './y';
export const X = 1;
export const l = () => Y;
`,
      'src/y.ts': `import { X } from './x';
export const Y = 1;
export const copy = [X];
`,
    });
    const q = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'q.ts'))!;
    const y = r.findings.find((f) => f.failures.some((fp) => name(fp.from) === 'y.ts'))!;
    expect([q.kind, y.kind]).toEqual(['runtime-break', 'runtime-break']);
    const plan = r.fixPlans.find((p) => p.cuts.some((c) => name(c.from) === 'p.ts'))!;
    expect(plan.cuts[0]!.loadsInstead!.map(name)).toEqual(['x.ts']);
    expect(plan.preview!.steps[0]!.resolved).toEqual([q.id]); // y.ts:3 survives one of the two ways
  });

  it('says when the imported symbol cannot simply be moved, and names renamed re-exports correctly', async () => {
    const stuck = await analyzeProject({
      'src/main.ts': `import './p';\n`,
      'src/p.ts': `import { make } from './q';\nexport const P = 1;\nexport const made = make();\n`,
      'src/q.ts': `import { P } from './p';\nimport { R } from './r';\nexport function make() { return R; }\nexport const l = () => P;\n`,
      'src/r.ts': `import { P } from './p';\nexport const R = [P];\n`,
    });
    const cut = stuck.fixPlans[0]!.cuts.find((c) => name(c.from) === 'p.ts' && name(c.to) === 'q.ts')!;
    expect(cut.reason).toContain('moving the symbol out is not enough, it depends on files that lead back');

    const renamed = await analyzeProject({
      'src/main.ts': `import { Feature } from './feature';\nexport const f = Feature;\n`,
      'src/feature.ts': `import { help } from './shared';\nexport class Feature { run() { return help(); } }\n`,
      'src/shared/index.ts': `export { helper as help } from './helper';\nexport * from './widget';\n`,
      'src/shared/helper.ts': `export const helper = () => 1;\n`,
      'src/shared/widget.ts': `import { Feature } from '../feature';\nexport class Widget { static owner = Feature.name; }\n`,
    });
    expect(renamed.fixPlans[0]!.cuts[0]!.reason).toContain("import { helper as help } from './shared/helper'");
  });
});
