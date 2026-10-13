import fs from 'node:fs';
import type {
  AnalysisResult,
  AnalysisStats,
  Cycle,
  DiCycle,
  EdgeNote,
  EntryEvaluation,
  EntryKind,
  FailingUsage,
  FailurePoint,
  Finding,
  FindingKind,
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
  reaches,
  shortestPath,
  stronglyConnectedComponents,
  subgraph,
  type Adjacency,
} from './cycles.js';
import { evaluateAll, evaluateHypothetical } from './evaluate.js';
import { buildDiGraph, findDiCycles } from './di.js';
import { importSpecifier, suggestForCycle, suggestForDiCycle, type SuggestContext } from './suggest.js';
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
      isolatedModules: config.isolatedModules,
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

  const graph = time('graph', () => buildGraph(root, modules, { verbatimModuleSyntax: config.verbatimModuleSyntax }));

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
  // Prove or refute order-dependent crashes: replay each cyclic group with every member imported first.
  const replays = time('replay-groups', () => evaluateHypothetical(graph, sccs.map((s) => s.nodes)));

  const diCycles = time('di', () => (config.angular ? findDiCycles(buildDiGraph(graph)) : []));

  const suggestCtx: SuggestContext = { graph, adj: runtimeAdj, exportCache: new Map() };

  const findings = time('findings', () => composeFindings(graph, runtimeAdj, sccs, sccByNode, typeOnlySccs, [...entries, ...replays], diCycles, suggestCtx, config));

  const fixPlans = time('fix-plans', () => sccs.map((s) => planFixes(graph, runtimeAdj, s, suggestCtx.exportCache)));

  const stats = computeStats(graph, sccs, typeOnlySccs, diCycles, entries, findings, started, phases);
  stats.replayedOrders = replays.length;

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

const symbolOf = (f: FailingUsage): string => (f.specifier.imported === '*' ? `${f.specifier.local}.${f.usage.member ?? '*'}` : f.specifier.imported);

const ENTRY_RANK: Record<EntryKind, number> = { main: 0, lazy: 1, test: 2, hypothetical: 3 };

/**
 * The cycle that makes a failure possible: `from` reads a binding of `origin` while `origin` is
 * still loading, so `origin` reaches `from` and `from` reaches `origin` (via `to`). Prefer that
 * cycle; fall back to the shortest cycle through the import edge.
 */
