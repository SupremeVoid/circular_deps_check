import { describe, expect, it } from 'bun:test';
import { analyzeFixture, cycleFiles, endsWith, findingsOfKind } from './helpers.js';

describe('fixture 01-basic', () => {
  it('reports the load-time crash reachable from main as critical with the exact failing usage', async () => {
    const r = await analyzeFixture('01-basic');
    const crit = findingsOfKind(r, 'runtime-break');
    expect(crit).toHaveLength(1);
    const f = crit[0]!;
    expect(f.severity).toBe('critical');
    expect(f.id).toBe('C1');
    expect(cycleFiles(f).sort()).toEqual(['app/app.ts', 'app/config.ts']);
    expect(f.failures).toHaveLength(1);
    const fp = f.failures[0]!;
    expect(endsWith(fp.from, 'src/app/config.ts')).toBe(true);
    expect(endsWith(fp.to, 'src/app/app.ts')).toBe(true);
    expect(fp.symbol).toBe('routes');
    expect(fp.originKind).toBe('const');
    expect(fp.state).toBe('tdz');
    expect(fp.usage.line).toBe(4);
    expect(fp.usage.contextKind).toBe('top-level');
    expect(fp.entries.map((e) => e.kind)).toEqual(['main']);
    // full chain from the entry, ancestor on it
    expect(fp.entries[0]!.chain.map((p) => p.split('/').pop())).toEqual(['main.ts', 'app.ts', 'config.ts']);
    // verified move-symbol suggestion
    expect(f.suggestions.some((s) => s.kind === 'move-symbol' && s.verified)).toBe(true);
    // never suggests import type
    expect(f.suggestions.every((s) => !/import type/.test(s.text))).toBe(true);
  });

  it('reports the extends cycle as high because it only breaks when loaded from the spec', async () => {
    const r = await analyzeFixture('01-basic');
    const tb = findingsOfKind(r, 'test-break');
    expect(tb).toHaveLength(1);
    const f = tb[0]!;
    expect(f.severity).toBe('high');
    const fp = f.failures[0]!;
    expect(fp.symbol).toBe('BaseComponent');
    expect(fp.usage.contextKind).toBe('extends');
    expect(fp.entries).toHaveLength(1);
    expect(fp.entries[0]!.kind).toBe('test');
    expect(endsWith(fp.entries[0]!.entry, 'base.component.spec.ts')).toBe(true);
  });

  it('does not flag the extends cycle from the main entry (safe order)', async () => {
    const r = await analyzeFixture('01-basic');
    const main = r.entries.find((e) => e.kind === 'main')!;
    const failing = main.breakages.filter((b) => b.failing.length > 0);
    expect(failing).toHaveLength(1);
    expect(endsWith(failing[0]!.from, 'config.ts')).toBe(true);
    // the extends back-edge is recorded but only with deferred usage
    const extendsEdge = main.breakages.find((b) => endsWith(b.from, 'base.component.ts'))!;
    expect(extendsEdge.failing).toHaveLength(0);
    expect(extendsEdge.deferredCount).toBe(1);
  });

  it('classifies deferred-only and hoisted-function cycles as low', async () => {
    const r = await analyzeFixture('01-basic');
    const low = findingsOfKind(r, 'deferred-cycle');
    expect(low).toHaveLength(2);
    expect(low.every((f) => f.severity === 'low')).toBe(true);
    const files = low.map((f) => cycleFiles(f).sort().join('+')).sort();
    expect(files).toEqual(['services/a.service.ts+services/b.service.ts', 'utils/constants.ts+utils/format.ts']);
    const hoisted = low.find((f) => cycleFiles(f).some((x) => x.endsWith('format.ts')))!;
    expect(hoisted.title).toContain('cannot break');
  });

  it('reports the interface-only cycle as info and counts erased edges', async () => {
    const r = await analyzeFixture('01-basic');
    const info = findingsOfKind(r, 'type-only-cycle');
    expect(info).toHaveLength(1);
    expect(info[0]!.severity).toBe('info');
    expect(cycleFiles(info[0]!).sort()).toEqual(['models/order.model.ts', 'models/user.model.ts']);
    expect(r.stats.erasedEdges).toBe(2);
    expect(r.stats.sccs).toBe(4);
    expect(r.stats.typeOnlyCycles).toBe(1);
    expect(r.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'low', 'low', 'info']);
  });

  it('produces a verified fix plan for every group', async () => {
    const r = await analyzeFixture('01-basic');
    expect(r.fixPlans).toHaveLength(4);
    expect(r.fixPlans.every((p) => p.verified && p.cuts.length === 1)).toBe(true);
  });

  it('respects noTestEntries', async () => {
    const r = await analyzeFixture('01-basic', { noTestEntries: true });
    expect(findingsOfKind(r, 'test-break')).toHaveLength(0);
    // the extends cycle is now order-dependent (eager use inside the group)
    const latent = findingsOfKind(r, 'latent-cycle');
    expect(latent).toHaveLength(1);
    expect(cycleFiles(latent[0]!).sort()).toEqual(['app/base.component.ts', 'app/user.component.ts']);
  });
});

