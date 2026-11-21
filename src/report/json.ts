import type { AnalysisResult, Finding, GraphEdge, PreviewFailure } from '../types.js';
import { relativeTo } from '../util/paths.js';
import { edgeSymbols } from '../graph.js';

/** Compact, path-relative JSON representation used by the JSON output and embedded in the HTML report. */
export interface JsonReport {
  tool: { name: string; version: string };
  root: string;
  /** False when `root` is a display name, not a path on this machine. */
  editorLinks: boolean;
  generatedAt: string;
  options: AnalysisResult['options'];
  stats: AnalysisResult['stats'];
  counts: Record<string, number>;
  findings: JsonFinding[];
  groups: JsonGroup[];
  typeOnlyGroups: JsonGroup[];
  entries: { entry: string; kind: string; evaluated: number; breakages: number }[];
  fixPlans: {
    sccId: number;
    verified: boolean;
    cuts: { from: string; to: string; symbols: string[]; usage: string; action: string; rewiredTo?: string[]; loadsInstead?: string[]; reason: string }[];
    /** Replay of the real entry points with the cuts applied one after another (`steps[i]` = after `cuts[0..i]`). */
    preview?: { simulated: boolean; reason?: string; entries: number; skippedTests?: number; steps: { resolved: string[]; remaining: JsonPreviewFailure[]; exposed: JsonPreviewFailure[] }[] };
  }[];
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface JsonPreviewFailure {
  from: string;
  line: number;
  column: number;
  symbol: string;
  binding: string;
  sccId: number;
  entry: string;
  entryKind: string;
  uncertain?: string;
  /** Finding that already lists this read (e.g. as order-dependent). */
  knownAs?: string;
  knownKind?: string;
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
    edges: { from: string; to: string; via: string; flags: string[]; path: string; line: number; snippet?: string }[];
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
    /** Order-dependent reads: number of files that trigger it when imported first (`entries` holds up to three). */
    triggerCount?: number;
  }[];
  suggestions: { kind: string; text: string; verified: boolean; details?: string[] }[];
  /** Order-dependent groups: files through which today's entry points enter the group (the safe orders). */
  enteredThrough?: { file: string; main: number; lazy: number; test: number }[];
}

export interface JsonEdge {
  from: string;
  to: string;
  usage: string;
  symbols: string[];
  viaBarrel: boolean;
  sample?: { symbol: string; line: number; column: number; context: string; snippet: string; timing: string };
  /** Import statement(s) of `from` behind this edge (findings only). */
  imports?: { line: number; text: string }[];
  /** Lines of `from` that use the imported bindings, load-time reads first, at most six (findings only). */
  uses?: { symbol: string; line: number; column: number; context: string; snippet: string; timing: string }[];
  moreUses?: number;
}

export interface JsonGroup {
  id: number;
  files: string[];
  edgeCount: number;
  barrels: string[];
  truncated: boolean;
  cycles: { nodes: string[]; edges: JsonEdge[] }[];
}

export interface ReportOptions {
  /**
   * Text shown instead of the absolute project path (for reports that leave the machine: CI
   * artifacts, published samples). Editor links are switched off, since they need the real path.
   */
  displayRoot?: string;
}

export const toJsonReport = (result: AnalysisResult, version: string, opts: ReportOptions = {}): JsonReport => {
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
            imports: n.imports,
            uses: n.uses.map((u) => ({ symbol: u.symbol, line: u.line, column: u.column, context: u.context, snippet: u.snippet, timing: u.timing })),
            moreUses: n.moreUses || undefined,
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
            snippet: e.dep.snippet,
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
      triggerCount: fp.triggerCount,
    })),
    suggestions: f.suggestions,
    enteredThrough: f.enteredThrough?.map((g) => ({ ...g, file: rel(g.file) })),
  });
  const previewJson = (x: PreviewFailure): JsonPreviewFailure => ({ ...x, from: rel(x.from), entry: rel(x.entry) });
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
    root: opts.displayRoot ?? result.root,
    editorLinks: opts.displayRoot === undefined,
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
      cuts: p.cuts.map((c) => ({ ...c, from: rel(c.from), to: rel(c.to), rewiredTo: c.rewiredTo?.map(rel), loadsInstead: c.loadsInstead?.map(rel) })),
      preview: p.preview
        ? { ...p.preview, steps: p.preview.steps.map((st) => ({ resolved: st.resolved, remaining: st.remaining.map(previewJson), exposed: st.exposed.map(previewJson) })) }
        : undefined,
    })),
    unresolved: result.graph.unresolved.map((u) => ({ ...u, from: rel(u.from) })),
  };
};
