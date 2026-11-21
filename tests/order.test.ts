/**
 * What is real today vs. what only depends on the import order – and what a fix does to that order.
 * Each project below was also executed for real (bun's ESM loader) while these cases were written;
 * the comments state the observed runtime behaviour.
 */
import { describe, expect, it } from 'bun:test';
import { analyzeProject } from './tmp-project.js';
import { Evaluator, edgeKey } from '../src/evaluate.js';

const name = (p: string): string => p.split('/').pop()!;
const SPECS = { noTestEntries: false, testEntries: ['src/**/*.spec.ts'] };

/** A two-file cycle that is safe when entered through b.ts and crashes when entered through a.ts. */
const SHARED = {
  'src/shared/a.ts': `import { B } from './b';\nexport class A { static make() { return new B(); } }\n`,
  'src/shared/b.ts': `import { A } from './a';\nexport class B extends A {}\n`,
};

describe('lazy chunks are replayed independently', () => {
  it('finds the crash of a lazy route that another lazy route would have hidden', async () => {
    // Runtime: main + feature-b + feature-a loads fine; main + feature-a (deep link) throws
    // "Cannot access 'A' before initialization". The route table lists feature-b first.
    const r = await analyzeProject({
      'src/main.ts': `import { routes } from './routes';\nexport const n = routes.length;\n`,
      'src/routes.ts': `export const routes = [\n  { path: 'b', load: () => import('./feature-b') },\n  { path: 'a', load: () => import('./feature-a') },\n];\n`,
      'src/feature-a.ts': `import { A } from './shared/a';\nexport const FA = A;\n`,
      'src/feature-b.ts': `import { B } from './shared/b';\nexport const FB = B;\n`,
      ...SHARED,
    });
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('critical');
    expect(f.failures[0]!.binding).toBe('A');
    expect(f.failures[0]!.entries.map((e) => `${e.kind}:${name(e.entry)}`)).toEqual(['lazy:feature-a.ts']);
    expect(r.entries.map((e) => `${e.kind}:${name(e.entry)}`)).toEqual(['main:main.ts', 'lazy:feature-b.ts', 'lazy:feature-a.ts']);
    // every lazy chunk belongs to the app entry that leads to it
    expect(r.entries.every((e) => name(e.root) === 'main.ts')).toBe(true);
    // the read is real, so it is not repeated as an order-dependent one
    expect(r.findings.filter((x) => x.kind === 'latent-cycle')).toHaveLength(0);
  });

  it('does not report a lazy chunk whose cycle the app has already loaded in a safe order', async () => {
    // Runtime: main (loads b first: safe), then feature-a: fine.
    const r = await analyzeProject({
      'src/main.ts': `import { B } from './shared/b';\nexport const load = () => import('./feature-a');\nexport const b = B;\n`,
      'src/feature-a.ts': `import { A } from './shared/a';\nexport const FA = A;\n`,
      ...SHARED,
    });
    expect(r.findings.filter((x) => x.severity === 'critical' || x.severity === 'high')).toHaveLength(0);
    expect(r.findings.map((x) => [x.kind, x.severity])).toEqual([['latent-cycle', 'low']]);
  });

  it('replays a chunk that two parents can load once per parent', async () => {
    // inner is loaded lazily by feature-a (which has loaded b: safe) and by feature-c (nothing loaded: crash).
    const r = await analyzeProject({
      'src/main.ts': `export const routes = [() => import('./feature-a'), () => import('./feature-c')];\n`,
      'src/feature-a.ts': `import { B } from './shared/b';\nexport const next = () => import('./inner');\nexport const b = B;\n`,
      'src/feature-c.ts': `export const next = () => import('./inner');\n`,
      'src/inner.ts': `import { A } from './shared/a';\nexport const I = A;\n`,
      ...SHARED,
    });
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f).toBeDefined();
    expect(f.failures[0]!.entries.map((e) => `${e.kind}:${name(e.entry)}`)).toEqual(['lazy:inner.ts']);
    // one row per chunk, however many parents lead to it
    expect(r.entries.filter((e) => name(e.entry) === 'inner.ts')).toHaveLength(1);
  });

  it('does not follow import() from a spec: nothing says the test ever triggers it', async () => {
    // Runtime: the app loads main (b first: safe) and then the lazy route: fine. The spec only
    // imports the route table. Following the chunk from the spec used to produce a false critical.
    const r = await analyzeProject(
      {
        'src/main.ts': `import { B } from './shared/b';\nimport { routes } from './routes';\nexport const n = [routes.length, B.name];\n`,
        'src/routes.ts': `export const routes = [{ path: 'a', load: () => import('./feature-a') }];\n`,
        'src/routes.spec.ts': `import { routes } from './routes';\nexport const ok = routes.length === 1;\n`,
        'src/feature-a.ts': `import { A } from './shared/a';\nexport const FA = A;\n`,
        ...SHARED,
      },
      SPECS,
    );
    expect(r.findings.filter((x) => x.severity === 'critical' || x.severity === 'high')).toHaveLength(0);
    // the chunk is replayed once, for the app; the spec stops at the route table
    expect(r.entries.map((e) => `${e.kind}:${name(e.entry)}`)).toEqual(['main:main.ts', 'lazy:feature-a.ts', 'test:routes.spec.ts']);
  });
});

