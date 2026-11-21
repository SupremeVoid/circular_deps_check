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
  GroupGateway,
  PreviewFailure,
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
import { edgeKey, evaluateAll, evaluateHypothetical, failingKey, type EvalOverrides } from './evaluate.js';
import { buildDiGraph, findDiCycles } from './di.js';
import { importSpecifier, movedSymbolDependencies, moveSymbolSuggestion, suggestForCycle, suggestForDiCycle, type SuggestContext } from './suggest.js';
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

  const groupOf = new Map<string, number>();
  for (const s of sccs) for (const n of s.nodes) groupOf.set(n, s.id);
  const entries = time('evaluate', () => evaluateAll(graph, mainEntries, testEntries, { groupOf }));
  // Prove or refute order-dependent crashes: replay each cyclic group with every member imported first.
  const replays = time('replay-groups', () => evaluateHypothetical(graph, sccs.map((s) => s.nodes)));

  const diCycles = time('di', () => (config.angular ? findDiCycles(buildDiGraph(graph)) : []));

  const suggestCtx: SuggestContext = { graph, adj: runtimeAdj, exportCache: new Map() };

  const findings = time('findings', () => composeFindings(graph, runtimeAdj, sccs, sccByNode, typeOnlySccs, entries, replays, diCycles, suggestCtx, config));

  // imports on which a read fails under a real entry: where deferring that read is a fix of its own
  const failingEdges = new Set<string>();
  for (const f of findings) if (f.kind === 'runtime-break' || f.kind === 'test-break' || f.kind === 'possible-break') for (const fp of f.failures) failingEdges.add(edgeKey(fp.from, fp.to));
  const fixPlans = time('fix-plans', () => sccs.map((s) => planFixes(graph, runtimeAdj, s, suggestCtx.exportCache, failingEdges)));
  // Replay the real entry points with each plan applied step by step: what is left, what surfaces next.
  if (config.fixPreview) time('fix-preview', () => previewFixes(graph, fixPlans, findings, sccByNode, mainEntries, testEntries, entries));

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
  // The code behind the edge: its import statement(s) and the lines using what they import.
  const imports: EdgeNote['imports'] = [];
  const all: EdgeNote['uses'] = [];
  for (const r of edge.records) {
    if (r.kind === 'dynamic') continue;
    imports.push({ line: r.line, text: importStatementText(r) });
    if (r.erased) continue;
    for (const s of r.specifiers) for (const u of s.usages) all.push({ ...u, symbol: s.imported === '*' ? `${s.local}.${u.member ?? '*'}` : s.imported });
  }
  imports.sort((a, b) => a.line - b.line);
  // one entry per source line, the strongest usage of that line
  const byLine = new Map<number, EdgeNote['uses'][number]>();
  for (const u of all) {
    const known = byLine.get(u.line);
    if (!known || rank[u.timing] > rank[known.timing]) byLine.set(u.line, u);
  }
  const lines = [...byLine.values()].sort((a, b) => rank[b.timing] - rank[a.timing] || a.line - b.line);
  const uses = lines.slice(0, MAX_EDGE_USES).sort((a, b) => a.line - b.line);
  return { from: edge.from, to: edge.to, usage: edge.usage, symbols: edgeSymbols(edge), viaBarrel: edge.viaBarrel, sample, imports, uses, moreUses: lines.length - uses.length };
};

const MAX_EDGE_USES = 6;

