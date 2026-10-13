/**
 * Detection precision: each case is a minimal project where a naive cycle checker (or an earlier
 * version of this tool) is wrong – either missing a real load-time crash or reporting one that
 * cannot happen.
 */
import { describe, expect, it } from 'bun:test';
import { analyzeProject } from './tmp-project.js';

const failingOf = (r: Awaited<ReturnType<typeof analyzeProject>>) =>
  r.entries.filter((e) => e.kind !== 'hypothetical').flatMap((e) => e.breakages.flatMap((b) => b.failing));

describe('evaluation at body time', () => {
  it('catches a read through a barrel that has already finished while the declaring file is still loading', async () => {
    // main -> x (loading) -> index (re-exports x and y, finishes) -> z reads X from index:
    // index is done but X's module x has not run yet.
    const r = await analyzeProject({
      'src/main.ts': `import './x';\n`,
      'src/x.ts': `import { Y } from './index';\nimport { zz } from './z';\nexport class X {}\nexport const use = () => [Y, zz];\n`,
      'src/index.ts': `export * from './x';\nexport * from './y';\n`,
      'src/y.ts': `export const Y = 1;\n`,
      'src/z.ts': `import { X } from './index';\nexport const zz = new X();\n`,
    });
    const failing = failingOf(r);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.binding).toBe('X');
    expect(failing[0]!.originPath).toBe(r.file('src/x.ts'));
    expect(failing[0]!.originState).toBe('in-progress');
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f.severity).toBe('critical');
    // the reported cycle runs through the declaring file, not just the barrel edge
    expect(f.cycle!.nodes.map((n) => n.split('/').pop())).toEqual(['z.ts', 'index.ts', 'x.ts']);
  });

  it('allows reading a binding of the running module itself (through a barrel) only after its declaration', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './m';\n`,
      'src/index.ts': `export * from './m';\n`,
      'src/m.ts': `import { early, late } from './index';\nexport const early = 1;\nexport const x = early;\nexport const y = late;\nexport const late = 2;\n`,
    });
    const failing = failingOf(r);
    expect(failing.map((f) => f.binding)).toEqual(['late']);
  });

  it('does not guess about bindings it cannot resolve (e.g. re-exported from an external package)', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './index';\n`,
      'src/index.ts': `export * from './a';\nexport * from '@ext/pkg';\n`,
      'src/a.ts': `import { ExtThing } from './index';\nexport const A = ExtThing;\n`,
    });
    expect(failingOf(r)).toHaveLength(0);
    expect(r.findings.filter((f) => f.failures.length > 0)).toHaveLength(0);
  });
});