const failureCycle = (adj: Adjacency, fp: FailurePoint, originInProgress: boolean): string[] => {
  const origin = fp.originPath;
  if (origin && originInProgress && origin !== fp.from) {
    const there = shortestPath(adj, fp.to, origin);
    const back = shortestPath(adj, origin, fp.from);
    if (there && back) {
      const nodes = [fp.from, ...there, ...back.slice(1, -1)];
      if (new Set(nodes).size === nodes.length) return nodes;
    }
  }
  return shortestCycleThroughEdge(adj, fp.from, fp.to) ?? [fp.from, fp.to];
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

  // 1. Load-time failures (real entries + hypothetical "imported first" orders) ------------------
  const failuresByEdge = new Map<string, Map<string, FailurePoint>>();
  const inProgress = new Map<FailurePoint, boolean>();
  for (const ev of entries) {
    for (const b of ev.breakages) {
      for (const f of b.failing) {
        const edgeKey = `${b.from}\0${b.to}`;
        const symbol = symbolOf(f);
        const viaKey = (f.via ?? []).map((s) => `${s.path}#${s.fn}`).join('>');
        const key = `${symbol}\0${f.binding}\0${viaKey}\0${f.usage.line}:${f.usage.column}`;
        let perEdge = failuresByEdge.get(edgeKey);
        if (!perEdge) {
          perEdge = new Map();
          failuresByEdge.set(edgeKey, perEdge);
        }
        let fp = perEdge.get(key);
        if (!fp) {
          fp = { from: b.from, to: b.to, usage: f.usage, symbol, binding: f.binding, via: f.via, originPath: f.originPath, originKind: f.originKind, state: f.state, entries: [] };
          perEdge.set(key, fp);
        }
        if (f.originState === 'in-progress') inProgress.set(fp, true);
        if (!fp.entries.some((e) => e.entry === ev.entry && e.kind === ev.kind)) fp.entries.push({ entry: ev.entry, kind: ev.kind, chain: b.chain });
      }
    }
  }

  for (const perEdge of failuresByEdge.values()) {
    const failures = [...perEdge.values()].sort((a, b) => a.usage.line - b.usage.line || a.usage.column - b.usage.column);
    for (const fp of failures) fp.entries.sort((a, b) => ENTRY_RANK[a.kind] - ENTRY_RANK[b.kind] || a.entry.localeCompare(b.entry));
    const kinds = new Set(failures.flatMap((f) => f.entries.map((e) => e.kind)));
    const kind: FindingKind = kinds.has('main') || kinds.has('lazy') ? 'runtime-break' : kinds.has('test') ? 'test-break' : 'latent-cycle';
    // Hypothetical orders only matter when no real entry triggers the failure.
    if (kind !== 'latent-cycle') for (const fp of failures) fp.entries = fp.entries.filter((e) => e.kind !== 'hypothetical');
    const first = failures[0]!;
    const from = first.from;
    const scc = sccByNode.get(from);
    const cycle = materializeCycle(graph, failureCycle(adj, first, inProgress.get(first) ?? false));
    const symbols = [...new Set(failures.map((f) => (f.via ? `${f.symbol}()` : f.symbol)))];
    // `var`/`enum`/`namespace` bindings are `undefined` before their module runs: reading a member
    // or calling throws, merely capturing the value (`[MyEnum]`) silently stores `undefined`.
    const throws = first.state === 'tdz' || first.via !== undefined || first.usage.call === true || first.usage.access !== undefined;
    const errorText =
      first.state === 'tdz'
        ? `ReferenceError: Cannot access '${first.binding}' before initialization`
        : throws
          ? `TypeError: '${first.binding}' is undefined at this point`
          : `'${first.binding}' is still undefined here – no error at load time, but the captured value is silently missing`;
    const origin = rel(first.originPath ?? first.to);
    const what = first.via
      ? `calls \`${first.symbol}()\` at load time, which reads \`${first.binding}\` (${first.originKind} in \`${origin}\`)`
      : `reads \`${first.symbol}\` (${first.originKind} declared in \`${origin}\`)`;
    const when =
      kind === 'latent-cycle'
        ? ` if \`${rel(first.entries[0]!.entry)}\` is the first file of this cycle to be imported`
        : '';
    const titleWhat = first.via ? `\`${first.symbol}()\` reads \`${first.binding}\` before initialisation` : `\`${symbols.join('`, `')}\` read before initialisation`;
    findings.push({
      id: '',
      severity: kind === 'runtime-break' ? 'critical' : kind === 'test-break' ? 'high' : 'medium',
      kind,
      title:
        kind === 'runtime-break'
          ? `Load-time crash: ${titleWhat} in \`${rel(from)}\``
          : kind === 'test-break'
            ? `Crashes when loaded from tests: ${titleWhat} in \`${rel(from)}\``
            : `Order-dependent crash: ${titleWhat} in \`${rel(from)}\``,
      summary: `\`${rel(from)}:${first.usage.line}\` ${what} before that module has finished loading${when} → ${errorText}.${kind === 'latent-cycle' ? ' The current entry points happen to load this cycle in a safe order.' : ''}`,
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
        ? `Each of these injectables needs the next one while it is being constructed; Angular throws "NG0200: Circular dependency in DI detected" the first time one of them is injected.`
        : `Constructor dependencies form a cycle, but one edge uses @SkipSelf/@Host and may resolve from a parent injector – verify manually.`,
      sccId: firstPath ? (sccByNode.get(firstPath)?.id ?? 0) : 0,
      diCycle: dc,
      failures: [],
      suggestions: suggestForDiCycle(names),
      edgeNotes: [],
    });
  }

  // 3. Runtime cycle groups that cannot crash under any load order (one finding per group) --------
  const groupsWithFailures = new Set(findings.filter((f) => f.failures.length > 0).map((f) => f.sccId));
  for (const scc of sccs) {
    if (groupsWithFailures.has(scc.id)) continue;
    const cycle = scc.cycles[0];
    if (!cycle) continue;
    const edges = cycle.edges;
    const anyEager = scc.cycles.some((c) => c.edges.some((e) => e.usage === 'eager'));
    const anyDeferred = scc.cycles.some((c) => c.edges.some((e) => e.usage === 'deferred'));
    const reason = anyEager
      ? 'Every load-time read inside the group targets a hoisted function or a binding declared outside the group, so no import order can hit an uninitialised value.'
      : anyDeferred
        ? 'Imported bindings are only used inside functions, methods, constructors or instance fields, so nothing is read while the modules load.'
        : 'The files only reach each other through barrel re-exports or side-effect imports.';
    findings.push({
      id: '',
      severity: 'low',
      kind: 'deferred-cycle',
      title: `Import cycle without load-time risk: ${scc.nodes.length} files (group #${scc.id})`,
      summary: `Replayed with each of the ${scc.nodes.length} files imported first – none crashes. ${reason} Still worth untangling: the next top-level use (a static field, a route array, \`extends\`) turns it into a crash.`,
      sccId: scc.id,
      cycle,
      failures: [],
      suggestions: suggestForCycle(sctx, cycle, []),
      edgeNotes: edges.map(edgeNoteFor),
    });
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
          ? 'These files reference each other only in type positions. The compiler removes these imports, so nothing is evaluated at runtime. No action needed – converting to `import type` changes nothing.'
          : `At runtime only one direction exists: ${erasedEdges.map((e) => `\`${rel(e.from)}\` → \`${rel(e.to)}\``).join(', ')} ${erasedEdges.length === 1 ? 'is' : 'are'} used purely as types and erased by the compiler. No load-time cycle – no action needed.`,
        sccId: scc.id,
        cycle,
        failures: [],
        suggestions: [{ kind: 'no-action', text: 'No runtime impact. Optionally use `import type` for clarity (with `verbatimModuleSyntax` it is mandatory).', verified: true }],
        edgeNotes: cycle ? cycle.edges.map(edgeNoteFor) : [],
      });
    }
  }

  const entryWeight = (f: Finding): number => f.failures.reduce((n, fp) => n + fp.entries.length, 0);
  findings.sort((a, b) => {
    const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (d !== 0) return d;
    if (a.sccId !== b.sccId && a.failures.length > 0 && b.failures.length > 0) {
      // keep findings of one group together, biggest impact first
      const ga = findings.filter((x) => x.sccId === a.sccId).length;
      const gb = findings.filter((x) => x.sccId === b.sccId).length;
      if (ga !== gb) return gb - ga;
      return a.sccId - b.sccId;
    }
    const ew = entryWeight(b) - entryWeight(a);
    if (ew !== 0) return ew;
    const la = a.cycle?.nodes.length ?? a.diCycle?.nodes.length ?? 0;
    const lb = b.cycle?.nodes.length ?? b.diCycle?.nodes.length ?? 0;
    if (la !== lb) return la - lb;
    return a.title.localeCompare(b.title);
  });
  findings.forEach((f, i) => (f.id = `C${i + 1}`));
  return findings;
};

/**
 * Greedy feedback-arc-set over a cyclic group: repeatedly cut the edge that lies on the most
 * shortest cycles, weighted by how cheap the code change is. A barrel import is not deleted but
 * *rewired* to the files that declare the used symbols (that is what the developer will do), and
 * the plan is only "verified" when the rewired graph is acyclic.
 */
const planFixes = (graph: ModuleGraph, adj: Adjacency, scc: Scc, cache: Map<string, ResolvedExport | null>): FixPlan => {
  const rel = (p: string): string => relativeTo(graph.root, p);
  const members = new Set(scc.nodes);
  const sub = subgraph(adj, scc.nodes);
  const introduced = new Set<string>(); // edges created by rewiring a barrel import
  const cuts: FixPlan['cuts'] = [];

  const originsOf = (e: GraphEdge): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const r of e.records) {
      if (r.erased || r.kind === 'dynamic') continue;
      for (const s of r.specifiers) {
        if (s.effectiveTiming === 'unused' || s.effectiveTiming === 'type') continue;
        const names = s.imported === '*' ? [...new Set(s.usages.map((u) => u.member).filter((m): m is string => Boolean(m)))] : [s.imported];
        for (const n of names) {
          const res = resolveExport(graph, e.to, n, cache);
          const origin = res?.originPath ?? e.to;
          out.set(origin, [...(out.get(origin) ?? []), n]);
        }
      }
    }
    return out;
  };

  /** Rewiring a barrel import only helps if no declaring file inside the group leads back to the importer. */
  const rewireHelps = (from: string, to: string, e: GraphEdge): boolean => {
    const without = subgraph(sub, scc.nodes);
    without.get(from)?.delete(to);
    for (const origin of originsOf(e).keys()) {
      if (origin === to || !members.has(origin)) continue;
      if (origin === from || reaches(without, origin, from)) return false;
    }
    return true;
  };

  const cost = (from: string, to: string): number => {
    const key = `${from}\0${to}`;
    if (introduced.has(key)) return 3;
    const e = graph.out.get(from)?.get(to);
    if (!e) return 5;
    if (graph.modules.get(from)?.isBarrel) return 6; // removing a re-export changes the barrel's public API
    if (e.viaBarrel && rewireHelps(from, to, e)) return 0.5;
    if (e.usage === 'none' || e.usage === 'type') return 1;
    if (e.usage === 'deferred') return 2;
    return 3;
  };

  for (let iter = 0; iter < 80; iter++) {
    const comps = stronglyConnectedComponents(sub);
    if (comps.length === 0) break;
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
    for (const [key, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [from, to] = key.split('\0') as [string, string];
      const score = count / (1 + cost(from, to));
      if (!best || score > best.score) best = { key, score };
    }
    if (!best) break;
    const [from, to] = best.key.split('\0') as [string, string];
    const e = introduced.has(best.key) ? undefined : graph.out.get(from)?.get(to);
    sub.get(from)?.delete(to);
    const fromBarrel = Boolean(graph.modules.get(from)?.isBarrel);

    if (e && e.viaBarrel && !fromBarrel && rewireHelps(from, to, e)) {
      const origins = originsOf(e);
      const rewiredTo: string[] = [];
      for (const origin of origins.keys()) {
        if (origin === from || origin === to) continue;
        rewiredTo.push(origin);
        if (members.has(origin) && !sub.get(from)?.has(origin)) {
          sub.get(from)?.add(origin);
          introduced.add(`${from}\0${origin}`);
        }
      }
      const imports = [...origins].filter(([o]) => o !== to).map(([o, names]) => `{ ${[...new Set(names)].join(', ')} } from '${importSpecifier(from, o)}'`);
      cuts.push({
        from,
        to,
        symbols: edgeSymbols(e),
        usage: e.usage,
        action: 'rewire-barrel',
        rewiredTo,
        reason: imports.length > 0 ? `import ${imports.join(', ')} instead of the barrel` : 'only loads the barrel for side effects – import the concrete file or drop the import',
      });
      continue;
    }

    const symbols = e ? edgeSymbols(e) : [];
    const usage = e?.usage ?? 'eager';
    const sample = e ? strongestSample(e) : undefined;
    cuts.push({
      from,
      to,
      symbols,
      usage,
      action: fromBarrel ? 'drop-reexport' : usage === 'none' ? 'remove-import' : 'move-code',
      reason: fromBarrel
        ? `barrel re-export: drop \`export … from '${rel(to)}'\` here, or keep files of this group from importing the barrel`
        : introduced.has(best.key)
          ? `direct dependency created by the previous rewiring: move the used symbols out of \`${rel(to)}\``
          : usage === 'eager' && sample?.contextKind === 'decorator' && ['imports', 'declarations', 'exports'].includes(sample.property ?? '')
            ? `used in the @${sample.decorator ?? 'Component'}() \`${sample.property}\` array (L${sample.line}): wrap it in \`forwardRef(() => …)\` (defers the read, keeps the import) or move the shared piece out`
            : usage === 'eager'
            ? `used at load time${sample ? ` (${sample.context}, L${sample.line})` : ''}: move the symbol into a file that does not import back, or defer the access`
            : usage === 'deferred'
              ? `only used inside functions/methods${sample ? ` (${sample.context}, L${sample.line})` : ''}: move that code, or invert the dependency (callback, injection token, event)`
              : 'no runtime use besides loading the module: remove the import',
    });
  }
  return { sccId: scc.id, cuts, verified: stronglyConnectedComponents(sub).length === 0 };
};

const strongestSample = (e: GraphEdge): Usage | undefined => {
  const rank = { type: 0, deferred: 1, eager: 2 };
  let best: Usage | undefined;
  for (const r of e.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) for (const u of s.usages) if (!best || rank[u.timing] > rank[best.timing]) best = u;
  }
  return best;
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
    replayedOrders: 0,
    durationMs: Math.round(performance.now() - started),
    phases,
  };
};

export const countBySeverity = (findings: Finding[]): Record<Severity, number> => {
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
};
