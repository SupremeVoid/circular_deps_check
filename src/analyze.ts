import fs from 'node:fs';
import type {
  AnalysisResult,
  AnalysisStats,
  Cycle,
  DiCycle,
  EdgeNote,
  EntryEvaluation,
  FailurePoint,
  Finding,
  FixPlan,
  GraphEdge,
  ModuleGraph,
  ModuleInfo,
  Scc,
  Severity,
  Usage,
} from './types.js';
import { resolveConfig, type CircdepsOptions, type ResolvedConfig } from './config.js';
import { discoverFiles, resolveEntries } from './discover.js';
import { ModuleResolver } from './resolver.js';
import { parseModule } from './parser.js';
import { allStaticEdges, buildGraph, edgeSymbols, resolveExport, runtimeEdges, type ResolvedExport } from './graph.js';
import {
  adjacencyFrom,
  enumerateCycles,
  shortestCycleThroughEdge,
  stronglyConnectedComponents,
  subgraph,
  type Adjacency,
} from './cycles.js';
import { evaluateAll } from './evaluate.js';
import { buildDiGraph, findDiCycles } from './di.js';
import { suggestForCycle, suggestForDiCycle, type SuggestContext } from './suggest.js';
import { relativeTo } from './util/paths.js';

export interface AnalyzeProgress {
  (phase: string, detail?: string): void;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export const severityRank = (s: Severity): number => SEVERITY_RANK[s];

export const analyze = async (opts: CircdepsOptions = {}, progress?: AnalyzeProgress): Promise<AnalysisResult> => {
  const started = performance.now();
  const phases: Record<string, number> = {};
  const time = <T>(name: string, fn: () => T): T => {
    const t = performance.now();
    progress?.(name);
    const r = fn();
    phases[name] = Math.round(performance.now() - t);
    return r;
  };

  const config = resolveConfig(opts);
  const root = config.root;

  const t0 = performance.now();
  progress?.('discover');
  const files = await discoverFiles(root, config.include, config.exclude);
  phases['discover'] = Math.round(performance.now() - t0);
  const fileSet = new Set(files);

  const resolver = new ModuleResolver(config.compilerOptions, fileSet, root);

  const modules = time('parse', () => {
    const map = new Map<string, ModuleInfo>();
    const ctx = {
      root,
      resolver,
      emitDecoratorMetadata: config.emitDecoratorMetadata,
      verbatimModuleSyntax: config.verbatimModuleSyntax,
      angular: config.angular,
    };
    for (const file of files) {
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch (err) {
        continue;
      }
      map.set(file, parseModule(file, source, ctx));
    }
    return map;
  });

  const graph = time('graph', () => buildGraph(root, modules));

  const t1 = performance.now();
  progress?.('entries');
  const mainEntries = await resolveEntries(root, config.entries, fileSet);
  const mainSet = new Set(mainEntries);
  const testEntries = (await resolveEntries(root, config.testEntries, fileSet)).filter((e) => !mainSet.has(e));
  phases['entries'] = Math.round(performance.now() - t1);

  const runtimeAdj = adjacencyFrom(runtimeEdges(graph), modules.keys());
  const sccs = time('cycles', () => computeSccs(graph, runtimeAdj, config));
  const sccByNode = new Map<string, Scc>();
  for (const s of sccs) for (const n of s.nodes) sccByNode.set(n, s);

  const typeOnlySccs = time('type-cycles', () => {
    const staticAdj = adjacencyFrom(allStaticEdges(graph), modules.keys());
    const comps = stronglyConnectedComponents(staticAdj);
    const out: Scc[] = [];
    let id = 1000;
    for (const comp of comps) {
      if (comp.some((n) => sccByNode.has(n))) continue;
      const sub = subgraph(staticAdj, comp);
      const { cycles, truncated } = enumerateCycles(sub, { maxCycles: 20, maxLength: config.maxCycleLength });
      out.push({
        id: id++,
        nodes: comp,
        edgeCount: [...sub.values()].reduce((a, s) => a + s.size, 0),
        cycles: cycles.map((c) => materializeCycle(graph, c)),
        truncated,
        barrels: comp.filter((n) => modules.get(n)?.isBarrel),
      });
    }
    return out;
  });

  const entries = time('evaluate', () => evaluateAll(graph, mainEntries, testEntries));

  const diCycles = time('di', () => (config.angular ? findDiCycles(buildDiGraph(graph)) : []));

  const suggestCtx: SuggestContext = { graph, adj: runtimeAdj, exportCache: new Map() };

  const findings = time('findings', () => composeFindings(graph, runtimeAdj, sccs, sccByNode, typeOnlySccs, entries, diCycles, suggestCtx, config));

  const fixPlans = time('fix-plans', () => sccs.map((s) => planFixes(graph, runtimeAdj, s)));

  const stats = computeStats(graph, sccs, typeOnlySccs, diCycles, entries, findings, started, phases);

  return {
    root,
    generatedAt: new Date().toISOString(),
    options: {
      tsconfig: config.tsconfigPath ? relativeTo(root, config.tsconfigPath) : null,
      include: config.include,
      exclude: config.exclude,
      entries: mainEntries.map((e) => relativeTo(root, e)),
      testEntries: testEntries.map((e) => relativeTo(root, e)),
      emitDecoratorMetadata: config.emitDecoratorMetadata,
      verbatimModuleSyntax: config.verbatimModuleSyntax,
    },
    stats,
    findings,
    sccs,
    typeOnlySccs,
    entries,
    diCycles,
    graph,
    fixPlans,
  };
};

// -------------------------------------------------------------------------------------------------

const materializeCycle = (graph: ModuleGraph, nodes: string[]): Cycle => {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const from = nodes[i]!;
    const to = nodes[(i + 1) % nodes.length]!;
    const e = graph.out.get(from)?.get(to);
    if (e) edges.push(e);
  }
  return { nodes, edges };
};