describe('load-time calls into other modules', () => {
  it('reports a hoisted function that reads a const of its own, not yet evaluated, module', async () => {
    // main -> b (loading) -> a: a calls make() during load; make is hoisted, but PREFIX in b has not run.
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { make } from './b';\nexport const A = make();\n`,
      'src/b.ts': `import { A } from './a';\nconst PREFIX = 'p';\nexport function make(): string { return PREFIX + 1; }\nexport const later = () => A;\n`,
    });
    const f = r.findings.find((x) => x.kind === 'runtime-break')!;
    expect(f).toBeDefined();
    const fp = f.failures[0]!;
    expect(fp.symbol).toBe('make');
    expect(fp.binding).toBe('PREFIX');
    expect(fp.originPath).toBe(r.file('src/b.ts'));
    expect(fp.via).toEqual([{ fn: 'make', path: r.file('src/b.ts'), line: 3 }]);
    expect(f.title).toContain('`make()` reads `PREFIX` before initialisation');
    expect(f.summary).toContain("ReferenceError: Cannot access 'PREFIX' before initialization");
  });

  it('follows call chains across files', async () => {
    // main -> c (loading) -> a -> b; a calls make() (b) which calls helper() (c) which reads SEP of c.
    const r = await analyzeProject({
      'src/main.ts': `import './c';\n`,
      'src/c.ts': `import { A } from './a';\nconst SEP = '-';\nexport function helper(): string { return SEP; }\nexport const useA = () => A;\n`,
      'src/a.ts': `import { make } from './b';\nexport const A = make();\n`,
      'src/b.ts': `import { helper } from './c';\nexport function make(): string { return helper(); }\n`,
    });
    const fp = r.findings.find((x) => x.kind === 'runtime-break')!.failures[0]!;
    expect(fp.binding).toBe('SEP');
    expect(fp.via!.map((s) => `${s.fn}@${s.path.split('/').pop()}:${s.line}`)).toEqual(['make@b.ts:2', 'helper@c.ts:3']);
  });

  it('stays quiet when the called function only reads bindings that are already initialised', async () => {
    // constants.ts runs PREFIX before calling formatTitle(), which reads PREFIX back: fine.
    const r = await analyzeProject({
      'src/main.ts': `import './format';\n`,
      'src/format.ts': `import { PREFIX } from './constants';\nexport function formatTitle(s: string): string { return PREFIX + s; }\n`,
      'src/constants.ts': `import { formatTitle } from './format';\nexport const PREFIX = '[';\nexport const TITLE = formatTitle('t');\n`,
    });
    expect(failingOf(r)).toHaveLength(0);
    expect(r.findings.map((f) => f.kind)).toEqual(['deferred-cycle']);
  });

  it('ignores reads inside callbacks the called function only creates (not invokes)', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { provide } from './b';\nexport const P = provide();\n`,
      'src/b.ts': `import { P } from './a';\nconst TOKEN = 'x';\nexport function provide() { return { useFactory: () => TOKEN }; }\nexport const later = () => P;\n`,
    });
    expect(failingOf(r)).toHaveLength(0);
  });

  it('follows `new X()` into constructors and instance fields', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { Registry } from './b';\nexport const registry = new Registry();\n`,
      'src/b.ts': `import { registry } from './a';\nconst DEFAULTS = { size: 1 };\nexport function Registry(this: { size: number }) { this.size = DEFAULTS.size; }\nexport const later = () => registry;\n`,
    });
    const fp = r.findings.find((x) => x.kind === 'runtime-break')!.failures[0]!;
    expect(fp.binding).toBe('DEFAULTS');
  });
});

describe('what the compiler actually emits', () => {
  const constEnumFiles = {
    'src/main.ts': `import './a';\n`,
    'src/a.ts': `import { Mode } from './b';\nexport const DEFAULT = Mode.X;\n`,
    'src/b.ts': `import { DEFAULT } from './a';\nexport const enum Mode { X = 1 }\nexport function f() { return DEFAULT; }\n`,
  };

  it('treats `const enum` imports as erased when isolatedModules is off (members are inlined)', async () => {
    const r = await analyzeProject(constEnumFiles, { compilerOptions: { isolatedModules: false } });
    expect(r.stats.sccs).toBe(0);
    expect(r.findings.filter((f) => f.failures.length > 0)).toHaveLength(0);
    const a = r.graph.modules.get(r.file('src/a.ts'))!;
    expect(a.imports[0]!.erased).toBe(true);
  });

  it('keeps `const enum` imports as runtime reads under isolatedModules (tsc keeps import and member access)', async () => {
    const r = await analyzeProject(constEnumFiles, { compilerOptions: { isolatedModules: true } });
    expect(r.stats.sccs).toBe(1);
    expect(r.findings.some((f) => f.failures.some((fp) => fp.binding === 'Mode'))).toBe(true);
  });

  it('treats instantiation expressions `make<T>` as value reads', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { make } from './b';\nexport const makeString = make<string>;\n`,
      'src/b.ts': `import { makeString } from './a';\nexport const make = <T>(v: T) => v;\nexport const later = () => makeString;\n`,
    });
    const a = r.graph.modules.get(r.file('src/a.ts'))!;
    expect(a.imports[0]!.specifiers[0]!.effectiveTiming).toBe('eager');
    expect(r.findings[0]!.kind).toBe('runtime-break');
  });

  it('keeps Angular constructor-injection imports alive but erases interface parameters', async () => {
    const NG = `import { Injectable } from '@angular/core';\n`;
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { BService } from './b.service';\nimport { Options } from './options';\n@Injectable({ providedIn: 'root' })\nexport class AService { constructor(private b: BService, private o: Options) {} }\n`,
      'src/b.service.ts': `${NG}@Injectable({ providedIn: 'root' })\nexport class BService {}\n`,
      'src/options.ts': `export interface Options { a: number }\n`,
    });
    const a = r.graph.modules.get(r.file('src/a.service.ts'))!;
    expect(a.imports.find((i) => i.specifierText === './b.service')!.erased).toBe(false);
    expect(a.imports.find((i) => i.specifierText === './options')!.erased).toBe(true);
  });
});

describe('order-dependent cycles are proven, not guessed', () => {
  it('reports medium only with the concrete first-imported file that crashes', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './defaults';\n`,
      'src/defaults.ts': `import { Status } from './status';\nexport const DEFAULT = Status.On;\n`,
      'src/status.ts': `import { DEFAULT } from './defaults';\nexport enum Status { On = 1 }\nexport const isDefault = (s: Status) => s === DEFAULT;\n`,
    });
    const m = r.findings.filter((f) => f.kind === 'latent-cycle');
    expect(m).toHaveLength(1);
    expect(m[0]!.failures[0]!.state).toBe('undefined'); // enums are `var`-like
    expect(m[0]!.failures[0]!.entries).toEqual([{ entry: r.file('src/status.ts'), kind: 'hypothetical', chain: [r.file('src/status.ts'), r.file('src/defaults.ts')] }]);
    expect(r.stats.replayedOrders).toBe(2);
  });

  it('reports one low finding per harmless group instead of one per cycle', async () => {
    // a <-> b, b <-> c, a <-> c: three cycles, all deferred.
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import { b } from './b';\nimport { c } from './c';\nexport function a() { return [b, c]; }\n`,
      'src/b.ts': `import { a } from './a';\nimport { c } from './c';\nexport function b() { return [a, c]; }\n`,
      'src/c.ts': `import { a } from './a';\nimport { b } from './b';\nexport function c() { return [a, b]; }\n`,
    });
    expect(r.sccs[0]!.cycles.length).toBeGreaterThanOrEqual(3);
    const low = r.findings.filter((f) => f.kind === 'deferred-cycle');
    expect(low).toHaveLength(1);
    expect(low[0]!.title).toContain('3 files');
  });
});

describe('fix plans', () => {
  it('does not propose rewiring a barrel import when the declaring file leads straight back', async () => {
    // base imports ListItem through the list barrel (deferred); list-item extends Base. Importing
    // list-item directly would keep the cycle, so the plan must cut base -> list differently.
    const r = await analyzeProject({
      'src/main.ts': `import './base';\n`,
      'src/base.ts': `import { ListItem } from './list';\nexport class Base { child() { return new ListItem(); } }\n`,
      'src/list/index.ts': `export * from './list-item';\n`,
      'src/list/list-item.ts': `import { Base } from '../base';\nexport class ListItem extends Base {}\n`,
    });
    const plan = r.fixPlans[0]!;
    expect(plan.verified).toBe(true);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.action).toBe('move-code');
    expect(plan.cuts[0]!.from).toBe(r.file('src/base.ts'));
    expect(plan.cuts[0]!.reason).toContain('only used inside functions/methods');
  });

  it('rewires a barrel import when that alone breaks the cycle and verifies the rewired graph', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './feature';\n`,
      'src/feature.ts': `import { helper } from './shared';\nexport const FEATURE = 1;\nexport const run = () => helper();\n`,
      'src/shared/index.ts': `export * from './helper';\nexport * from './uses-feature';\n`,
      'src/shared/helper.ts': `export const helper = () => 1;\n`,
      'src/shared/uses-feature.ts': `import { FEATURE } from '../feature';\nexport const f = () => FEATURE;\n`,
    });
    const plan = r.fixPlans[0]!;
    expect(plan.verified).toBe(true);
    expect(plan.cuts.map((c) => c.action)).toEqual(['rewire-barrel']);
    expect(plan.cuts[0]!.rewiredTo).toEqual([r.file('src/shared/helper.ts')]);
  });
});

