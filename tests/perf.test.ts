import { beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { analyze } from '../src/index.js';
import type { AnalysisResult, Finding } from '../src/types.js';
import { fixturePath, projectRoot } from './helpers.js';

interface Planted {
  fileCount: number;
  cycles: Record<string, { kind: string; severity: string; files?: string[]; members?: string[]; symbol?: string; from?: string; services?: string[] }>;
}

const root = fixturePath('05-large-generated');
const TIME_BUDGET_MS = 20_000;

let result: AnalysisResult;
let planted: Planted;
let elapsed = 0;

const ends = (p: string, rel: string): boolean => p.endsWith(`/${rel}`);
const cycleHas = (f: Finding, rel: string): boolean => Boolean(f.cycle?.nodes.some((n) => ends(n, rel)));

beforeAll(async () => {
  const main = path.join(root, 'src', 'main.ts');
  const manifest = path.join(root, 'planted.json');
  if (!fs.existsSync(main) || !fs.existsSync(manifest)) {
    const proc = Bun.spawnSync(['bun', 'run', 'scripts/generate-large-fixture.ts'], { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode !== 0) throw new Error(`generator failed: ${proc.stderr.toString()}`);
  }
  planted = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Planted;
  const started = performance.now();
  result = await analyze({ root, entries: ['src/main.ts'] });
  elapsed = performance.now() - started;
  console.log(`[perf] ${result.stats.files} files, ${result.stats.loc} lines, ${result.options.testEntries.length} test entries analysed in ${Math.round(elapsed)} ms`, result.stats.phases);
  // Generous hook timeout: the first run may have to generate the fixture and read ~3k files from a cold disk.
}, 180_000);

describe('large generated project (fixtures/05-large-generated)', () => {
  it('analyses ~3000 files within the time budget', () => {
    expect(result.stats.files).toBeGreaterThanOrEqual(2500);
    expect(result.stats.files).toBe(planted.fileCount);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
    expect(result.stats.unresolved).toBe(0);
  });

  it('finds the planted critical `extends` cycle through a barrel', () => {
    const p = planted.cycles['critical-extends']!;
    const f = result.findings.find((x) => x.kind === 'runtime-break' && x.failures[0]?.symbol === p.symbol)!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('critical');
    expect(ends(f.failures[0]!.from, p.from!)).toBe(true);
    expect(f.failures[0]!.usage.contextKind).toBe('extends');
    for (const file of p.files!) expect(cycleHas(f, file)).toBe(true);
    expect(f.failures[0]!.entries.some((e) => e.kind === 'main')).toBe(true);
    // importing list-item directly would keep the cycle, so the plan cuts base-list's deferred import instead
    const plan = result.fixPlans.find((p) => p.sccId === f.sccId)!;
    expect(plan.cuts.map((c) => c.action)).toEqual(['move-code']);
    expect(plan.cuts[0]!.from.endsWith('/shared/base/base-list.component.ts')).toBe(true);
  });

  it('finds the planted mutual standalone component imports', () => {
    const p = planted.cycles['critical-decorator']!;
    const f = result.findings.find((x) => x.kind === 'runtime-break' && x.failures[0]?.symbol === p.symbol)!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('critical');
    expect(f.failures[0]!.usage.contextKind).toBe('decorator');
    expect(f.suggestions[0]!.kind).toBe('forward-ref');
    for (const file of p.files!) expect(cycleHas(f, file)).toBe(true);
  });

  it('finds the planted DI cycle', () => {
    const p = planted.cycles['di-cycle']!;
    const f = result.findings.find((x) => x.kind === 'di-cycle')!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('high');
    expect(f.diCycle!.nodes.map((n) => n.name).sort()).toEqual([...p.services!].sort());
    expect(result.diCycles).toHaveLength(1);
  });

  it('finds the planted order-dependent enum/const pair as low', () => {
    const p = planted.cycles['latent']!;
    const f = result.findings.find((x) => x.kind === 'latent-cycle' && cycleHas(x, p.files![0]!))!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('low');
    for (const file of p.files!) expect(cycleHas(f, file)).toBe(true);
    expect(f.suggestions.some((s) => s.kind === 'move-symbol' && s.verified)).toBe(true);
  });

  it('finds the planted deferred-only service pair as info', () => {
    const p = planted.cycles['deferred']!;
    const f = result.findings.find((x) => x.kind === 'deferred-cycle' && cycleHas(x, p.files![0]!))!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('info');
    for (const file of p.files!) expect(cycleHas(f, file)).toBe(true);
  });

  it('finds the planted type-only model pair as info', () => {
    const p = planted.cycles['type-only']!;
    const f = result.findings.find((x) => x.kind === 'type-only-cycle' && cycleHas(x, p.files![0]!))!;
    expect(f).toBeDefined();
    expect(f.severity).toBe('info');
    for (const file of p.files!) expect(cycleHas(f, file)).toBe(true);
  });

  it('reports the barrel-induced group with a verified fix plan', () => {
    const big = result.sccs.find((s) => s.nodes.length >= 10)!;
    expect(big).toBeDefined();
    expect(big.barrels.length).toBeGreaterThan(0);
    const plan = result.fixPlans.find((p) => p.sccId === big.id)!;
    expect(plan.verified).toBe(true);
    expect(plan.cuts.length).toBeLessThanOrEqual(3);
    // the cut is the barrel-side edge, i.e. the cheapest fix
    // the single cut is the shared util importing the feature barrel – the planted root cause
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0]!.from.endsWith('/shared/utils/registry.util.ts')).toBe(true);
    expect(result.graph.modules.get(plan.cuts[0]!.to)?.isBarrel).toBe(true);
  });

  it('keeps the rest of the project cycle-free', () => {
    // every cyclic group must contain a planted file
    const plantedFiles = [...new Set(Object.values(planted.cycles).flatMap((c) => c.files ?? c.members ?? []))];
    for (const scc of result.sccs) {
      const touches = scc.nodes.some((n) => plantedFiles.some((p) => ends(n, p)));
      if (!touches) throw new Error(`unexpected cyclic group: ${scc.nodes.join(', ')}`);
    }
    expect(result.sccs.length).toBeLessThanOrEqual(Object.keys(planted.cycles).length);
  });

  it('evaluates every lazy chunk and every spec entry', () => {
    expect(result.entries.filter((e) => e.kind === 'lazy').length).toBeGreaterThanOrEqual(5);
    expect(result.entries.filter((e) => e.kind === 'test').length).toBe(result.options.testEntries.length);
    expect(result.options.testEntries.length).toBeGreaterThan(300);
  });
});