describe('order-dependent reads (low)', () => {
  it('explains why nothing breaks: the files through which the entry points enter the group', async () => {
    // Runtime: main and shell.spec load fine; importing base.ts first would throw.
    const r = await analyzeProject(
      {
        'src/main.ts': `import { App } from './app';\nexport const a = App;\n`,
        'src/app.ts': `import { Shell } from './shell';\nexport class App { shell = new Shell(); }\n`,
        'src/shell.ts': `import { Base } from './base';\nexport class Shell extends Base {}\n`,
        'src/base.ts': `import { Shell } from './shell';\nexport class Base { make() { return new Shell(); } }\n`,
        'src/shell.spec.ts': `import { Shell } from './shell';\nexport const s = Shell;\n`,
      },
      SPECS,
    );
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect([f.kind, f.severity]).toEqual(['latent-cycle', 'low']);
    expect(f.enteredThrough).toEqual([{ file: r.file('src/shell.ts'), main: 1, lazy: 0, test: 1 }]);
    expect(f.summary).toContain('always entered through `src/shell.ts` (the app, 1 spec)');
    expect(f.failures.map((fp) => [name(fp.from), fp.binding, fp.triggerCount, fp.entries.map((e) => name(e.entry))])).toEqual([['shell.ts', 'Base', 1, ['base.ts']]]);
  });

  it('collects every order-dependent read of a group in one finding, next to the crash of that group', async () => {
    const r = await analyzeProject(CASCADE);
    expect(r.findings.map((f) => [f.kind, f.severity])).toEqual([
      ['runtime-break', 'critical'],
      ['latent-cycle', 'low'],
    ]);
    const latent = r.findings[1]!;
    expect(latent.title).toContain("2 load-time reads in group #1 rely on today's import order");
    expect(latent.failures.map((fp) => `${name(fp.from)}:${fp.usage.line} ${fp.binding}`)).toEqual(['theme.ts:3 Panel', 'widget.ts:3 THEME']);
    expect(latent.failures.every((fp) => fp.entries.every((e) => e.kind === 'hypothetical'))).toBe(true);
  });

  it('rates a possible crash that only a spec reaches as low', async () => {
    const r = await analyzeProject(
      {
        'src/main.ts': `export const nothing = 1;\n`,
        'src/a.ts': `import { get } from './b';\nexport const V = get(false);\n`,
        'src/b.ts': `import { V } from './a';\nconst A = 1;\nexport function get(useA: boolean) { if (useA) return A; return 0; }\nexport const later = () => V;\n`,
        'src/b.spec.ts': `import { later } from './b';\nexport const l = later;\n`,
      },
      SPECS,
    );
    const f = r.findings.find((x) => x.kind === 'possible-break')!;
    expect(f.severity).toBe('low');
    expect(f.title).toStartWith('Possible crash in tests');
    expect(f.failures[0]!.entries.map((e) => e.kind)).toEqual(['test']);
  });
});

/**
 * feature imports one helper through the shared barrel; the barrel drags in widget, which reads
 * Feature at load time (crash). theme reads Panel at load time, which is safe only because the
 * barrel is loaded on behalf of feature before panel starts.
 */
const CASCADE = {
  'src/main.ts': `import { Feature } from './feature';\nimport { Panel } from './panel';\nexport const all = [Feature, Panel];\n`,
  'src/feature.ts': `import { helper } from './shared';\nexport class Feature { run() { return helper(); } }\n`,
  'src/panel.ts': `import { Widget } from './shared';\nexport class Panel { static kind = 'panel'; w = new Widget(); }\n`,
  'src/shared/index.ts': `export * from './helper';\nexport * from './widget';\nexport * from './theme';\n`,
  'src/shared/helper.ts': `export const helper = () => 1;\n`,
  'src/shared/widget.ts': `import { Feature } from '../feature';\nimport { THEME } from './theme';\nexport class Widget { static owner = Feature.name; static theme = THEME; }\n`,
  'src/shared/theme.ts': `import { Panel } from '../panel';\nexport const THEME = { dark: true };\nexport const PANEL_KIND = Panel.kind;\n`,
};