describe('Angular DI', () => {
  const NG = `import { Injectable, InjectionToken, inject } from '@angular/core';\n`;

  it('detects cycles through InjectionToken factories', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './api.service';\n`,
      'src/tokens.ts': `${NG}import { ApiService } from './api.service';\nexport const API_URL = new InjectionToken<string>('api', { providedIn: 'root', factory: () => inject(ApiService).base });\n`,
      'src/api.service.ts': `${NG}import { API_URL } from './tokens';\n@Injectable({ providedIn: 'root' })\nexport class ApiService { readonly base = '/'; private readonly url = inject(API_URL); }\n`,
    });
    const di = r.findings.find((f) => f.kind === 'di-cycle')!;
    expect(di).toBeDefined();
    expect(di.diCycle!.nodes.map((n) => n.name).sort()).toEqual(['API_URL', 'ApiService']);
    expect(di.diCycle!.nodes.find((n) => n.name === 'API_URL')!.decorator).toBe('InjectionToken');
  });

  it('detects cycles through useFactory providers that call inject()', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './app.config';\n`,
      'src/app.config.ts': `${NG}import { Store } from './store';\nimport { Logger } from './logger';\n@Injectable()\nexport class Root {}\nexport const providers = [{ provide: Logger, useFactory: () => new Logger(inject(Store)) }];\n@Injectable({ providedIn: 'root' })\nexport class Holder {}\n`,
      'src/logger.ts': `export class Logger { constructor(readonly s: unknown) {} }\n`,
      'src/store.ts': `${NG}import { Logger } from './logger';\n@Injectable({ providedIn: 'root' })\nexport class Store { private readonly log = inject(Logger); }\n`,
    });
    // root-level providers (app.config.ts style) are part of the root injector
    expect(r.diCycles).toHaveLength(1);
    expect(r.diCycles[0]!.nodes.map((n) => n.name).sort()).toEqual(['Logger', 'Store']);
    // In a component injector: a root-provided Store cannot see the component's Logger (no cycle),
    // but providing Store in the same component closes the cycle there.
    const componentWith = (extra: string) => ({
      'src/main.ts': `import './app.component';\n`,
      'src/app.component.ts': `${NG.replace('Injectable,', 'Injectable, Component,')}import { Store } from './store';\nimport { Logger } from './logger';\n@Component({ selector: 'app', template: '', providers: [${extra}{ provide: Logger, useFactory: () => new Logger(inject(Store)) }] })\nexport class AppComponent {}\n`,
      'src/logger.ts': `export class Logger { constructor(readonly s: unknown) {} }\n`,
      'src/store.ts': `${NG}import { Logger } from './logger';\n@Injectable({ providedIn: 'root' })\nexport class Store { private readonly log = inject(Logger); }\n`,
    });
    expect((await analyzeProject(componentWith(''))).diCycles).toHaveLength(0);
    const r2 = await analyzeProject(componentWith('Store, '));
    expect(r2.diCycles).toHaveLength(1);
    expect(r2.diCycles[0]!.nodes.map((n) => n.name).sort()).toEqual(['Logger', 'Store']);
  });
});

