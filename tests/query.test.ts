/**
 * Query layer: the small answers behind the CLI subcommands and the MCP tools.
 */
import { describe, expect, it } from 'bun:test';
import { diffResults, diffSnapshots, explainFinding, fixPlanFor, listFindingLines, listFindings, QueryError, resolveFile, simulate, snapshotFromReport, snapshotOf, summarize, toJsonReport, toText } from '../src/index.js';
import { analyzeFixture } from './helpers.js';
import { analyzeProject } from './tmp-project.js';

const shop = () => analyzeFixture('07-shop-app');

/** The fix-order example as an in-memory project (see fixtures/06-fix-order). */
const CASCADE = {
  'src/main.ts': `import { Feature } from './feature';\nimport { Panel } from './panel';\nexport const all = [Feature, Panel];\n`,
  'src/feature.ts': `import { helper } from './shared';\nexport class Feature { run() { return helper(); } }\n`,
  'src/panel.ts': `import { Widget } from './shared';\nexport class Panel { static kind = 'panel'; w = new Widget(); }\n`,
  'src/shared/index.ts': `export * from './helper';\nexport * from './widget';\nexport * from './theme';\n`,
  'src/shared/helper.ts': `export const helper = () => 1;\n`,
  'src/shared/widget.ts': `import { Feature } from '../feature';\nimport { THEME } from './theme';\nexport class Widget { static owner = Feature.name; static theme = THEME; }\n`,
  'src/shared/theme.ts': `import { Panel } from '../panel';\nexport const THEME = { dark: true };\nexport const PANEL_KIND = Panel.kind;\n`,
};
const DIRECT_IMPORT = { 'src/feature.ts': `import { helper } from './shared/helper';\nexport class Feature { run() { return helper(); } }\n` };

describe('summary', () => {
  it('fits the whole picture into a few lines per group', async () => {
    const s = summarize(await shop());
    expect(s.counts).toEqual({ critical: 4, high: 2, medium: 1, low: 6, info: 3 });
    expect(s.verdict).toBe('4 load-time crashes when the app or a lazy route loads, 2 more problems in specs or Angular DI');
    expect(s.entryPoints).toEqual({ app: ['src/main.ts'], lazyChunks: 6, specs: 3 });
    expect(s.groups.map((g) => g.worst)).toEqual(['critical', 'critical', 'critical', 'critical', 'high', 'medium', 'low', 'info', 'info']);
    const header = s.groups.find((g) => g.findings.some((f) => f.includes('HEADER_HEIGHT')))!;
    expect(header.findings[0]).toBe('C1 critical: Load-time crash: HEADER_HEIGHT read before initialisation in src/app/core/layout-metrics.ts at src/app/core/layout-metrics.ts:4 (on app start)');
    expect(header.fix).toBe('verified, 1 import to change: src/app/core/layout-metrics.ts → src/app/layout/header.component.ts');
    expect(s.diCycles).toHaveLength(1);
    // small enough to hand to an agent as the first answer
    expect(toText(s).length).toBeLessThan(6000);
  });
});

describe('list', () => {
  it('filters by severity, kind, file and group', async () => {
    const r = await shop();
    expect(listFindings(r).total).toBe(16);
    expect(listFindings(r, { minSeverity: 'high' }).findings.map((f) => f.severity)).toEqual(['critical', 'critical', 'critical', 'critical', 'high', 'high']);
    expect(listFindings(r, { severity: 'medium' }).findings.map((f) => f.kind)).toEqual(['possible-break']);
    expect(listFindings(r, { kind: 'di-cycle' }).total).toBe(1);
    const checkout = listFindings(r, { file: 'features/checkout' });
    expect(checkout.findings.map((f) => f.kind).sort()).toEqual(['latent-cycle', 'test-break']);
    expect(listFindings(r, { group: checkout.findings[0]!.group }).total).toBe(2);
    expect(listFindings(r, { limit: 3 })).toMatchObject({ total: 16, shown: 3 });
    expect(listFindingLines(r, { kind: 'di-cycle' }).findings[0]).toMatch(/^C\d+ high \[di-cycle, group \d+\]: Angular DI cycle \(NG0200\): CartService → CouponService → CartService$/);
  });
});