describe('fix preview: replaying the entry points with the plan applied', () => {
  it('names the read that becomes the next crash once the first import is changed', async () => {
    // Runtime before: main throws "Cannot access 'Feature' before initialization".
    const r = await analyzeProject(CASCADE);
    const plan = r.fixPlans[0]!;
    expect(plan.verified).toBe(true);
    expect(plan.cuts.map((c) => `${c.action} ${name(c.from)}`)).toEqual(['rewire-barrel feature.ts', 'move-code panel.ts']);
    const preview = plan.preview!;
    expect(preview.simulated).toBe(true);
    expect(preview.entries).toBe(1);
    const [first, second] = preview.steps;
    // step 1 (import the helper directly): the Feature crash is gone, the load order has changed …
    expect(first!.resolved).toEqual(['C1']);
    expect(first!.remaining).toEqual([]);
    expect(first!.exposed.map((x) => `${name(x.from)}:${x.line} ${x.binding} ${x.entryKind} ${x.knownAs}`)).toEqual(['theme.ts:3 Panel main C2']);
    // … step 2: nothing is left and nothing new surfaces
    expect(second!.resolved).toEqual(['C1']);
    expect(second!.remaining).toEqual([]);
    expect(second!.exposed).toEqual([]);
  });

  it('predicts exactly what the next run reports after the first change is really made', async () => {
    // Runtime after: main throws "Cannot access 'Panel' before initialization".
    const before = await analyzeProject(CASCADE);
    const predicted = before.fixPlans[0]!.preview!.steps[0]!.exposed.map((x) => `${name(x.from)}:${x.line} ${x.binding}`);
    const after = await analyzeProject({ ...CASCADE, 'src/feature.ts': `import { helper } from './shared/helper';\nexport class Feature { run() { return helper(); } }\n` });
    const actual = after.findings.filter((f) => f.kind === 'runtime-break').flatMap((f) => f.failures.map((fp) => `${name(fp.from)}:${fp.usage.line} ${fp.binding}`));
    expect(actual).toEqual(['theme.ts:3 Panel']);
    expect(predicted).toEqual(actual);
  });

  it('reports a clean replay when one change resolves the whole group, and covers affected specs', async () => {
    const r = await analyzeProject(
      {
        'src/main.ts': `import './a';\n`,
        'src/a.ts': `import { B } from './b';\nexport class A { b() { return new B(); } }\n`,
        'src/b.ts': `import { A } from './a';\nexport class B extends A {}\n`,
        'src/a.spec.ts': `import { A } from './a';\nexport const a = A;\n`,
        'src/unrelated.ts': `export const u = 1;\n`,
        'src/unrelated.spec.ts': `import { u } from './unrelated';\nexport const x = u;\n`,
      },
      SPECS,
    );
    const preview = r.fixPlans[0]!.preview!;
    expect(preview.simulated).toBe(true);
    expect(preview.entries).toBe(2); // main + a.spec; unrelated.spec cannot reach the changed file
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0]!.resolved).toEqual(['C1']);
    expect(preview.steps[0]!.remaining).toEqual([]);
    expect(preview.steps[0]!.exposed).toEqual([]);
  });

  it('can be switched off', async () => {
    const r = await analyzeProject(CASCADE, { fixPreview: false });
    expect(r.fixPlans[0]!.preview).toBeUndefined();
    expect(r.stats.phases['fix-preview']).toBeUndefined();
  });
});

describe('what-if replay in the evaluator', () => {
  it('drops a removed import from the load order and from the checks; a rewired barrel import still checks its bindings', async () => {
    const r = await analyzeProject(CASCADE);
    const f = (rel: string): string => r.file(rel);
    const failing = (ev: Evaluator): string[] => ev.evaluateEntry(f('src/main.ts'), 'main').flatMap((e) => e.breakages.flatMap((b) => b.failing.map((x) => `${name(b.from)} ${x.binding}`)));

    expect(failing(new Evaluator(r.graph))).toEqual(['widget.ts Feature']);
    // widget no longer imports feature at all: nothing is read too early in this order
    expect(failing(new Evaluator(r.graph, { overrides: { removed: new Set([edgeKey(f('src/shared/widget.ts'), f('src/feature.ts'))]) } }))).toEqual([]);
    // feature imports helper.ts directly: the barrel now loads on behalf of panel
    const rewired = new Map([[edgeKey(f('src/feature.ts'), f('src/shared/index.ts')), [f('src/shared/helper.ts')]]]);
    expect(failing(new Evaluator(r.graph, { overrides: { rewired } }))).toEqual(['theme.ts Panel']);
  });

  it('records the file through which an evaluation enters each cyclic group', async () => {
    const r = await analyzeProject(CASCADE);
    const main = r.entries.find((e) => e.kind === 'main')!;
    expect([...main.gateways].map(([id, file]) => [id, name(file)])).toEqual([[1, 'feature.ts']]);
  });
});