describe('reads that run at load time without looking like it', () => {
  it('treats callbacks of synchronous array methods as running now', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { B } from './b';\nexport const sizes = [1, 2].map((x) => x * B.n);\n`,
      'src/b.ts': `import { sizes } from './a';\nexport class B { static n = 2; }\nexport const later = () => sizes;\n`,
    });
    const fp = r.findings.find((f) => f.kind === 'runtime-break')!.failures[0]!;
    expect(fp.symbol).toBe('B');
    expect(fp.usage.context).toContain('callback passed to `.map()` runs immediately');
  });

  it('keeps callbacks of asynchronous APIs deferred', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { B } from './b';\nexport const p = Promise.resolve().then(() => B.n);\nsetTimeout(() => B.n);\n`,
      'src/b.ts': `import { p } from './a';\nexport class B { static n = 2; }\nexport const later = () => p;\n`,
    });
    expect(r.findings.filter((f) => f.failures.length > 0)).toHaveLength(0);
  });

  it('follows static methods of local classes called at load time', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import { B } from './b';\nclass Registry { static build() { return new B(); } }\nexport const instance = Registry.build();\n`,
      'src/b.ts': `import { instance } from './a';\nexport class B {}\nexport const later = () => instance;\n`,
    });
    const fp = r.findings.find((f) => f.kind === 'runtime-break')!.failures[0]!;
    expect(fp.symbol).toBe('B');
    expect(fp.usage.contextKind).toBe('top-level-call');
  });

  it('follows static methods of imported classes called at load time', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      // main -> b (loading) -> a -> f (runs: only a deferred read of b) -> a calls Factory.create(), which reads b's DEFAULTS
      'src/a.ts': `import { Factory } from './f';\nexport const made = Factory.create();\n`,
      'src/f.ts': `import { DEFAULTS } from './b';\nexport class Factory { static create() { return { ...DEFAULTS }; } }\n`,
      'src/b.ts': `import { made } from './a';\nexport const DEFAULTS = { a: 1 };\nexport const later = () => made;\n`,
    });
    const fp = r.findings.find((f) => f.kind === 'runtime-break')!.failures[0]!;
    expect(fp.binding).toBe('DEFAULTS');
    expect(fp.via!.map((v) => v.fn)).toEqual(['Factory.create']);
  });

  it('records members read by destructuring a namespace import', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import * as b from './b';\nconst { VALUE } = b;\nexport const A = VALUE;\n`,
      'src/b.ts': `import { A } from './a';\nexport const VALUE = 1;\nexport const later = () => A;\n`,
    });
    const fp = r.findings.find((f) => f.kind === 'runtime-break')!.failures[0]!;
    expect(fp.binding).toBe('VALUE');
  });

  it('treats Object.keys(ns) / spreads as reading every exported binding', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './b';\n`,
      'src/a.ts': `import * as b from './b';\nexport const names = Object.keys(b);\n`,
      'src/b.ts': `import { names } from './a';\nexport const ONE = 1;\nexport const later = () => names;\n`,
    });
    const fp = r.findings.find((f) => f.kind === 'runtime-break')!.failures[0]!;
    expect(fp.symbol).toBe('b.*');
    expect(['ONE', 'later']).toContain(fp.binding);
  });
});

describe('no false alarms', () => {
  it('ignores named re-exports from packages (their state is unknown)', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './index';\n`,
      'src/index.ts': `export * from './a';\nexport { version } from 'some-package';\n`,
      'src/a.ts': `import { version } from './index';\nexport const V = version;\n`,
    });
    expect(r.findings.filter((f) => f.failures.length > 0)).toHaveLength(0);
  });

  it('treats `export * as ns` namespace objects as always available', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './index';\n`,
      'src/index.ts': `export * from './a';\nexport * as util from './u';\n`,
      'src/u.ts': `export const x = 1;\n`,
      'src/a.ts': `import { util } from './index';\nexport const holder = { util };\n`,
    });
    expect(r.findings.filter((f) => f.failures.length > 0)).toHaveLength(0);
  });

  it('resolves names through mutually re-exporting barrels independent of query order', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import { N } from './a';\nimport { N as N2 } from './b';\nconsole.log(N, N2);\n`,
      'src/a.ts': `export * from './b';\nexport * from './c';\n`,
      'src/b.ts': `export * from './a';\n`,
      'src/c.ts': `export const N = 1;\n`,
    });
    const { resolveExport } = await import('../src/graph.js');
    const cache = new Map();
    expect(resolveExport(r.graph, r.file('src/a.ts'), 'N', cache)?.originPath).toBe(r.file('src/c.ts'));
    expect(resolveExport(r.graph, r.file('src/b.ts'), 'N', cache)?.originPath).toBe(r.file('src/c.ts'));
  });

  it('erases `import x = require()` when x is only used as a type and type-only named re-exports', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import b = require('./b');\nexport { Shape } from './shape';\nexport const f = (v: b.T) => v;\n`,
      'src/b.ts': `import { f } from './a';\nexport type T = number;\nexport const g = () => f;\n`,
      'src/shape.ts': `import { f } from './a';\nexport interface Shape { a: number }\nexport const h = () => f;\n`,
    });
    const a = r.graph.modules.get(r.file('src/a.ts'))!;
    expect(a.imports.find((i) => i.specifierText === './b')!.erased).toBe(true);
    expect(a.imports.find((i) => i.specifierText === './shape')!.erased).toBe(true);
    expect(r.stats.sccs).toBe(0);
  });
});

describe('suggestions stay honest', () => {
  it('lazy-route advice is not verified while other imports keep the static edge', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './routes';\n`,
      'src/routes.ts': `import { AdminComponent, ADMIN_TITLE } from './admin';\nexport const routes = [{ path: 'a', component: AdminComponent, title: ADMIN_TITLE }];\n`,
      'src/admin.ts': `import { routes } from './routes';\nexport const ADMIN_TITLE = 'Admin';\nexport class AdminComponent { static count = routes.length; }\n`,
    });
    const all = r.findings.flatMap((f) => f.suggestions).filter((s) => s.kind === 'lazy-route');
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((s) => !s.verified)).toBe(true);
    expect(all[0]!.text).toContain('`ADMIN_TITLE` still keeps the static import');
  });

  it('move-symbol follows local helpers the symbol uses', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a';\n`,
      'src/a.ts': `import { Widget } from './b';\nexport const A_CFG = { size: 1 };\nexport const w = new Widget();\n`,
      'src/b.ts': `import { A_CFG } from './a';\nfunction cfg() { return A_CFG; }\nexport class Widget { size = cfg().size; }\n`,
    });
    const move = r.findings.flatMap((f) => f.suggestions).find((s) => s.kind === 'move-symbol' && s.text.includes('`Widget`'))!;
    expect(move).toBeDefined();
    expect(move.verified).toBe(false);
    expect(move.details!.join(' ')).toContain('src/a.ts');
  });
});
