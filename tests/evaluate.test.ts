import { describe, expect, it } from 'bun:test';
import { analyzeProject } from './tmp-project.js';

describe('evaluation replay – binding states', () => {
  it('reports TDZ for const/class and undefined for var/enum/namespace depending on the entry', async () => {
    const files = {
      'src/a.ts': `import { v, E, N } from './b';\nexport const x = v;\nexport const e = E.One;\nexport const n = N.value;\n`,
      'src/b.ts': `import { x } from './a';\nexport var v = 1;\nexport enum E { One = 1 }\nexport namespace N { export const value = 2; }\nexport const y = x;\n`,
    };
    const fromA = await analyzeProject(files, { entries: ['src/a.ts'] });
    const failA = fromA.entries[0]!.breakages.flatMap((b) => b.failing);
    expect(failA).toHaveLength(1);
    expect(failA[0]!.specifier.imported).toBe('x');
    expect(failA[0]!.state).toBe('tdz');
    expect(failA[0]!.originKind).toBe('const');

    const fromB = await analyzeProject(files, { entries: ['src/b.ts'] });
    const failB = fromB.entries[0]!.breakages.flatMap((b) => b.failing).sort((p, q) => p.usage.line - q.usage.line);
    expect(failB.map((f) => [f.specifier.imported, f.state, f.originKind])).toEqual([
      ['v', 'undefined', 'var'],
      ['E', 'undefined', 'enum'],
      ['N', 'undefined', 'namespace'],
    ]);
    const finding = fromB.findings.find((f) => f.kind === 'runtime-break')!;
    expect(finding.summary).toContain("'v' is undefined");
  });

  it('never fails on hoisted function declarations', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import { helper } from './b';\nexport const x = 1;\nexport function fromA() { return 1; }\nexport const h = helper();\n`,
      'src/b.ts': `import { fromA } from './a';\nexport const early = fromA();\nexport function helper() { return 2; }\n`,
    });
    expect(r.entries[0]!.breakages.flatMap((b) => b.failing)).toHaveLength(0);
    expect(r.findings.map((f) => f.kind)).toEqual(['deferred-cycle']);
    expect(r.findings[0]!.title).toContain('cannot break');
  });

  it('resolves re-exported bindings to their origin and checks that module state (barrel order matters)', async () => {
    const good = await analyzeProject({
      'src/main.ts': `import './index';\n`,
      'src/index.ts': `export * from './x';\nexport * from './y';\n`,
      'src/x.ts': `export class X {}\n`,
      'src/y.ts': `import { X } from './index';\nexport const y = new X();\n`,
    });
    expect(good.entries[0]!.breakages.flatMap((b) => b.failing)).toHaveLength(0);

    const bad = await analyzeProject({
      'src/main.ts': `import './index';\n`,
      'src/index.ts': `export * from './y';\nexport * from './x';\n`,
      'src/x.ts': `export class X {}\n`,
      'src/y.ts': `import { X } from './index';\nexport const y = new X();\n`,
    });
    const failing = bad.entries[0]!.breakages.flatMap((b) => b.failing);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.originState).toBe('not-started');
    expect(failing[0]!.originPath).toBe(bad.file('src/x.ts'));
    expect(failing[0]!.state).toBe('tdz');
    const f = bad.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f.summary).toContain('src/x.ts');
    // barrel bypass is the verified fix
    expect(f.suggestions.some((s) => s.kind === 'direct-import' && s.verified)).toBe(true);
  });

  it('handles namespace imports member-wise', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import * as b from './b';\nexport const fromB = b.value;\nexport function safe() { return b.later; }\nexport const A = 1;\n`,
      'src/b.ts': `import * as a from './a';\nexport const value = a.A;\nexport const later = 2;\n`,
    });
    const failing = r.entries[0]!.breakages.flatMap((x) => x.failing);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.usage.member).toBe('A');
    expect(failing[0]!.specifier.imported).toBe('*');
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f.failures[0]!.symbol).toBe('a.A');
  });

  it('evaluates dynamic import targets as lazy roots after the main graph and skips already loaded modules', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import { shared } from './shared';\nexport const load = () => import('./lazy');\nexport const again = () => import('./shared');\nconsole.log(shared);\n`,
      'src/shared.ts': `export const shared = 1;\n`,
      'src/lazy.ts': `import { part } from './lazy-part';\nexport const LAZY = [part];\n`,
      'src/lazy-part.ts': `import { LAZY } from './lazy';\nexport const part = LAZY.length;\n`,
    });
    expect(r.entries.map((e) => [e.kind, e.entry.split('/').pop()])).toEqual([
      ['main', 'main.ts'],
      ['lazy', 'lazy.ts'],
    ]);
    const lazy = r.entries[1]!;
    expect(lazy.breakages.flatMap((b) => b.failing).map((f) => f.specifier.imported)).toEqual(['LAZY']);
    expect(r.findings[0]!.kind).toBe('runtime-break');
    expect(r.findings[0]!.failures[0]!.entries[0]!.kind).toBe('lazy');
    // main -> shared is both static and dynamic, so only main -> lazy counts as dynamic-only
    expect(r.stats.dynamicEdges).toBe(1);
    expect(r.entries[0]!.evaluatedCount).toBe(2);
  });

  it('replays every spec file in isolation and reports spec-only crashes as high', async () => {
    // main -> b -> a: a only uses B inside a method, b's `extends A` runs after a finished: safe.
    // a.spec / other.spec -> a -> b: `extends A` runs while a is still initialising: crash.
    const r = await analyzeProject(
      {
        'src/main.ts': `import './b';\n`,
        'src/a.ts': `import { B } from './b';\nexport class A { b() { return new B(); } }\n`,
        'src/b.ts': `import { A } from './a';\nexport class B extends A {}\n`,
        'src/a.spec.ts': `import { A } from './a';\nvoid A;\n`,
        'src/b.spec.ts': `import { B } from './b';\nvoid B;\n`,
        'src/other.spec.ts': `import { A } from './a';\nvoid A;\n`,
      },
      { noTestEntries: false, testEntries: ['src/**/*.spec.ts'] },
    );
    expect(r.findings.filter((x) => x.kind === 'runtime-break')).toHaveLength(0);
    const f = r.findings.find((x) => x.kind === 'test-break')!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('high');
    const entries = f.failures[0]!.entries.map((e) => e.entry.split('/').pop()).sort();
    expect(entries).toEqual(['a.spec.ts', 'other.spec.ts']);
    expect(r.entries.filter((e) => e.kind === 'test')).toHaveLength(3);
    expect(r.entries.find((e) => e.entry.endsWith('b.spec.ts'))!.breakages.flatMap((b) => b.failing)).toHaveLength(0);
  });

  it('marks a failure critical when the app entry reaches it and lists every entry', async () => {
    const r = await analyzeProject(
      {
        'src/main.ts': `import './a';\n`,
        'src/a.ts': `import { B } from './b';\nexport class A { b() { return new B(); } }\n`,
        'src/b.ts': `import { A } from './a';\nexport class B extends A {}\n`,
        'src/a.spec.ts': `import { A } from './a';\nvoid A;\n`,
        'src/b.spec.ts': `import { B } from './b';\nvoid B;\n`,
      },
      { noTestEntries: false, testEntries: ['src/**/*.spec.ts'] },
    );
    const f = r.findings[0]!;
    expect(f.kind).toBe('runtime-break');
    expect(f.severity).toBe('critical');
    expect(f.failures[0]!.entries.map((e) => `${e.kind}:${e.entry.split('/').pop()}`).sort()).toEqual(['main:main.ts', 'test:a.spec.ts']);
    expect(f.failures[0]!.entries.find((e) => e.kind === 'main')!.chain.map((p) => p.split('/').pop())).toEqual(['main.ts', 'a.ts', 'b.ts']);
    expect(r.findings.filter((x) => x.kind === 'test-break' || x.kind === 'latent-cycle')).toHaveLength(0);
  });

  it('treats functions invoked at module load as eager (top-level-call)', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import { B } from './b';\nexport const A = 1;\nfunction setup() { return new B(); }\nsetup();\n`,
      'src/b.ts': `import { A } from './a';\nexport class B { a = A; }\n`,
    });
    // main -> a -> b (a in progress): b uses A inside an instance field: deferred -> fine.
    // Then a runs setup() -> new B() -> field initializer reads A: A is a's own binding, fine.
    // So there is no failure here, but the usage of B in a.ts must be classified eager.
    const a = r.graph.modules.get(r.file('src/a.ts'))!;
    const spec = a.imports[0]!.specifiers[0]!;
    expect(spec.effectiveTiming).toBe('eager');
    expect(spec.usages[0]!.contextKind).toBe('top-level-call');
    expect(r.findings.find((f) => f.kind === 'latent-cycle')).toBeDefined();
  });

  it('ignores erased type-only edges during replay', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import { B } from './b';\nexport interface A { b: B }\nexport const marker = 1;\n`,
      'src/b.ts': `import { marker } from './a';\nexport const B = marker;\n`,
    });
    expect(r.entries[0]!.breakages).toHaveLength(0);
    expect(r.stats.sccs).toBe(0);
    expect(r.findings.map((f) => f.kind)).toEqual(['type-only-cycle']);
  });
});