/** An import record as a one-line statement (multi-line imports are folded, long name lists cut). */
const importStatementText = (r: GraphEdge['records'][number]): string => {
  const from = `'${r.specifierText}'`;
  const list = (names: string[]): string => `{ ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''} }`;
  if (r.kind === 'side-effect') return `import ${from};`;
  if (r.kind === 'reexport-all') return `export * from ${from};`;
  if (r.kind === 'require') return `require(${from})`;
  if (r.kind === 'reexport') {
    const names = r.reexportedNames ?? [];
    if (names.length === 1 && names[0]!.imported === '*') return `export * as ${names[0]!.exported} from ${from};`;
    return `export ${r.typeOnly ? 'type ' : ''}${list(names.map((n) => (n.imported === n.exported ? n.exported : `${n.imported} as ${n.exported}`)))} from ${from};`;
  }
  if (r.kind === 'import-equals') return `import ${r.specifiers[0]?.local ?? '_'} = require(${from});`;
  const def = r.specifiers.find((s) => s.imported === 'default');
  const ns = r.specifiers.find((s) => s.imported === '*');
  const named = r.specifiers.filter((s) => s.imported !== 'default' && s.imported !== '*').map((s) => `${s.typeOnly && !r.typeOnly ? 'type ' : ''}${s.imported === s.local ? s.local : `${s.imported} as ${s.local}`}`);
  const parts = [def?.local, ns ? `* as ${ns.local}` : undefined, named.length > 0 ? list(named) : undefined].filter(Boolean);
  return `import ${r.typeOnly ? 'type ' : ''}${parts.join(', ')} from ${from};`;
};

