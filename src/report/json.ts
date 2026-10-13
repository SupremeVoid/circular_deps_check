import type { AnalysisResult, Finding, GraphEdge } from '../types.js';
import { relativeTo } from '../util/paths.js';
import { edgeSymbols } from '../graph.js';

/** Compact, path-relative JSON representation used by the JSON output and embedded in the HTML report. */
export interface JsonReport {
  tool: { name: string; version: string };
  root: string;
  generatedAt: string;
  options: AnalysisResult['options'];
  stats: AnalysisResult['stats'];
  counts: Record<string, number>;
  findings: JsonFinding[];
  groups: JsonGroup[];
  typeOnlyGroups: JsonGroup[];
  entries: { entry: string; kind: string; evaluated: number; breakages: number }[];
  fixPlans: { sccId: number; verified: boolean; cuts: { from: string; to: string; symbols: string[]; usage: string; action: string; rewiredTo?: string[]; reason: string }[] }[];
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface JsonFinding {
  id: string;
  severity: string;
  kind: string;
  title: string;
  summary: string;
  sccId: number;
  cycle?: { nodes: string[]; edges: JsonEdge[] };
  di?: {
    nodes: { name: string; path: string | null; line: number; decorator: string }[];
    edges: { from: string; to: string; via: string; flags: string[]; path: string; line: number }[];
    certain: boolean;
  };
  failures: {
    from: string;
    to: string;
    symbol: string;
    /** The uninitialised binding (differs from `symbol` when reached through a call chain). */
    binding: string;
    /** Load-time call chain from `symbol()` to the read of `binding`. */
    via?: { fn: string; path: string; line: number }[];
    /** Reason when the crash is possible but not certain. */
    uncertain?: string;
    line: number;
    column: number;
    snippet: string;
    context: string;
    originPath: string | null;
    originKind: string;
    state: string;
    entries: { entry: string; kind: string; chain: string[] }[];
  }[];
  suggestions: { kind: string; text: string; verified: boolean; details?: string[] }[];
}

export interface JsonEdge {
  from: string;
  to: string;
  usage: string;
  symbols: string[];
  viaBarrel: boolean;
  sample?: { symbol: string; line: number; column: number; context: string; snippet: string; timing: string };
}

export interface JsonGroup {
  id: number;
  files: string[];
  edgeCount: number;
  barrels: string[];
  truncated: boolean;
  cycles: { nodes: string[]; edges: JsonEdge[] }[];
}

export const toJsonReport = (result: AnalysisResult, version: string): JsonReport => {
  const rel = (p: string): string => relativeTo(result.root, p);
  const edgeJson = (e: GraphEdge): JsonEdge => ({ from: rel(e.from), to: rel(e.to), usage: e.usage, symbols: edgeSymbols(e), viaBarrel: e.viaBarrel });
  const findingJson = (f: Finding): JsonFinding => ({
    id: f.id,
    severity: f.severity,
    kind: f.kind,
    title: f.title,
    summary: f.summary,
    sccId: f.sccId,
    cycle: f.cycle
      ? {
          nodes: f.cycle.nodes.map(rel),
          edges: f.edgeNotes.map((n) => ({
            from: rel(n.from),
            to: rel(n.to),
            usage: n.usage,
            symbols: n.symbols,
            viaBarrel: n.viaBarrel,
            sample: n.sample ? { symbol: n.sample.symbol, line: n.sample.line, column: n.sample.column, context: n.sample.context, snippet: n.sample.snippet, timing: n.sample.timing } : undefined,
          })),
        }
      : undefined,
    di: f.diCycle
      ? {
          nodes: f.diCycle.nodes.map((n) => ({ name: n.name, path: n.path ? rel(n.path) : null, line: n.line, decorator: n.decorator })),
          edges: f.diCycle.edges.map((e) => ({
            from: f.diCycle!.nodes.find((n) => n.id === e.from)?.name ?? e.from,
            to: f.diCycle!.nodes.find((n) => n.id === e.to)?.name ?? e.to,
            via: e.dep.via,
            flags: Object.entries(e.dep.flags).filter(([, v]) => v).map(([k]) => k),
            path: rel(e.fromPath),
            line: e.dep.line,
          })),
          certain: f.diCycle.certain,
        }
      : undefined,
    failures: f.failures.map((fp) => ({
      from: rel(fp.from),
      to: rel(fp.to),
      symbol: fp.symbol,
      binding: fp.binding,
      uncertain: fp.uncertain,
      via: fp.via?.map((v) => ({ fn: v.fn, path: rel(v.path), line: v.line })),
      line: fp.usage.line,
      column: fp.usage.column,
      snippet: fp.usage.snippet,
      context: fp.usage.context,
      originPath: fp.originPath ? rel(fp.originPath) : null,
      originKind: fp.originKind,
      state: fp.state,
      entries: fp.entries.map((e) => ({ entry: rel(e.entry), kind: e.kind, chain: e.chain.map(rel) })),
    })),
    suggestions: f.suggestions,
  });
  const groupJson = (s: AnalysisResult['sccs'][number]): JsonGroup => ({
    id: s.id,
    files: s.nodes.map(rel),
    edgeCount: s.edgeCount,
    barrels: s.barrels.map(rel),
    truncated: s.truncated,
    cycles: s.cycles.map((cy) => ({ nodes: cy.nodes.map(rel), edges: cy.edges.map(edgeJson) })),
  });

  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of result.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  return {
    tool: { name: 'circular-deps-check', version },
    root: result.root,
    generatedAt: result.generatedAt,
    options: result.options,
    stats: result.stats,
    counts,
    findings: result.findings.map(findingJson),
    groups: result.sccs.map(groupJson),
    typeOnlyGroups: result.typeOnlySccs.map(groupJson),
    entries: result.entries.map((e) => ({ entry: rel(e.entry), kind: e.kind, evaluated: e.evaluatedCount, breakages: e.breakages.length })),
    fixPlans: result.fixPlans.map((p) => ({
      sccId: p.sccId,
      verified: p.verified,
      cuts: p.cuts.map((c) => ({ ...c, from: rel(c.from), to: rel(c.to), rewiredTo: c.rewiredTo?.map(rel) })),
    })),
    unresolved: result.graph.unresolved.map((u) => ({ ...u, from: rel(u.from) })),
  };
};