const computeSccs = (graph: ModuleGraph, adj: Adjacency, config: ResolvedConfig): Scc[] => {
  const comps = stronglyConnectedComponents(adj);
  comps.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  return comps.map((comp, i) => {
    const sub = subgraph(adj, comp);
    const { cycles, truncated } = enumerateCycles(sub, { maxCycles: config.maxCyclesPerScc, maxLength: config.maxCycleLength });
    return {
      id: i + 1,
      nodes: comp,
      edgeCount: [...sub.values()].reduce((a, s) => a + s.size, 0),
      cycles: cycles.map((c) => materializeCycle(graph, c)),
      truncated,
      barrels: comp.filter((n) => graph.modules.get(n)?.isBarrel),
    };
  });
};

const edgeNoteFor = (edge: GraphEdge): EdgeNote => {
  let sample: (Usage & { symbol: string }) | undefined;
  const rank = { type: 0, deferred: 1, eager: 2 };
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      for (const u of s.usages) {
        if (!sample || rank[u.timing] > rank[sample.timing]) sample = { ...u, symbol: s.imported === '*' ? `${s.local}.${u.member ?? '*'}` : s.imported };
      }
    }
  }
  return { from: edge.from, to: edge.to, usage: edge.usage, symbols: edgeSymbols(edge), viaBarrel: edge.viaBarrel, sample };
};