describe('explain', () => {
  it('gives the failing read, the load order and the code behind every import of the cycle', async () => {
    const r = await shop();
    const wizard = r.findings.find((f) => f.kind === 'test-break')!;
    const d = explainFinding(r, wizard.id);
    expect(d.meaning).toBe('crashes when a spec file loads');
    expect(d.reads).toEqual([
      {
        key: 'src/app/features/checkout/shipping-options.component.ts|PaymentFormComponent|PaymentFormComponent|src/app/features/checkout/payment-form.component.ts',
        at: 'src/app/features/checkout/shipping-options.component.ts:14:26',
        code: 'static readonly next = PaymentFormComponent;',
        reads: 'PaymentFormComponent',
        declaredIn: 'class in src/app/features/checkout/payment-form.component.ts',
        error: "ReferenceError: Cannot access 'PaymentFormComponent' before initialization",
      },
    ]);
    expect(d.loadOrder!.kind).toBe('test');
    expect(d.loadOrder!.files).toHaveLength(9);
    expect(d.loadOrder!.files[0]).toBe('src/app/features/checkout/payment-form.component.spec.ts');
    expect(d.failsUnder).toEqual({ app: [], specs: 1, specExamples: ['src/app/features/checkout/payment-form.component.spec.ts'] });
    expect(d.cycle!.files).toHaveLength(8);
    expect(d.cycle!.imports[0]).toEqual({
      from: 'src/app/features/checkout/shipping-options.component.ts',
      to: 'src/app/features/checkout/payment-form.component.ts',
      use: 'read at load time',
      code: ["L4: import { PaymentFormComponent } from './payment-form.component';", 'L14: static readonly next = PaymentFormComponent;  // load time: static field `ShippingOptionsComponent.next` initializer (runs at class definition)'],
    });
    expect(d.groupFix).toContain('verified, 1 import to change');
    // the same finding by its stable key
    expect(explainFinding(r, wizard.key).id).toBe(wizard.id);
  });

  it('explains an order-dependent finding by what would have to be imported first, and a DI cycle by its injections', async () => {
    const r = await shop();
    const latent = explainFinding(r, r.findings.find((f) => f.kind === 'latent-cycle' && f.failures.length === 6)!.id);
    expect(latent.at).toBeUndefined();
    expect(latent.reads.every((x) => x.failsIfImportedFirst !== undefined)).toBe(true);
    expect(latent.enteredThrough).toEqual([
      { file: 'src/app/features/checkout/checkout-page.component.ts', by: '1 lazy chunk' },
      { file: 'src/app/features/checkout/payment-form.component.ts', by: '1 spec' },
    ]);
    expect(latent.loadOrder).toBeUndefined();
    const di = explainFinding(r, r.findings.find((f) => f.kind === 'di-cycle')!.id);
    expect(di.di!.services.sort()).toEqual(['CartService', 'CouponService']);
    expect(di.di!.needs.find((n) => n.from === 'CouponService')).toEqual({ from: 'CouponService', to: 'CartService', at: 'src/app/features/cart/coupon.service.ts:7', code: 'constructor(private readonly cart: CartService) {}', how: 'constructor-param' });
    expect(di.groupFix).toBeUndefined();
  });

  it('rejects an unknown id with a message that says what exists', async () => {
    const r = await shop();
    expect(() => explainFinding(r, 'C99')).toThrow(QueryError);
    expect(() => explainFinding(r, 'C99')).toThrow('Ids of this run are C1 … C16');
  });
});

describe('fix plan', () => {
  it('lists the steps with what a replay shows after each one', async () => {
    const r = await shop();
    const crash = r.findings.find((f) => f.failures.some((fp) => fp.from.endsWith('recent-orders.component.ts')))!;
    const plan = fixPlanFor(r, crash.id);
    expect(plan.verified).toBe(true);
    expect(plan.steps.map((s) => s.change)).toEqual(['import directly', 'break import']);
    expect(plan.steps[0]!.importFrom).toEqual(['src/app/shared/util/format.ts']);
    expect(plan.steps[0]!.then!.nextCrashes).toEqual([
      { at: 'src/app/shared/widgets/table-presets.ts:4', reads: 'OrderRowComponent', when: 'lazy chunk src/app/features/orders/orders.routes.ts loads', known: expect.stringContaining('today only order-dependent') },
    ]);
    expect(plan.steps[1]!.then).toEqual({ resolved: [crash.id], nextCrashes: [], stillFailing: [] });
    expect(plan.replay).toBe('replayed 1 entry point with every step done: no crash left in this group, none surfaces elsewhere');
    // by group number, as a number or as text
    expect(fixPlanFor(r, plan.group).steps).toHaveLength(2);
    expect(fixPlanFor(r, String(plan.group)).group).toBe(plan.group);
  });

  it('says so when there is no plan', async () => {
    const r = await shop();
    expect(() => fixPlanFor(r, 999)).toThrow('No cyclic group #999');
    expect(() => fixPlanFor(r, r.findings.find((f) => f.kind === 'type-only-cycle')!.id)).toThrow('does not belong to an import cycle group');
  });
});