describe('fixture 02-barrels', () => {
  it('pinpoints the eager use behind the barrel and verifies the direct-import fix', async () => {
    const r = await analyzeFixture('02-barrels');
    const crit = findingsOfKind(r, 'runtime-break');
    expect(crit).toHaveLength(1);
    const f = crit[0]!;
    expect(f.failures[0]!.symbol).toBe('UserComponent');
    expect(endsWith(f.failures[0]!.from, 'shared/state.ts')).toBe(true);
    expect(cycleFiles(f)).toEqual(['shared/state.ts', 'user/user.component.ts', 'shared/index.ts']);
    const chain = f.failures[0]!.entries.find((e) => e.kind === 'main')!.chain.map((p) => p.split('/').pop());
    expect(chain).toEqual(['main.ts', 'user.component.ts', 'index.ts', 'state.ts']);
    const direct = f.suggestions.find((s) => s.kind === 'direct-import')!;
    expect(direct.verified).toBe(true);
    expect(direct.details?.join('\n')).toContain("from 'src/shared/base.component.ts'");
    expect(direct.details?.join('\n')).toContain("from 'src/shared/button.component.ts'");
    // moving UserComponent alone is correctly reported as insufficient
    const move = f.suggestions.find((s) => s.kind === 'move-symbol')!;
    expect(move.verified).toBe(false);
    // no move-symbol advice targeted at the barrel itself
    expect(f.suggestions.filter((s) => s.kind === 'move-symbol')).toHaveLength(1);
  });

  it('recognises the barrel group and marks the edge via barrel', async () => {
    const r = await analyzeFixture('02-barrels');
    expect(r.sccs).toHaveLength(1);
    expect(r.sccs[0]!.barrels.map((b) => b.split('/').pop())).toEqual(['index.ts']);
    const crit = findingsOfKind(r, 'runtime-break')[0]!;
    expect(crit.edgeNotes.find((n) => endsWith(n.to, 'index.ts'))!.viaBarrel).toBe(true);
    expect(r.fixPlans[0]!.verified).toBe(true);
    expect(endsWith(r.fixPlans[0]!.cuts[0]!.to, 'shared/index.ts')).toBe(true);
  });

  it('does not report the extends usage as order-dependent because its origin is outside the group', async () => {
    const r = await analyzeFixture('02-barrels');
    expect(findingsOfKind(r, 'latent-cycle')).toHaveLength(0);
    const low = findingsOfKind(r, 'deferred-cycle');
    expect(low).toHaveLength(1);
    expect(low[0]!.suggestions.some((s) => s.kind === 'direct-import' && s.verified)).toBe(true);
    expect(low[0]!.suggestions.some((s) => s.kind === 'move-symbol')).toBe(false);
  });
});