const composeFindings = (
  graph: ModuleGraph,
  adj: Adjacency,
  sccs: Scc[],
  sccByNode: Map<string, Scc>,
  typeOnlySccs: Scc[],
  entries: EntryEvaluation[],
  diCycles: DiCycle[],
  sctx: SuggestContext,
  config: ResolvedConfig,
): Finding[] => {
  const rel = (p: string): string => relativeTo(graph.root, p);
  const findings: Finding[] = [];

  // 1. Load-time failures ------------------------------------------------------------------------
  const failuresByEdge = new Map<string, Map<string, FailurePoint>>();
  for (const ev of entries) {
    for (const b of ev.breakages) {
      for (const f of b.failing) {
        const edgeKey = `${b.from}\0${b.to}`;
        const symbol = f.specifier.imported === '*' ? `${f.specifier.local}.${f.usage.member ?? '*'}` : f.specifier.imported;
        const key = `${symbol}\0${f.usage.line}:${f.usage.column}`;
        let perEdge = failuresByEdge.get(edgeKey);
        if (!perEdge) {
          perEdge = new Map();
          failuresByEdge.set(edgeKey, perEdge);
        }
        let fp = perEdge.get(key);
        if (!fp) {
          fp = { from: b.from, to: b.to, usage: f.usage, symbol, originPath: f.originPath, originKind: f.originKind, state: f.state, entries: [] };
          perEdge.set(key, fp);
        }
        if (!fp.entries.some((e) => e.entry === ev.entry)) fp.entries.push({ entry: ev.entry, kind: ev.kind, chain: b.chain });
      }
    }
  }

  const failingEdgeKeys = new Set(failuresByEdge.keys());
  for (const [edgeKey, perEdge] of failuresByEdge) {
    const [from, to] = edgeKey.split('\0') as [string, string];
    const failures = [...perEdge.values()].sort((a, b) => a.usage.line - b.usage.line);
    const scc = sccByNode.get(from);
    const cycNodes = shortestCycleThroughEdge(adj, from, to) ?? [from, to];
    const cycle = materializeCycle(graph, cycNodes);
    const breaksInApp = failures.some((f) => f.entries.some((e) => e.kind !== 'test'));
    const first = failures[0]!;
    const symbols = [...new Set(failures.map((f) => f.symbol))];
    const errorText = first.state === 'tdz'
      ? `ReferenceError: Cannot access '${first.symbol}' before initialization`
      : `TypeError: '${first.symbol}' is undefined`;
    findings.push({
      id: '',
      severity: breaksInApp ? 'critical' : 'high',
      kind: breaksInApp ? 'runtime-break' : 'test-break',
      title: breaksInApp
        ? `Load-time crash: \`${symbols.join('`, `')}\` used before initialisation in \`${rel(from)}\``
        : `Crashes when loaded from tests: \`${symbols.join('`, `')}\` used before initialisation in \`${rel(from)}\``,
      summary: `${rel(from)}:${first.usage.line} touches \`${first.symbol}\` (${first.originKind} from \`${rel(first.originPath ?? to)}\`) while that module is still initialising → ${errorText}.`,
      sccId: scc?.id ?? 0,
      cycle,
      failures,
      suggestions: suggestForCycle(sctx, cycle, failures),
      edgeNotes: cycle.edges.map(edgeNoteFor),
    });
  }

  // 2. DI cycles ---------------------------------------------------------------------------------
  for (const dc of diCycles) {
    const names = dc.nodes.map((n) => n.name);
    const firstPath = dc.nodes[0]?.path;
    findings.push({
      id: '',
      severity: dc.certain ? 'high' : 'medium',
      kind: 'di-cycle',
      title: `Angular DI cycle (NG0200): ${names.join(' → ')} → ${names[0]}`,
      summary: dc.certain
        ? `Each of these injectables needs the next one during construction; Angular throws "NG0200: Circular dependency in DI detected" when the first one is instantiated.`
        : `Constructor dependencies form a cycle; one edge uses @SkipSelf/@Host so it may resolve from a parent injector – verify manually.`,
      sccId: firstPath ? (sccByNode.get(firstPath)?.id ?? 0) : 0,
      diCycle: dc,
      failures: [],
      suggestions: suggestForDiCycle(names),
      edgeNotes: [],
    });
  }

  // 3. Remaining cycles in runtime SCCs ----------------------------------------------------------
  for (const scc of sccs) {
    let latent = 0;
    let deferred = 0;
    let skippedLatent = 0;
    let skippedDeferred = 0;
    for (const cycle of scc.cycles) {
      if (cycle.edges.some((e) => failingEdgeKeys.has(`${e.from}\0${e.to}`))) continue;
      // An eager edge can only break if the eagerly used binding is declared inside this group
      // (only then can its module still be initialising when the importer runs) and is not a
      // hoisted function.
      const eagerEdges = cycle.edges.filter((e) => e.usage === 'eager' && eagerUsageInsideGroup(graph, e, scc, sctx.exportCache));
      if (eagerEdges.length > 0) {
        if (latent >= 8) {
          skippedLatent++;
          continue;
        }
        latent++;
        const e = eagerEdges[0]!;
        const note = edgeNoteFor(e);
        const sym = note.sample?.symbol ?? note.symbols[0] ?? '?';
        findings.push({
          id: '',
          severity: 'medium',
          kind: 'latent-cycle',
          title: `Order-dependent cycle: \`${rel(e.from)}\` uses \`${sym}\` from \`${rel(e.to)}\` at load time`,
          summary: `Works with the current entry points only because \`${rel(e.from)}\` happens to be evaluated after \`${rel(e.to)}\`. Any import that pulls in \`${rel(e.to)}\` first (a spec, a new feature, a barrel reorder) turns this into "${'Cannot access'} '${sym}' before initialization".`,
          sccId: scc.id,
          cycle,
          failures: [],
          suggestions: suggestForCycle(sctx, cycle, [], new Set(eagerEdges.map((x) => `${x.from}\0${x.to}`))),
          edgeNotes: cycle.edges.map(edgeNoteFor),
        });
      } else {
        if (deferred >= 3) {
          skippedDeferred++;
          continue;
        }
        deferred++;
        const anyBinding = cycle.edges.some((e) => e.usage === 'deferred' || e.usage === 'eager');
        const hoistedOnly = cycle.edges.some((e) => e.usage === 'eager');
        findings.push({
          id: '',
          severity: 'low',
          kind: 'deferred-cycle',
          title: hoistedOnly
            ? `Cycle whose eager usages cannot break (hoisted functions / bindings from outside the group): ${cycle.nodes.map(rel).join(' → ')}`
            : anyBinding
              ? `Cycle with deferred usage only: ${cycle.nodes.map(rel).join(' → ')}`
              : `Cycle without binding usage (re-exports/side effects): ${cycle.nodes.map(rel).join(' → ')}`,
          summary: hoistedOnly
            ? 'Bindings used at load time are either function declarations (hoisted, always initialised) or declared in files outside this cyclic group, so the load order cannot break it. Still worth untangling: it hides real cycles and blocks tree-shaking.'
            : anyBinding
              ? 'Imported bindings are only touched inside functions, methods or instance fields, so module loading succeeds. Fragile: the first top-level use will crash.'
              : 'Modules import each other only through barrels/side-effect imports. Harmless at runtime but it inflates the load graph and hides real cycles.',
          sccId: scc.id,
          cycle,
          failures: [],
          suggestions: suggestForCycle(sctx, cycle, []),
          edgeNotes: cycle.edges.map(edgeNoteFor),
        });
      }
    }
    if (skippedLatent > 0 || skippedDeferred > 0) {
      const last = findings[findings.length - 1];
      if (last && last.sccId === scc.id) {
        last.summary += ` (${skippedLatent + skippedDeferred} more cycles in group #${scc.id} not listed individually – see the group view.)`;
      }
    }
  }

  // 4. Type-only cycles --------------------------------------------------------------------------
  if (config.reportTypeOnly) {
    for (const scc of typeOnlySccs) {
      const cycle = scc.cycles[0];
      const erasedEdges = cycle ? cycle.edges.filter((e) => !e.runtime) : [];
      const allErased = cycle ? erasedEdges.length === cycle.edges.length : true;
      findings.push({
        id: '',
        severity: 'info',
        kind: 'type-only-cycle',
        title: allErased
          ? `Type-only cycle (erased at compile time): ${scc.nodes.map(rel).join(', ')}`
          : `Cycle only through type-only imports (erased at compile time): ${scc.nodes.map(rel).join(', ')}`,
        summary: allErased
          ? 'These files reference each other only in type positions. TypeScript/esbuild remove these imports, so nothing is evaluated at runtime. No action needed – converting to `import type` changes nothing.'
          : `At runtime only one direction exists: ${erasedEdges.map((e) => `\`${rel(e.from)}\` → \`${rel(e.to)}\``).join(', ')} ${erasedEdges.length === 1 ? 'is' : 'are'} used purely as types and erased by the compiler. No load-time cycle – no action needed.`,
        sccId: scc.id,
        cycle,
        failures: [],
        suggestions: [{ kind: 'no-action', text: 'No runtime impact. Optionally use `import type` for clarity (with `verbatimModuleSyntax` it is mandatory).', verified: true }],
        edgeNotes: cycle ? cycle.edges.map(edgeNoteFor) : [],
      });
    }
  }

  findings.sort((a, b) => {
    const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (d !== 0) return d;
    const ea = a.failures.reduce((n, f) => n + f.entries.length, 0);
    const eb = b.failures.reduce((n, f) => n + f.entries.length, 0);
    if (ea !== eb) return eb - ea;
    const la = a.cycle?.nodes.length ?? a.diCycle?.nodes.length ?? 0;
    const lb = b.cycle?.nodes.length ?? b.diCycle?.nodes.length ?? 0;
    if (la !== lb) return la - lb;
    return a.title.localeCompare(b.title);
  });
  findings.forEach((f, i) => (f.id = `C${i + 1}`));
  return findings;
};

/** True when some eager usage on the edge resolves to a non-hoisted binding declared inside `scc`. */
const eagerUsageInsideGroup = (graph: ModuleGraph, edge: GraphEdge, scc: Scc, cache: Map<string, ResolvedExport | null>): boolean => {
  const members = new Set(scc.nodes);
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      for (const u of s.usages) {
        if (u.timing !== 'eager') continue;
        const name = s.imported === '*' ? u.member : s.imported;
        if (name === undefined) continue;
        const resolved = resolveExport(graph, edge.to, name, cache);
        if (!resolved) return true; // unknown: assume the worst
        if (resolved.record.hoisted || resolved.record.kind === 'function') continue;
        if (resolved.record.kind === 'type' || resolved.record.kind === 'interface') continue;
        if (members.has(resolved.originPath)) return true;
      }
    }
  }
  return false;
};

/** Greedy feedback-arc-set: repeatedly remove the edge that participates in most shortest cycles. */
const planFixes = (graph: ModuleGraph, adj: Adjacency, scc: Scc): FixPlan => {
  const sub = subgraph(adj, scc.nodes);
  const cuts: FixPlan['cuts'] = [];
  const cost = (e: GraphEdge | undefined): number => {
    if (!e) return 5;
    if (e.viaBarrel) return 0.5;
    if (e.usage === 'none' || e.usage === 'type') return 1;
    if (e.usage === 'deferred') return 2;
    return 3;
  };
  for (let iter = 0; iter < 60; iter++) {
    const comps = stronglyConnectedComponents(sub);
    if (comps.length === 0) return { sccId: scc.id, cuts, verified: true };
    const counts = new Map<string, number>();
    for (const comp of comps) {
      const s = subgraph(sub, comp);
      for (const [from, targets] of s) {
        for (const to of targets) {
          const cyc = shortestCycleThroughEdge(s, from, to);
          if (!cyc) continue;
          for (let i = 0; i < cyc.length; i++) {
            const k = `${cyc[i]}\0${cyc[(i + 1) % cyc.length]}`;
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
        }
      }
    }
    let best: { key: string; score: number } | null = null;
    for (const [key, count] of counts) {
      const [from, to] = key.split('\0') as [string, string];
      const e = graph.out.get(from)?.get(to);
      const score = count / (1 + cost(e));
      if (!best || score > best.score) best = { key, score };
    }
    if (!best) break;
    const [from, to] = best.key.split('\0') as [string, string];
    const e = graph.out.get(from)?.get(to);
    sub.get(from)?.delete(to);
    cuts.push({
      from,
      to,
      symbols: e ? edgeSymbols(e) : [],
      usage: e?.usage ?? 'none',
      reason: e?.viaBarrel ? 'barrel import – replace with direct imports' : e?.usage === 'eager' ? 'eager usage – move the symbol or defer the access' : e?.usage === 'deferred' ? 'deferred usage – can be replaced with lazy access / DI' : 'no binding usage – drop the import',
    });
  }
  return { sccId: scc.id, cuts, verified: stronglyConnectedComponents(sub).length === 0 };
};

const computeStats = (
  graph: ModuleGraph,
  sccs: Scc[],
  typeOnlySccs: Scc[],
  diCycles: DiCycle[],
  entries: EntryEvaluation[],
  findings: Finding[],
  started: number,
  phases: Record<string, number>,
): AnalysisStats => {
  let edges = 0;
  let runtime = 0;
  let erased = 0;
  let dynamic = 0;
  for (const m of graph.out.values()) {
    for (const e of m.values()) {
      edges++;
      if (e.runtime) runtime++;
      if (e.dynamicOnly) dynamic++;
      else if (!e.runtime) erased++;
    }
  }
  let loc = 0;
  for (const m of graph.modules.values()) loc += m.loc;
  return {
    files: graph.modules.size,
    loc,
    edges,
    runtimeEdges: runtime,
    erasedEdges: erased,
    dynamicEdges: dynamic,
    externals: graph.externals.size,
    unresolved: graph.unresolved.length,
    sccs: sccs.length,
    cyclicFiles: sccs.reduce((n, s) => n + s.nodes.length, 0),
    cycles: sccs.reduce((n, s) => n + s.cycles.length, 0),
    typeOnlyCycles: typeOnlySccs.length,
    diCycles: diCycles.length,
    entries: entries.length,
    durationMs: Math.round(performance.now() - started),
    phases,
  };
};

export const countBySeverity = (findings: Finding[]): Record<Severity, number> => {
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
};