describe('simulate', () => {
  it('shows what a change would resolve and what it would break – without editing', async () => {
    const r = await shop();
    // step one of the orders fix alone: nothing resolved yet, and a read that is fine today fails
    const direct = simulate(r, [{ from: 'order-list.component.ts', to: 'src/app/shared/index.ts', action: 'direct' }]);
    expect(direct.simulated).toBe(true);
    expect(direct.resolved).toEqual([]);
    expect(direct.redirected).toEqual([{ from: 'src/app/features/orders/order-list.component.ts', barrel: 'src/app/shared/index.ts', importFrom: ['src/app/shared/util/format.ts'] }]);
    expect(direct.newlyFailing.map((x) => `${x.at} ${x.reads}`)).toEqual(['src/app/shared/widgets/table-presets.ts:4 OrderRowComponent']);
    // only the touched group is reported as still failing, not every crash of the project
    expect(direct.stillFailing.map((x) => x.at)).toEqual(['src/app/shared/widgets/recent-orders.component.ts:8']);
    expect(direct.verdict).toBe('resolves 0 of 6 crash findings, but 1 read that is fine today would fail');
    // both steps: clean
    const both = simulate(r, [
      { from: 'order-list.component.ts', to: 'src/app/shared/index.ts', action: 'direct' },
      { from: 'order-row.component.ts', to: 'src/app/shared/index.ts', action: 'remove' },
    ]);
    expect(both.resolved).toHaveLength(1);
    expect([both.stillFailing, both.newlyFailing]).toEqual([[], []]);
  });

  it('models a deferred read (forwardRef): the import stays, the crash goes', async () => {
    const r = await shop();
    const sim = simulate(r, [{ from: 'category-node.component.ts', to: 'category-tree.component.ts', action: 'defer' }]);
    expect(sim.resolved).toHaveLength(1);
    expect(sim.resolved[0]).toContain('CategoryTreeComponent');
    expect(sim.newlyFailing).toEqual([]);
    // deferring the other direction does not help: that read is not the failing one
    const wrong = simulate(r, [{ from: 'category-tree.component.ts', to: 'category-node.component.ts', action: 'defer' }]);
    expect(wrong.resolved).toEqual([]);
    expect(wrong.stillFailing).toHaveLength(1);
  });

  it('explains requests it cannot use', async () => {
    const r = await shop();
    expect(() => simulate(r, [{ from: 'nope.ts', to: 'header.component.ts', action: 'remove' }])).toThrow('No analysed file matches "nope.ts"');
    expect(() => simulate(r, [{ from: 'index.ts', to: 'header.component.ts', action: 'remove' }])).toThrow('matches 2 files');
    const none = simulate(r, [{ from: 'footer.component.ts', to: 'header.component.ts', action: 'remove' }]);
    expect(none.simulated).toBe(false);
    expect(none.notes![0]).toContain('has no runtime import of');
    expect(resolveFile(r, 'src/app/layout/header.component.ts').endsWith('/src/app/layout/header.component.ts')).toBe(true);
  });
});

describe('diff', () => {
  it('reports what a real edit resolved and what it surfaced', async () => {
    const before = await analyzeProject(CASCADE);
    const after = await analyzeProject({ ...CASCADE, ...DIRECT_IMPORT });
    const d = diffResults(before, after);
    expect(d.before).toMatchObject({ critical: 1, low: 1 });
    expect(d.resolved).toEqual([{ key: 'read:src/shared/widget.ts>src/feature.ts', severity: 'critical', what: expect.stringContaining('`Feature` read before initialisation') }]);
    expect(d.introduced.map((f) => [f.key, f.severity])).toEqual([['read:src/shared/theme.ts>src/panel.ts', 'critical']]);
    // the order-dependent finding of the group lost the read that became real; the group itself
    // shrank (feature.ts left it), yet it is recognised as the same finding
    expect(d.changed.map((c) => [c.key, c.readsGone, c.readsNew])).toEqual([['order:src/panel.ts', 1, undefined]]);
    expect(d.verdict).toBe('1 finding resolved, 1 new (1 of them a crash or possible crash), 1 changed');
    // … which is exactly what the simulation of that edit predicted
    const sim = simulate(before, [{ from: 'src/feature.ts', to: 'src/shared/index.ts', action: 'direct' }]);
    expect(sim.newlyFailing.map((x) => x.at)).toEqual(['src/shared/theme.ts:3']);
  });

  it('keys ignore line numbers: an unrelated edit above the read changes nothing', async () => {
    const before = await analyzeProject(CASCADE);
    const shifted = await analyzeProject({ ...CASCADE, 'src/shared/widget.ts': `// a comment\n\n${CASCADE['src/shared/widget.ts']}` });
    expect(shifted.findings[0]!.failures[0]!.usage.line).toBe(before.findings[0]!.failures[0]!.usage.line + 2);
    expect(diffResults(before, shifted)).toMatchObject({ resolved: [], introduced: [], changed: [], unchanged: 2, verdict: 'no change' });
  });

  it('compares against a saved JSON report', async () => {
    const before = await analyzeProject(CASCADE);
    const saved = JSON.parse(JSON.stringify(toJsonReport(before, '1.0.0')));
    const after = await analyzeProject({ ...CASCADE, ...DIRECT_IMPORT });
    expect(diffSnapshots(snapshotFromReport(saved), snapshotOf(after))).toEqual(diffResults(before, after));
    // a report written before findings had keys cannot be compared
    for (const f of saved.findings) delete f.key;
    expect(() => snapshotFromReport(saved)).toThrow('older version');
  });
});

describe('text rendering', () => {
  it('prints views as indented key/value text', () => {
    expect(toText({ a: 1, list: ['x', 'y'], empty: [], nested: { b: 'two', skip: undefined }, rows: [{ id: 'C1', at: 'f.ts:1' }, { id: 'C2' }] })).toBe(
      ['a: 1', 'list: x, y', 'empty: none', 'nested:', '  b: two', 'rows:', '  - id: C1', '    at: f.ts:1', '  - id: C2'].join('\n'),
    );
  });
});