/** The imported symbol as written at the failing read: `X`, `ns.member`, `ns.Class.method`, `nsExport.member`. */
const symbolOf = (f: FailingUsage): string => {
  if (f.specifier.imported === '*') return `${f.specifier.local}.${f.usage.member ?? '*'}${f.usage.staticCall ? `.${f.usage.staticCall}` : ''}`;
  // `import { ns } from './barrel'` where the barrel has `export * as ns`: the read is `ns.member`
  if (!f.via && f.binding !== f.specifier.imported && f.usage.access === f.binding) return `${f.specifier.imported}.${f.binding}`;
  // `Utils.make()` / `Cfg.value` (static method, method of a singleton object, getter): name the member
  const member = f.via?.[0]?.fn.includes('.') ? f.usage.access : undefined;
  return member && member !== '*' ? `${f.specifier.imported}.${member}` : f.specifier.imported;
};

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
  realEntries: EntryEvaluation[],
  replays: EntryEvaluation[],
  diCycles: DiCycle[],
  sctx: SuggestContext,
  config: ResolvedConfig,
): Finding[] => {
  const rel = (p: string): string => relativeTo(graph.root, p);
  const findings: Finding[] = [];
  const entries = [...realEntries, ...replays];
  const gatewaysByGroup = groupGateways(realEntries);

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
          fp = { from: b.from, to: b.to, usage: f.usage, symbol, binding: f.binding, via: f.via, uncertain: f.uncertain, originPath: f.originPath, originKind: f.originKind, state: f.state, entries: [] };
          perEdge.set(key, fp);
        }
        if (f.originState === 'in-progress') inProgress.set(fp, true);
        if (!fp.entries.some((e) => e.entry === ev.entry && e.kind === ev.kind)) fp.entries.push({ entry: ev.entry, kind: ev.kind, chain: b.chain });
      }
    }
  }

  const isReal = (fp: FailurePoint): boolean => fp.entries.some((e) => e.kind !== 'hypothetical');
  const isApp = (fp: FailurePoint): boolean => fp.entries.some((e) => e.kind === 'main' || e.kind === 'lazy');
  // `var`/`enum`/`namespace` bindings are `undefined` before their module runs: reading a member
  // or calling throws, merely capturing the value (`[MyEnum]`) silently stores `undefined`.
  const throwsAt = (f: FailurePoint): boolean => f.state === 'tdz' || f.via !== undefined || f.usage.call === true || f.usage.access !== undefined;
  const errorTextOf = (f: FailurePoint): string =>
    f.state === 'tdz'
      ? `ReferenceError: Cannot access '${f.binding}' before initialization`
      : throwsAt(f)
        ? `TypeError: '${f.binding}' is undefined at this point`
        : `'${f.binding}' is still undefined here – no error at load time, but the captured value is silently missing`;
  const whatOf = (f: FailurePoint): string => {
    const origin = rel(f.originPath ?? f.to);
    return f.via
      ? `${f.usage.call ? `calls \`${f.symbol}()\`` : `reads the getter \`${f.symbol}\``} at load time, which reads \`${f.binding}\` (${f.originKind} in \`${origin}\`)`
      : `reads \`${f.symbol}\` (${f.originKind === 'unknown' ? 'binding' : f.originKind} from \`${origin}\`)`;
  };

  /** A read that fails under a real entry point: proven (`runtime-break` / `test-break`) or possible. */
  const pushFailures = (failures: FailurePoint[], kind: 'runtime-break' | 'test-break' | 'possible-break'): void => {
    const first = failures[0]!;
    const from = first.from;
    const scc = sccByNode.get(from);
    const cycle = materializeCycle(graph, failureCycle(adj, first, inProgress.get(first) ?? false));
    const symbols = [...new Set(failures.map((f) => (f.via && f.usage.call ? `${f.symbol}()` : f.symbol)))];
    const silent = failures.every((f) => !throwsAt(f));
    const app = failures.some(isApp);
    const realEntry = first.entries[0]!;
    const when = kind === 'possible-break' ? ` when loaded from \`${rel(realEntry.entry)}\`` : '';
    const caveat = first.uncertain ? ` Not certain: ${first.uncertain}.` : '';
    const titleWhat = first.via ? `\`${first.symbol}${first.usage.call ? '()' : ''}\` reads \`${first.binding}\` before initialisation` : `\`${symbols.join('\`, \`')}\` read before initialisation`;
    // What is proven to happen today ranks by where it happens; a possible crash sits two steps below
    // the proven one, a silently missing value one step below a throwing read.
    const base: Severity = kind === 'runtime-break' ? 'critical' : kind === 'test-break' ? 'high' : app ? 'medium' : 'low';
    const severity: Severity = silent ? (base === 'critical' ? 'high' : base === 'high' ? 'medium' : 'low') : base;
    const prefix =
      kind === 'possible-break'
        ? app
          ? 'Possible crash'
          : 'Possible crash in tests'
        : silent
          ? 'Silently undefined'
          : kind === 'runtime-break'
            ? 'Load-time crash'
            : 'Crashes when loaded from tests';
    findings.push({
      id: '',
      severity,
      kind,
      title: `${prefix}: ${titleWhat} in \`${rel(from)}\``,
      summary: `\`${rel(from)}:${first.usage.line}\` ${whatOf(first)} before that module has finished loading${when} → ${errorTextOf(first)}.${caveat}`,
      sccId: scc?.id ?? 0,
      cycle,
      failures,
      suggestions: suggestForCycle(sctx, cycle, failures),
      edgeNotes: cycle.edges.map(edgeNoteFor),
    });
  };

  // Reads that only fail when another file of the group is imported first: collected per group.
  const latentByGroup = new Map<number, FailurePoint[]>();
  for (const perEdge of failuresByEdge.values()) {
    const all = [...perEdge.values()].sort((a, b) => a.usage.line - b.usage.line || a.usage.column - b.usage.column);
    for (const fp of all) fp.entries.sort((a, b) => ENTRY_RANK[a.kind] - ENTRY_RANK[b.kind] || a.chain.length - b.chain.length || a.entry.localeCompare(b.entry));
    const real = all.filter(isReal);
    // What happens under a real entry is all that counts for those reads; drop the hypothetical orders.
    for (const fp of real) fp.entries = fp.entries.filter((e) => e.kind !== 'hypothetical');
    const certain = real.filter((fp) => !fp.uncertain);
    const possible = real.filter((fp) => fp.uncertain);
    if (certain.length > 0) pushFailures(certain, certain.some(isApp) ? 'runtime-break' : 'test-break');
    if (possible.length > 0) pushFailures(possible, 'possible-break');
    for (const fp of all) {
      if (isReal(fp)) continue;
      const id = sccByNode.get(fp.from)?.id ?? 0;
      latentByGroup.set(id, [...(latentByGroup.get(id) ?? []), fp]);
    }
  }

  // 1b. Order-dependent reads: safe in every current load order (one finding per group) -----------
  for (const [sccId, list] of [...latentByGroup].sort((a, b) => a[0] - b[0])) {
    const failures = list.sort((a, b) => a.from.localeCompare(b.from) || a.usage.line - b.usage.line || a.usage.column - b.usage.column);
    for (const fp of failures) {
      // Every entry is a file that, imported first, makes this read fail; keep the count and three examples.
      fp.triggerCount = fp.entries.length;
      fp.entries = fp.entries.slice(0, 3);
    }
    const first = failures.find((f) => !f.uncertain) ?? failures[0]!;
    const cycle = materializeCycle(graph, failureCycle(adj, first, inProgress.get(first) ?? false));
    const gateways = gatewaysByGroup.get(sccId) ?? [];
    const n = failures.length;
    const reads = n === 1 ? '1 load-time read' : `${n} load-time reads`;
    const loads = (g: GroupGateway): string => [g.main ? 'the app' : '', g.lazy ? `${g.lazy} lazy chunk${g.lazy === 1 ? '' : 's'}` : '', g.test ? `${g.test} spec${g.test === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    const entered =
      gateways.length === 0
        ? 'no current entry point loads these files.'
        : gateways.length <= 3
          ? `the group is always entered through ${gateways.map((g) => `\`${rel(g.file)}\` (${loads(g)})`).join(' or ')}, and in ${gateways.length === 1 ? 'that order' : 'those orders'} every read finds its target initialised.`
          : `the group is entered through ${gateways.length} different files, and in each of those orders every read finds its target initialised.`;
    const example = `\`${rel(first.from)}:${first.usage.line}\` ${whatOf(first)} too early if \`${rel(first.entries[0]!.entry)}\` is the first file of the group to be imported`;
    findings.push({
      id: '',
      severity: 'low',
      kind: 'latent-cycle',
      title: `Order-dependent: ${reads} in group #${sccId} ${n === 1 ? 'relies' : 'rely'} on today's import order`,
      summary: `Not a problem today: ${entered} A different first import (a new spec or feature, a reordered import or barrel) changes that: e.g. ${example} → ${errorTextOf(first)}.${first.uncertain ? ` Not certain: ${first.uncertain}.` : ''}`,
      sccId,
      cycle,
      failures,
      suggestions: suggestForCycle(sctx, cycle, failures.filter((f) => cycle.edges.some((e) => e.from === f.from && e.to === f.to))),
      edgeNotes: cycle.edges.map(edgeNoteFor),
      enteredThrough: gateways,
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
      severity: 'info',
      kind: 'deferred-cycle',
      title: `Import cycle without load-time risk: ${scc.nodes.length} files (group #${scc.id})`,
      summary: `Replayed with each of the ${scc.nodes.length} files imported first – none crashes. ${reason} No action needed; the tool reports it again, with the exact line, should a later top-level use (a static field, a route array, \`extends\`) make an order crash.`,
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

/** Per cyclic group: the files through which real entry points first reach it, most used first. */
const groupGateways = (realEntries: EntryEvaluation[]): Map<number, GroupGateway[]> => {
  const byGroup = new Map<number, Map<string, GroupGateway>>();
  for (const ev of realEntries) {
    if (ev.kind === 'hypothetical') continue;
    for (const [group, file] of ev.gateways) {
      let files = byGroup.get(group);
      if (!files) byGroup.set(group, (files = new Map()));
      let g = files.get(file);
      if (!g) files.set(file, (g = { file, main: 0, lazy: 0, test: 0 }));
      g[ev.kind]++;
    }
  }
  const out = new Map<number, GroupGateway[]>();
  for (const [group, files] of byGroup) {
    out.set(group, [...files.values()].sort((a, b) => b.main - a.main || b.lazy - a.lazy || b.test - a.test || a.file.localeCompare(b.file)));
  }
  return out;
};

/**
 * Fix previews may replay at most this many times the number of real entry points (one replay of
 * one entry per cut), so they cost a bounded multiple of the normal evaluation on huge projects.
 */
const PREVIEW_BUDGET_FACTOR = 4;
const PREVIEW_BUDGET_MIN = 2000;

const pointKey = (fp: FailurePoint): string => `${fp.from}\0${fp.usage.line}:${fp.usage.column}\0${fp.binding}\0${(fp.via ?? []).map((s) => `${s.path}#${s.fn}`).join('>')}`;

/**
 * "What happens after I fix this?" – replay the real entry points with each plan applied one cut
 * at a time. Changing an import changes the load order, so a read that is safe today can become
 * the next crash; the preview names it before the developer finds out the hard way.
 */
const previewFixes = (
  graph: ModuleGraph,
  plans: FixPlan[],
  findings: Finding[],
  sccByNode: Map<string, Scc>,
  mainEntries: string[],
  testEntries: string[],
  baseline: EntryEvaluation[],
): void => {
  // A read is tracked per kind of entry: failing only in specs and failing on app load are two things,
  // and a fix can turn the first into the second.
  type Hit = { point: string; from: string; f: FailingUsage; entry: string; kind: EntryKind };
  const side = (kind: EntryKind): 'app' | 'test' => (kind === 'test' ? 'test' : 'app');
  const collect = (evs: EntryEvaluation[]): Map<string, Hit> => {
    const out = new Map<string, Hit>();
    for (const ev of evs) {
      for (const b of ev.breakages) {
        for (const f of b.failing) {
          const point = `${b.from}\0${failingKey(f)}`;
          const key = `${side(ev.kind)}\0${point}`;
          const known = out.get(key);
          if (!known || ENTRY_RANK[ev.kind] < ENTRY_RANK[known.kind]) out.set(key, { point, from: b.from, f, entry: ev.entry, kind: ev.kind });
        }
      }
    }
    return out;
  };
  /** One line per read, the app-load variant first. */
  const list = (hits: Hit[]): PreviewFailure[] => {
    const byPoint = new Map<string, Hit>();
    for (const h of hits) if (!byPoint.has(h.point) || side(h.kind) === 'app') byPoint.set(h.point, h);
    return [...byPoint.values()].map(describe);
  };
  const findingOf = new Map<string, Finding>();
  for (const f of findings) for (const fp of f.failures) if (!findingOf.has(pointKey(fp)) || f.kind !== 'latent-cycle') findingOf.set(pointKey(fp), f);
  const describe = (hit: Hit): PreviewFailure => ({
    from: hit.from,
    line: hit.f.usage.line,
    column: hit.f.usage.column,
    symbol: symbolOf(hit.f),
    binding: hit.f.binding,
    sccId: sccByNode.get(hit.from)?.id ?? 0,
    entry: hit.entry,
    entryKind: hit.kind,
    uncertain: hit.f.uncertain,
    knownAs: findingOf.get(hit.point)?.id,
    knownKind: findingOf.get(hit.point)?.kind,
  });
  const crashKinds = new Set<FindingKind>(['runtime-break', 'test-break', 'possible-break']);
  const worstOf = (sccId: number): number => findings.filter((f) => f.sccId === sccId && f.failures.length > 0).reduce((w, f) => Math.min(w, SEVERITY_RANK[f.severity]), 99);

  let budget = Math.max(PREVIEW_BUDGET_MIN, PREVIEW_BUDGET_FACTOR * (mainEntries.length + testEntries.length));
  const ordered = plans.filter((p) => p.cuts.length > 0 && worstOf(p.sccId) < 99).sort((a, b) => worstOf(a.sccId) - worstOf(b.sccId) || a.sccId - b.sccId);
  for (const plan of ordered) {
    if (plan.cuts.some((c) => c.action === 'drop-reexport')) {
      plan.preview = { simulated: false, reason: 'the plan changes a barrel re-export, so the result depends on how the importers of that barrel are rewritten', steps: [], entries: 0 };
      continue;
    }
    // Only entries that load a changed file load differently (runtime imports only).
    const affected = new Set<string>(plan.cuts.map((c) => c.from));
    const stack = [...affected];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const importer of graph.in.get(node) ?? []) {
        if (affected.has(importer) || !graph.out.get(importer)?.get(node)?.runtime) continue;
        affected.add(importer);
        stack.push(importer);
      }
    }
    let tests = testEntries.filter((t) => affected.has(t));
    let skippedTests = 0;
    // A cut whose symbol could move along with imports of its own is replayed both ways (see below).
    const replays = plan.cuts.length * (plan.cuts.some((c) => c.loadsInstead) ? 2 : 1);
    if (replays * (mainEntries.length + tests.length) > budget) {
      // Too many specs load this group to replay them for every step: fall back to the app entries.
      skippedTests = tests.length;
      tests = [];
    }
    if (replays * mainEntries.length > budget || mainEntries.length + tests.length === 0) {
      plan.preview = { simulated: false, reason: mainEntries.length + tests.length === 0 ? 'no entry point loads these files' : 'the replay budget of this run is used up by more severe groups', steps: [], entries: 0 };
      continue;
    }
    budget -= replays * (mainEntries.length + tests.length);
    const roots = new Set([...mainEntries, ...tests]);
    const before = collect(baseline.filter((ev) => roots.has(ev.root)));
    const failsIn = (hits: Map<string, Hit>, fp: FailurePoint): boolean => hits.has(`app\0${pointKey(fp)}`) || hits.has(`test\0${pointKey(fp)}`);
    // A finding counts as resolved only if every entry it fails under was replayed and is clean now.
    const allReplayed = (fp: FailurePoint): boolean => fp.entries.every((e) => (e.kind === 'test' ? roots.has(e.entry) : e.kind !== 'hypothetical'));
    const crashFindings = findings.filter((f) => crashKinds.has(f.kind) && f.failures.some((fp) => failsIn(before, fp)));
    const overrides: Required<EvalOverrides> = { removed: new Set(), rewired: new Map(), added: new Map() };
    const steps: NonNullable<FixPlan['preview']>['steps'] = [];
    for (const c of plan.cuts) {
      if (c.action === 'rewire-barrel') overrides.rewired.set(edgeKey(c.from, c.to), c.rewiredTo ?? []);
      else overrides.removed.add(edgeKey(c.from, c.to));
      if (c.loadsInstead) overrides.added.set(edgeKey(c.from, c.to), c.loadsInstead);
      // An import can go away in two ways: the using code moves or the dependency is inverted (the
      // file is simply no longer loaded from here), or the imported symbol moves to a new file that
      // still loads the symbol's own imports at this point. Both are replayed; a finding is resolved
      // only if it is gone either way, and whatever fails in one of them is listed.
      const afters = [collect(evaluateAll(graph, mainEntries, tests, { overrides: { ...overrides, added: new Map() } }))];
      if (overrides.added.size > 0) afters.push(collect(evaluateAll(graph, mainEntries, tests, { overrides })));
      const failing = new Map<string, Hit>();
      for (const after of afters) for (const [key, hit] of after) if (!failing.has(key)) failing.set(key, hit);
      steps.push({
        resolved: crashFindings.filter((f) => f.failures.every((fp) => !failsIn(failing, fp) && allReplayed(fp))).map((f) => f.id),
        remaining: list([...failing].filter(([key, hit]) => before.has(key) && sccByNode.get(hit.from)?.id === plan.sccId).map(([, hit]) => hit)),
        exposed: list([...failing].filter(([key]) => !before.has(key)).map(([, hit]) => hit)),
      });
    }
    plan.preview = { simulated: true, steps, entries: roots.size, skippedTests: skippedTests || undefined };
  }
};

/**
 * Greedy feedback-arc-set over a cyclic group: repeatedly cut the edge that lies on the most
 * shortest cycles, weighted by how cheap the code change is. A barrel import is not deleted but
 * *rewired* to the files that declare the used symbols (that is what the developer will do), and
 * the plan is only "verified" when the rewired graph is acyclic.
 */
const planFixes = (graph: ModuleGraph, adj: Adjacency, scc: Scc, cache: Map<string, ResolvedExport | null>, failingEdges: Set<string> = new Set()): FixPlan => {
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
          // `export { helper as help }` in the barrel: the declaring file knows it as `helper`
          const declared = res && res.record.kind !== 'reexport' && res.record.name !== n ? `${res.record.name} as ${n}` : n;
          out.set(origin, [...(out.get(origin) ?? []), declared]);
        }
      }
      // `export { b } from './barrel'` in a file with code of its own: that statement is rewritten too
      for (const re of r.kind === 'reexport' ? (r.reexportedNames ?? []) : []) {
        if (re.imported === '*') continue;
        const res = resolveExport(graph, e.to, re.imported, cache);
        const origin = res?.originPath ?? e.to;
        out.set(origin, [...(out.get(origin) ?? []), re.imported]);
      }
    }
    return out;
  };

  /** Rewiring a barrel import only helps if no declaring file inside the group leads back to the importer. */
  const rewireHelps = (from: string, to: string, e: GraphEdge): boolean => {
    // `export * from './barrel'` cannot be replaced by a list of names
    if (e.records.some((r) => !r.erased && r.kind === 'reexport-all')) return false;
    const without = subgraph(sub, scc.nodes);
    without.get(from)?.delete(to);
    for (const origin of originsOf(e).keys()) {
      if (origin === to || !members.has(origin)) continue;
      if (origin === from || reaches(without, origin, from)) return false;
    }
    return true;
  };

  const movableCache = new Map<GraphEdge, boolean>();
  /** Can the symbols imported over `e` move to a new file without importing back into the cycle? */
  const movable = (e: GraphEdge): boolean => {
    let m = movableCache.get(e);
    if (m === undefined) {
      const move = graph.modules.get(e.from)?.isBarrel ? null : moveSymbolSuggestion({ graph, adj, exportCache: cache }, e);
      m = move !== null && move.verified;
      movableCache.set(e, m);
    }
    return m;
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
    // a symbol that can simply move to its own file is the easier cut than one that drags the cycle along
    return movable(e) ? 2.5 : 3.5;
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
    // Can the imported symbols simply move to a new file, or do they themselves depend on files that lead back here?
    const stuck = Boolean(e) && !fromBarrel && usage !== 'none' && !movable(e!);
    const howEager = stuck ? 'invert the dependency (callback, injection token, event) – moving the symbol out is not enough, it depends on files that lead back' : 'move the symbol into a file that does not import back';
    // A symbol that moves to a new file takes its own imports along: that file still loads them.
    const plainMove = Boolean(e) && !fromBarrel && (usage === 'eager' || usage === 'deferred') && !stuck && !introduced.has(best.key);
    const loadsInstead = plainMove && e ? movedSymbolDependencies({ graph, adj, exportCache: cache }, e).filter((d) => d !== from && d !== to) : [];
    cuts.push({
      from,
      to,
      symbols,
      usage,
      action: fromBarrel ? 'drop-reexport' : usage === 'none' ? 'remove-import' : 'move-code',
      loadsInstead: loadsInstead.length > 0 ? loadsInstead : undefined,
      reason: fromBarrel
        ? `barrel re-export: drop \`export … from '${rel(to)}'\` here, or keep files of this group from importing the barrel`
        : introduced.has(best.key)
          ? `direct dependency created by the previous rewiring: move the used symbols out of \`${rel(to)}\``
          : usage === 'eager' && sample?.contextKind === 'decorator' && ['imports', 'declarations', 'exports'].includes(sample.property ?? '')
            ? `used in the @${sample.decorator ?? 'Component'}() \`${sample.property}\` array (L${sample.line}): ${
                failingEdges.has(best.key) && stuck
                  ? 'wrap it in \`forwardRef(() => …)\` – that defers this read and fixes the crash (components that need each other keep importing each other)'
                  : `${stuck ? 'take the shared piece out into a third file so that this import can go' : 'move the symbol into a file that does not import back'}${failingEdges.has(best.key) ? '; \`forwardRef(() => …)\` fixes only this crash and keeps the cycle' : ''}`
              }`
            : usage === 'eager'
            ? `used at load time${sample ? ` (${sample.context}, L${sample.line})` : ''}: ${howEager}`
            : usage === 'deferred'
              ? `only used inside functions/methods${sample ? ` (${sample.context}, L${sample.line})` : ''}: move that code, or invert the dependency (callback, injection token, event)${stuck ? '; moving the imported symbol instead would not help, it depends on files that lead back' : ''}`
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