describe('fixture 03-angular-app', () => {
  it('detects mutual standalone component imports as critical with a forwardRef suggestion', async () => {
    const r = await analyzeFixture('03-angular-app');
    const crit = findingsOfKind(r, 'runtime-break');
    const tree = crit.find((f) => f.failures[0]!.symbol === 'TreeComponent')!;
    expect(tree).toBeDefined();
    expect(tree.severity).toBe('critical');
    expect(tree.failures[0]!.usage.contextKind).toBe('decorator');
    expect(tree.failures[0]!.usage.decorator).toBe('Component');
    expect(tree.failures[0]!.usage.property).toBe('imports');
    expect(tree.suggestions[0]!.kind).toBe('forward-ref');
    expect(tree.suggestions[0]!.verified).toBe(true);
    const chain = tree.failures[0]!.entries.find((e) => e.kind === 'main')!.chain.map((p) => p.split('/').pop());
    expect(chain).toEqual(['main.ts', 'app.config.ts', 'app.routes.ts', 'dashboard.component.ts', 'tree.component.ts', 'tree-node.component.ts']);
    // also breaks from the dashboard spec
    expect(tree.failures[0]!.entries.some((e) => e.kind === 'test' && endsWith(e.entry, 'dashboard.component.spec.ts'))).toBe(true);
  });

  it('evaluates lazy route chunks as their own entry and finds the static-field crash', async () => {
    const r = await analyzeFixture('03-angular-app');
    const admin = findingsOfKind(r, 'runtime-break').find((f) => f.failures[0]!.symbol === 'ADMIN_ROUTES')!;
    expect(admin).toBeDefined();
    expect(admin.failures[0]!.usage.contextKind).toBe('static-member');
    expect(admin.failures[0]!.entries[0]!.kind).toBe('lazy');
    expect(endsWith(admin.failures[0]!.entries[0]!.entry, 'admin.routes.ts')).toBe(true);
    expect(admin.suggestions.some((s) => s.kind === 'lazy-route' && s.verified)).toBe(true);
    expect(r.entries.filter((e) => e.kind === 'lazy')).toHaveLength(1);
    expect(r.stats.dynamicEdges).toBe(1);
  });

  it('finds the Angular DI cycle across constructor injection and inject()', async () => {
    const r = await analyzeFixture('03-angular-app');
    const di = findingsOfKind(r, 'di-cycle');
    expect(di).toHaveLength(1);
    expect(di[0]!.severity).toBe('high');
    expect(di[0]!.diCycle!.nodes.map((n) => n.name).sort()).toEqual(['AuthService', 'UserService']);
    expect(di[0]!.diCycle!.certain).toBe(true);
    const vias = di[0]!.diCycle!.edges.map((e) => e.dep.via).sort();
    expect(vias).toEqual(['constructor-param', 'inject-field']);
    expect(di[0]!.suggestions[0]!.kind).toBe('di-restructure');
    expect(r.diCycles).toHaveLength(1);
  });

  it('reports the enum/const pair as order-dependent (medium) with a verified extraction', async () => {
    const r = await analyzeFixture('03-angular-app');
    const latent = findingsOfKind(r, 'latent-cycle');
    expect(latent).toHaveLength(1);
    expect(latent[0]!.severity).toBe('medium');
    expect(cycleFiles(latent[0]!).sort()).toEqual(['models/defaults.ts', 'models/status.enum.ts']);
    expect(latent[0]!.suggestions.some((s) => s.kind === 'move-symbol' && s.verified)).toBe(true);
  });

  it('treats the constructor-typed service import as erased and the inject() side as deferred', async () => {
    const r = await analyzeFixture('03-angular-app');
    const info = findingsOfKind(r, 'type-only-cycle');
    expect(info).toHaveLength(1);
    expect(cycleFiles(info[0]!).sort()).toEqual(['core/auth.service.ts', 'core/user.service.ts']);
    expect(info[0]!.title).toContain('only through type-only imports');
    const auth = [...r.graph.modules.values()].find((m) => endsWith(m.path, 'core/auth.service.ts'))!;
    const userImport = auth.imports.find((i) => i.specifierText === './user.service')!;
    expect(userImport.erased).toBe(true);
    expect(userImport.specifiers[0]!.effectiveTiming).toBe('type');
  });

  it('marks type-only specifiers in symbol lists', async () => {
    const r = await analyzeFixture('03-angular-app');
    const tree = findingsOfKind(r, 'runtime-break').find((f) => f.failures[0]!.symbol === 'TreeComponent')!;
    const note = tree.edgeNotes.find((n) => endsWith(n.from, 'tree-node.component.ts'))!;
    expect(note.symbols).toEqual(['TreeComponent', 'TreeNode (type)']);
  });

  it('orders findings by severity and assigns sequential ids', async () => {
    const r = await analyzeFixture('03-angular-app');
    expect(r.findings.map((f) => f.severity)).toEqual(['critical', 'critical', 'high', 'medium', 'info']);
    expect(r.findings.map((f) => f.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
  });
});

describe('fixture 04-decorator-metadata', () => {
  it('treats constructor parameter types as eager values when emitDecoratorMetadata is on', async () => {
    const r = await analyzeFixture('04-decorator-metadata');
    expect(r.options.emitDecoratorMetadata).toBe(true);
    const crit = findingsOfKind(r, 'runtime-break');
    expect(crit).toHaveLength(1);
    expect(crit[0]!.failures[0]!.usage.contextKind).toBe('decorator-metadata');
    expect(crit[0]!.failures[0]!.symbol).toBe('AService');
    expect(crit[0]!.suggestions[0]!.kind).toBe('decorator-metadata');
    expect(crit[0]!.suggestions[0]!.verified).toBe(true);
  });

  it('downgrades interface parameter types to type-only (no metadata emitted)', async () => {
    const r = await analyzeFixture('04-decorator-metadata');
    const a = [...r.graph.modules.values()].find((m) => endsWith(m.path, 'a.service.ts'))!;
    const cfg = a.imports.find((i) => i.specifierText === './config')!;
    expect(cfg.erased).toBe(true);
    expect(cfg.specifiers[0]!.effectiveTiming).toBe('type');
    expect(r.stats.erasedEdges).toBe(1);
  });

  it('still reports the DI cycle', async () => {
    const r = await analyzeFixture('04-decorator-metadata');
    expect(findingsOfKind(r, 'di-cycle')).toHaveLength(1);
  });

  it('can be overridden to ignore metadata semantics', async () => {
    const r = await analyzeFixture('04-decorator-metadata', { emitDecoratorMetadata: false });
    expect(findingsOfKind(r, 'runtime-break')).toHaveLength(0);
    expect(findingsOfKind(r, 'type-only-cycle')).toHaveLength(1);
  });
});

describe('general behaviour', () => {
  it('reports an empty project without findings', async () => {
    const r = await analyzeFixture('04-decorator-metadata', { include: ['src/config.ts'], noTestEntries: true });
    expect(r.findings).toHaveLength(0);
    expect(r.stats.files).toBe(1);
  });

  it('exposes phase timings and stats', async () => {
    const r = await analyzeFixture('03-angular-app');
    expect(r.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(r.stats.phases)).toEqual(expect.arrayContaining(['discover', 'parse', 'graph', 'cycles', 'evaluate', 'di', 'findings']));
    expect(r.stats.files).toBe(17);
    expect(r.stats.externals).toBeGreaterThan(0);
    expect(r.stats.unresolved).toBe(0);
  });
});
