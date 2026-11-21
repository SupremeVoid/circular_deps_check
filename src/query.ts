/**
 * Query layer: small, focused answers about an analysis – for the CLI subcommands and the MCP
 * server. A full report of a production project is hundreds of kilobytes; an agent (or a person in
 * a terminal) wants the summary first, then one finding, then "what if I change this import".
 *
 * Every view uses paths relative to the project root and plain JSON-serialisable objects.
 */
import path from 'node:path';
import type { AnalysisResult, EntryKind, FailurePoint, Finding, FindingKind, FixPlan, PreviewFailure, Severity } from './types.js';
import { countBySeverity, severityRank, simulateChanges, type ImportChange } from './analyze.js';
import { normalizePath, relativeTo } from './util/paths.js';
import type { JsonReport } from './report/json.js';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CRASH_KINDS: FindingKind[] = ['runtime-break', 'test-break', 'possible-break'];

/** What each kind of finding means, in the words used across the views. */
const KIND_TEXT: Record<FindingKind, string> = {
  'runtime-break': 'crashes when the app or a lazy route loads',
  'test-break': 'crashes when a spec file loads',
  'possible-break': 'possible crash on a real load path (not provable)',
  'di-cycle': 'Angular DI cycle (NG0200)',
  'latent-cycle': 'order-dependent: fine in every current load order',
  'deferred-cycle': 'cycle that cannot crash',
  'type-only-cycle': 'type-only cycle (erased by the compiler)',
};

export class QueryError extends Error {}

// ------------------------------------------------------------------------------------- lookups

/** Resolve a path given by a user or an agent: absolute, relative to the root, or a unique suffix. */
export const resolveFile = (result: AnalysisResult, file: string): string => {
  const modules = result.graph.modules;
  const direct = normalizePath(path.isAbsolute(file) ? file : path.join(result.root, file));
  if (modules.has(direct)) return direct;
  const wanted = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const matches = [...modules.keys()].filter((p) => p === wanted || p.endsWith(`/${wanted}`));
  if (matches.length === 1) return matches[0]!;
  const rel = (p: string): string => relativeTo(result.root, p);
  throw new QueryError(matches.length === 0 ? `No analysed file matches "${file}".` : `"${file}" matches ${matches.length} files: ${matches.slice(0, 6).map(rel).join(', ')}${matches.length > 6 ? ', …' : ''}. Give a longer path.`);
};

export const findFinding = (result: AnalysisResult, idOrKey: string): Finding => {
  const wanted = idOrKey.trim();
  const f = result.findings.find((x) => x.id.toLowerCase() === wanted.toLowerCase()) ?? result.findings.find((x) => x.key === wanted);
  if (!f) throw new QueryError(`No finding "${idOrKey}". Ids of this run are ${result.findings.length > 0 ? `C1 … C${result.findings.length}` : 'none (no findings)'}; ids change between runs, keys do not.`);
  return f;
};

// ------------------------------------------------------------------------------------- views

export interface PreviewView {
  /** `file:line` of the read. */
  at: string;
  reads: string;
  /** Under which entry it fails. */
  when: string;
  /** Set when the failure is possible, not certain. */
  possible?: string;
  /** The finding that already lists this read, and as what. */
  known?: string;
}

export interface PlanStepView {
  change: 'import directly' | 'remove import' | 'break import' | 'change barrel re-export';
  from: string;
  to: string;
  symbols: string[];
  how: string;
  /** For `import directly`: the files to import from instead. */
  importFrom?: string[];
  /** After this step (and the ones before it): what a replay of the entry points shows. */
  then?: { resolved: string[]; nextCrashes: PreviewView[]; stillFailing: PreviewView[] };
}

export interface PlanView {
  group: number;
  files: number;
  /** The group is no longer cyclic once every step is done. */
  verified: boolean;
  steps: PlanStepView[];
  replay: string;
}

export interface FindingRow {
  id: string;
  key: string;
  severity: Severity;
  kind: FindingKind;
  group: number;
  what: string;
  /** `file:line` of the (first) failing read. */
  at?: string;
  when?: string;
}

export interface SummaryView {
  root: string;
  files: number;
  lines: number;
  entryPoints: { app: string[]; lazyChunks: number; specs: number };
  counts: Record<Severity, number>;
  verdict: string;
  /** Cyclic groups with something to act on or know about, worst first. */
  groups: { group: number; files: number; worst: Severity; findings: string[]; moreFindings?: number; fix?: string }[];
  moreGroups?: number;
  diCycles: string[];
  meaning: Record<Severity, string>;
}

export interface ReadView {
  key: string;
  /** `file:line:column`. */
  at: string;
  code: string;
  reads: string;
  declaredIn: string;
  error: string;
  /** Load-time call chain from the read into the function that touches the uninitialised binding. */
  via?: string[];
  possible?: string;
  /** Order-dependent reads: the file that has to be imported first to make it fail. */
  failsIfImportedFirst?: string;
  otherTriggers?: number;
}

export interface FindingDetail extends FindingRow {
  meaning: string;
  summary: string;
  reads: ReadView[];
  moreReads?: number;
  /** The load order that leads to the first read: entry point first, failing file last. */
  loadOrder?: { entry: string; kind: EntryKind; files: string[] };
  failsUnder?: { app: string[]; specs: number; specExamples: string[] };
  /** Order-dependent groups: the files through which today's entry points enter the group. */
  enteredThrough?: { file: string; by: string }[];
  cycle?: { files: string[]; imports: { from: string; to: string; use: string; viaBarrel?: true; code: string[] }[] };
  di?: { services: string[]; needs: { from: string; to: string; at: string; code?: string; how: string }[]; certain: boolean };
  fixes: { verified: boolean; text: string; details?: string[] }[];
  /** The fix plan of the whole group (`plan` / `get_fix_plan` has the replay of every step). */
  groupFix?: string;
}

export interface SimulationView {
  simulated: boolean;
  entryPointsReplayed: number;
  specsNotReplayed?: number;
  /** Findings of today that no longer occur. */
  resolved: string[];
  /** Reads in the cyclic groups you touched that fail today and would still fail. */
  stillFailing: PreviewView[];
  /** Reads that are fine today and would fail after the change. */
  newlyFailing: PreviewView[];
  redirected?: { from: string; barrel: string; importFrom: string[] }[];
  notes?: string[];
  verdict: string;
}

export interface DiffView {
  before: Record<Severity, number>;
  after: Record<Severity, number>;
  resolved: { key: string; severity: Severity; what: string }[];
  introduced: FindingRow[];
  changed: { id: string; key: string; what: string; severity?: string; readsGone?: number; readsNew?: number }[];
  unchanged: number;
  verdict: string;
}

// ------------------------------------------------------------------------------------- builders

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const views = (result: AnalysisResult) => {
  const rel = (p: string): string => relativeTo(result.root, p);
  const whenOf = (kind: EntryKind, entry: string): string => (kind === 'main' ? 'app start' : kind === 'lazy' ? `lazy chunk ${rel(entry)} loads` : kind === 'test' ? `spec ${rel(entry)} loads` : `${rel(entry)} is imported first`);
  const preview = (x: PreviewFailure): PreviewView => ({
    at: `${rel(x.from)}:${x.line}`,
    reads: x.symbol === x.binding ? x.binding : `${x.symbol} → ${x.binding}`,
    when: whenOf(x.entryKind, x.entry),
    possible: x.uncertain,
    known: x.knownAs ? `${x.knownAs} (${x.knownKind === 'latent-cycle' ? 'today only order-dependent' : x.knownKind === 'test-break' ? 'today only in specs' : 'already reported'})` : undefined,
  });
  const triggerOf = (f: Finding): string | undefined => {
    if (f.kind === 'latent-cycle') return 'only under another import order';
    const kinds = new Set(f.failures.flatMap((fp) => fp.entries.map((e) => e.kind)));
    const specs = new Set(f.failures.flatMap((fp) => fp.entries.filter((e) => e.kind === 'test').map((e) => e.entry))).size;
    const parts = [kinds.has('main') ? 'app start' : '', kinds.has('lazy') ? 'lazy route' : '', specs ? plural(specs, 'spec') : ''].filter(Boolean);
    return parts.length > 0 ? `${f.kind === 'possible-break' ? 'possibly on ' : 'on '}${parts.join(', ')}` : undefined;
  };
  const row = (f: Finding): FindingRow => {
    const first = f.failures[0];
    return {
      id: f.id,
      key: f.key,
      severity: f.severity,
      kind: f.kind,
      group: f.sccId,
      what: f.title,
      at: first && f.kind !== 'latent-cycle' ? `${rel(first.from)}:${first.usage.line}` : undefined,
      when: triggerOf(f),
    };
  };
  /** One line per finding for overviews: `C1 critical: … at file:line (on app start)`. */
  const line = (f: Finding): string => {
    const r = row(f);
    return `${r.id} ${r.severity}: ${r.what.replace(/`/g, '')}${r.at ? ` at ${r.at}` : ''}${r.when ? ` (${r.when})` : ''}`;
  };
  const replayText = (plan: FixPlan): string => {
    const p = plan.preview;
    if (!p) return 'not replayed';
    if (!p.simulated) return `not replayed: ${p.reason}`;
    const last = p.steps[plan.cuts.length - 1];
    const scope = `${plural(p.entries, 'entry point')}${p.skippedTests ? ` (app only, ${plural(p.skippedTests, 'spec')} not replayed)` : ''}`;
    if (!last) return `replayed ${scope}`;
    const left = last.remaining.length + last.exposed.length;
    return left === 0
      ? `replayed ${scope} with every step done: ${p.skippedTests ? 'no app-load crash' : 'no crash'} left in this group, none surfaces elsewhere`
      : `replayed ${scope} with every step done: ${plural(left, 'read')} still ${left === 1 ? 'fails' : 'fail'}`;
  };
  const plan = (p: FixPlan): PlanView => {
    const steps = p.preview?.simulated ? p.preview.steps : [];
    let done = new Set<string>();
    return {
      group: p.sccId,
      files: result.sccs.find((s) => s.id === p.sccId)?.nodes.length ?? 0,
      verified: p.verified,
      steps: p.cuts.map((c, i) => {
        const st = steps[i];
        const newly = st ? st.resolved.filter((id) => !done.has(id)) : [];
        if (st) done = new Set(st.resolved);
        return {
          change: c.action === 'rewire-barrel' ? 'import directly' : c.action === 'remove-import' ? 'remove import' : c.action === 'drop-reexport' ? 'change barrel re-export' : 'break import',
          from: rel(c.from),
          to: rel(c.to),
          symbols: c.symbols,
          how: c.reason,
          importFrom: c.rewiredTo?.map(rel),
          then: st ? { resolved: newly, nextCrashes: st.exposed.map(preview), stillFailing: st.remaining.map(preview) } : undefined,
        };
      }),
      replay: replayText(p),
    };
  };
  const planBrief = (p: FixPlan | undefined): string | undefined => {
    if (!p || p.cuts.length === 0) return undefined;
    const cuts = p.cuts.slice(0, 3).map((c) => `${rel(c.from)} → ${rel(c.to)}`).join('; ');
    return `${p.verified ? 'verified' : 'partial'}, ${plural(p.cuts.length, 'import')} to change: ${cuts}${p.cuts.length > 3 ? '; …' : ''}`;
  };
  return { rel, whenOf, preview, row, line, plan, planBrief };
};

export const summarize = (result: AnalysisResult, opts: { maxGroups?: number } = {}): SummaryView => {
  const v = views(result);
  const counts = countBySeverity(result.findings);
  const byGroup = new Map<number, Finding[]>();
  for (const f of result.findings) {
    if (f.kind === 'di-cycle' || f.kind === 'type-only-cycle') continue;
    byGroup.set(f.sccId, [...(byGroup.get(f.sccId) ?? []), f]);
  }
  const worst = (list: Finding[]): Severity => list.reduce<Severity>((w, f) => (severityRank(f.severity) < severityRank(w) ? f.severity : w), 'info');
  const groups = [...byGroup].sort((a, b) => severityRank(worst(a[1])) - severityRank(worst(b[1])) || b[1].length - a[1].length || a[0] - b[0]);
  const max = opts.maxGroups ?? 15;
  const broken = counts.critical + counts.high;
  return {
    root: result.root,
    files: result.stats.files,
    lines: result.stats.loc,
    entryPoints: { app: result.options.entries, lazyChunks: result.entries.filter((e) => e.kind === 'lazy').length, specs: result.options.testEntries.length },
    counts,
    verdict: counts.critical
      ? `${plural(counts.critical, 'load-time crash', 'load-time crashes')} when the app or a lazy route loads${counts.high ? `, ${plural(counts.high, 'more problem')} in specs or Angular DI` : ''}`
      : broken
        ? `no crash on app load, ${plural(counts.high, 'problem')} in specs or Angular DI`
        : counts.medium
          ? `no proven crash, ${plural(counts.medium, 'possible crash', 'possible crashes')} to check`
          : result.stats.sccs
            ? 'nothing is broken in any current load order'
            : 'no runtime import cycles',
    groups: groups.slice(0, max).map(([id, list]) => ({
      group: id,
      files: result.sccs.find((s) => s.id === id)?.nodes.length ?? 0,
      worst: worst(list),
      findings: list.slice(0, 8).map(v.line),
      moreFindings: list.length > 8 ? list.length - 8 : undefined,
      fix: v.planBrief(result.fixPlans.find((p) => p.sccId === id)),
    })),
    moreGroups: groups.length > max ? groups.length - max : undefined,
    diCycles: result.findings.filter((f) => f.kind === 'di-cycle').map(v.line),
    meaning: {
      critical: 'crashes when the app or a lazy route loads – fix',
      high: 'crashes when a spec loads, Angular DI cycle, or a silently undefined value on app load – fix',
      medium: 'possible crash on a real load path, not provable – check the reason',
      low: 'order-dependent: works in every current load order – nothing to fix now',
      info: 'cannot crash – nothing to do',
    },
  };
};

export interface FindingFilter {
  severity?: Severity;
  /** This severity or worse. */
  minSeverity?: Severity;
  kind?: FindingKind;
  /** Substring of a file path involved in the finding (failing file, cycle member, DI service file). */
  file?: string;
  group?: number;
  limit?: number;
}

const involves = (result: AnalysisResult, f: Finding, needle: string): boolean => {
  const n = needle.replace(/\\/g, '/').toLowerCase();
  const paths = [...f.failures.flatMap((fp) => [fp.from, fp.to, fp.originPath ?? '']), ...(f.cycle?.nodes ?? []), ...(f.diCycle?.nodes.map((x) => x.path ?? '') ?? [])];
  return paths.some((p) => relativeTo(result.root, p).toLowerCase().includes(n));
};

export const listFindings = (result: AnalysisResult, filter: FindingFilter = {}): { total: number; shown: number; findings: FindingRow[] } => {
  const v = views(result);
  const all = result.findings.filter(
    (f) =>
      (!filter.severity || f.severity === filter.severity) &&
      (!filter.minSeverity || severityRank(f.severity) <= severityRank(filter.minSeverity)) &&
      (!filter.kind || f.kind === filter.kind) &&
      (filter.group === undefined || f.sccId === filter.group) &&
      (!filter.file || involves(result, f, filter.file)),
  );
  const shown = all.slice(0, filter.limit ?? 50);
  return { total: all.length, shown: shown.length, findings: shown.map(v.row) };
};

/** The same list as one line per finding – for terminals and agents. */
export const listFindingLines = (result: AnalysisResult, filter: FindingFilter = {}): { total: number; shown: number; findings: string[] } => {
  const { total, shown, findings } = listFindings(result, filter);
  return { total, shown, findings: findings.map((r) => `${r.id} ${r.severity} [${r.kind}${r.group ? `, group ${r.group}` : ''}]: ${r.what.replace(/`/g, '')}${r.at ? ` at ${r.at}` : ''}${r.when ? ` (${r.when})` : ''}`) };
};

const errorOf = (fp: FailurePoint): string =>
  fp.state === 'tdz'
    ? `ReferenceError: Cannot access '${fp.binding}' before initialization`
    : fp.via !== undefined || fp.usage.call === true || fp.usage.access !== undefined
      ? `TypeError: '${fp.binding}' is undefined at this point`
      : `'${fp.binding}' is still undefined – no error, but the captured value is missing`;

export const explainFinding = (result: AnalysisResult, idOrKey: string, opts: { maxReads?: number } = {}): FindingDetail => {
  const v = views(result);
  const f = findFinding(result, idOrKey);
  const max = opts.maxReads ?? 10;
  const latent = f.kind === 'latent-cycle';
  const read = (fp: FailurePoint): ReadView => ({
    key: fp.key,
    at: `${v.rel(fp.from)}:${fp.usage.line}:${fp.usage.column}`,
    code: fp.usage.snippet,
    reads: fp.via ? `${fp.symbol}${fp.usage.call ? '()' : ''} → ${fp.binding}` : fp.symbol,
    declaredIn: `${fp.originKind} in ${v.rel(fp.originPath ?? fp.to)}`,
    error: errorOf(fp),
    via: fp.via?.map((s) => `${s.fn}${fp.usage.call || s !== fp.via![0] ? '()' : ''} at ${v.rel(s.path)}:${s.line}`),
    possible: fp.uncertain,
    failsIfImportedFirst: latent && fp.entries[0] ? v.rel(fp.entries[0].entry) : undefined,
    otherTriggers: latent && (fp.triggerCount ?? fp.entries.length) > 1 ? (fp.triggerCount ?? fp.entries.length) - 1 : undefined,
  });
  const first = f.failures[0];
  const firstEntry = !latent ? first?.entries[0] : undefined;
  const entries = latent ? [] : f.failures.flatMap((fp) => fp.entries);
  const specs = [...new Set(entries.filter((e) => e.kind === 'test').map((e) => e.entry))];
  const app = [...new Set(entries.filter((e) => e.kind === 'main' || e.kind === 'lazy').map((e) => `${e.kind === 'lazy' ? 'lazy chunk ' : ''}${v.rel(e.entry)}`))];
  const plan = result.fixPlans.find((p) => p.sccId === f.sccId);
  const byWho = (g: { main: number; lazy: number; test: number }): string => [g.main ? 'app start' : '', g.lazy ? plural(g.lazy, 'lazy chunk') : '', g.test ? plural(g.test, 'spec') : ''].filter(Boolean).join(', ');
  return {
    ...v.row(f),
    meaning: KIND_TEXT[f.kind],
    summary: f.summary,
    reads: f.failures.slice(0, max).map(read),
    moreReads: f.failures.length > max ? f.failures.length - max : undefined,
    loadOrder: firstEntry ? { entry: v.rel(firstEntry.entry), kind: firstEntry.kind, files: firstEntry.chain.map(v.rel) } : undefined,
    failsUnder: entries.length > 0 ? { app, specs: specs.length, specExamples: specs.slice(0, 3).map(v.rel) } : undefined,
    enteredThrough: f.enteredThrough?.slice(0, 6).map((g) => ({ file: v.rel(g.file), by: byWho(g) })),
    cycle: f.cycle
      ? {
          files: f.cycle.nodes.map(v.rel),
          imports: f.edgeNotes.map((n) => ({
            from: v.rel(n.from),
            to: v.rel(n.to),
            use: n.usage === 'eager' ? 'read at load time' : n.usage === 'deferred' ? 'read later (inside functions)' : n.usage === 'type' ? 'type only' : 'no binding used',
            viaBarrel: n.viaBarrel || undefined,
            code: [...n.imports.map((i) => `L${i.line}: ${i.text}`), ...n.uses.map((u) => `L${u.line}: ${u.snippet}  // ${u.timing === 'eager' ? 'load time' : u.timing === 'deferred' ? 'later' : 'type'}: ${u.context}`)],
          })),
        }
      : undefined,
    di: f.diCycle
      ? {
          services: f.diCycle.nodes.map((n) => n.name),
          needs: f.diCycle.edges.map((e) => ({
            from: f.diCycle!.nodes.find((n) => n.id === e.from)?.name ?? e.from,
            to: f.diCycle!.nodes.find((n) => n.id === e.to)?.name ?? e.to,
            at: `${v.rel(e.fromPath)}:${e.dep.line}`,
            code: e.dep.snippet,
            how: e.dep.via,
          })),
          certain: f.diCycle.certain,
        }
      : undefined,
    fixes: f.suggestions.slice(0, 5).map((s) => ({ verified: s.verified, text: s.text, details: s.details })),
    groupFix: f.kind === 'di-cycle' || f.kind === 'type-only-cycle' ? undefined : v.planBrief(plan),
  };
};

/** The fix plan of a group, given the group number or the id/key of one of its findings. */
export const fixPlanFor = (result: AnalysisResult, groupOrFinding: number | string): PlanView => {
  const asNumber = typeof groupOrFinding === 'number' ? groupOrFinding : /^\d+$/.test(groupOrFinding.trim()) ? Number(groupOrFinding) : undefined;
  const group = asNumber ?? findFinding(result, String(groupOrFinding)).sccId;
  const plan = result.fixPlans.find((p) => p.sccId === group);
  if (!plan) throw new QueryError(asNumber !== undefined ? `No cyclic group #${group}. Groups of this run: ${result.sccs.map((s) => `#${s.id}`).join(', ') || 'none'}.` : `Finding ${groupOrFinding} does not belong to an import cycle group (DI and type-only cycles have no import plan).`);
  return views(result).plan(plan);
};

export interface ChangeRequest {
  /** The importing file and the imported file: relative to the root, absolute, or a unique path suffix. */
  from: string;
  to: string;
  action: ImportChange['action'];
}

export const simulate = (result: AnalysisResult, changes: ChangeRequest[]): SimulationView => {
  const v = views(result);
  const resolved: ImportChange[] = changes.map((c) => ({ from: resolveFile(result, c.from), to: resolveFile(result, c.to), action: c.action }));
  const sim = simulateChanges(result, resolved);
  const rows = sim.resolved.map((id) => v.line(findFinding(result, id)));
  const crashesToday = result.findings.filter((f) => CRASH_KINDS.includes(f.kind)).length;
  return {
    simulated: sim.simulated,
    entryPointsReplayed: sim.entries,
    specsNotReplayed: sim.skippedTests,
    resolved: rows,
    stillFailing: sim.remaining.map(v.preview),
    newlyFailing: sim.exposed.map(v.preview),
    redirected: sim.redirected.length > 0 ? sim.redirected.map((r) => ({ from: v.rel(r.from), barrel: v.rel(r.to), importFrom: r.declaringFiles.map(v.rel) })) : undefined,
    notes: sim.notes.length > 0 ? sim.notes : undefined,
    verdict: !sim.simulated
      ? 'nothing was replayed'
      : sim.exposed.length > 0
        ? `resolves ${rows.length} of ${crashesToday} crash findings, but ${plural(sim.exposed.length, 'read')} that ${sim.exposed.length === 1 ? 'is' : 'are'} fine today would fail`
        : `resolves ${rows.length} of ${crashesToday} crash findings; nothing new fails${sim.remaining.length > 0 ? `, ${plural(sim.remaining.length, 'read')} still ${sim.remaining.length === 1 ? 'fails' : 'fail'}` : ''}`,
  };
};

// ------------------------------------------------------------------------------------- diff

/** What two runs are compared by: stable keys only. */
export interface Snapshot {
  counts: Record<Severity, number>;
  findings: { key: string; id: string; severity: Severity; kind: FindingKind; what: string; at?: string; when?: string; group: number; reads: string[] }[];
}

export const snapshotOf = (result: AnalysisResult): Snapshot => {
  const v = views(result);
  return { counts: countBySeverity(result.findings), findings: result.findings.map((f) => ({ ...v.row(f), reads: f.failures.map((fp) => fp.key) })) };
};

/** A snapshot from a saved JSON report (`circular-deps.json`). */
export const snapshotFromReport = (report: JsonReport): Snapshot => {
  if (!Array.isArray(report.findings) || report.findings.some((f) => typeof f.key !== 'string')) {
    throw new QueryError('This JSON report has no finding keys – it was written by an older version. Create a new baseline with the current version.');
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const f of report.findings) counts[f.severity as Severity]++;
  return {
    counts,
    findings: report.findings.map((f) => ({
      key: f.key,
      id: f.id,
      severity: f.severity as Severity,
      kind: f.kind as FindingKind,
      what: f.title,
      at: f.failures[0] && f.kind !== 'latent-cycle' ? `${f.failures[0].from}:${f.failures[0].line}` : undefined,
      group: f.sccId,
      reads: f.failures.map((x) => x.key),
    })),
  };
};

export const diffSnapshots = (before: Snapshot, after: Snapshot): DiffView => {
  const was = new Map(before.findings.map((f) => [f.key, f]));
  const now = new Map(after.findings.map((f) => [f.key, f]));
  // An order-dependent finding is keyed by its group, and a fix changes which files form the group:
  // the same finding is then recognised by the reads it still shares with its earlier self.
  const sameAs = new Map<string, Snapshot['findings'][number]>();
  const taken = new Set<string>();
  for (const f of after.findings) {
    if (f.kind !== 'latent-cycle' || was.has(f.key)) continue;
    let best: Snapshot['findings'][number] | undefined;
    let shared = 0;
    for (const old of before.findings) {
      if (old.kind !== 'latent-cycle' || now.has(old.key) || taken.has(old.key)) continue;
      const n = old.reads.filter((r) => f.reads.includes(r)).length;
      if (n > shared) [best, shared] = [old, n];
    }
    if (best) {
      sameAs.set(f.key, best);
      taken.add(best.key);
    }
  }
  const changed: DiffView['changed'] = [];
  let unchanged = 0;
  for (const f of after.findings) {
    const old = was.get(f.key) ?? sameAs.get(f.key);
    if (!old) continue;
    const gone = old.reads.filter((r) => !f.reads.includes(r)).length;
    const added = f.reads.filter((r) => !old.reads.includes(r)).length;
    if (old.severity === f.severity && gone === 0 && added === 0) unchanged++;
    else changed.push({ id: f.id, key: f.key, what: f.what, severity: old.severity === f.severity ? undefined : `${old.severity} → ${f.severity}`, readsGone: gone || undefined, readsNew: added || undefined });
  }
  const resolved = before.findings.filter((f) => !now.has(f.key) && !taken.has(f.key)).map((f) => ({ key: f.key, severity: f.severity, what: f.what }));
  const introduced = after.findings.filter((f) => !was.has(f.key) && !sameAs.has(f.key)).map(({ reads: _reads, ...row }) => row);
  const worse = introduced.filter((f) => severityRank(f.severity) <= severityRank('medium')).length;
  return {
    before: before.counts,
    after: after.counts,
    resolved,
    introduced,
    changed,
    unchanged,
    verdict:
      resolved.length + introduced.length + changed.length === 0
        ? 'no change'
        : `${plural(resolved.length, 'finding')} resolved, ${introduced.length} new${worse > 0 ? ` (${worse} of them a crash or possible crash)` : ''}, ${changed.length} changed`,
  };
};

export const diffResults = (before: AnalysisResult, after: AnalysisResult): DiffView => diffSnapshots(snapshotOf(before), snapshotOf(after));

// ------------------------------------------------------------------------------------- text

/** Render a view as indented `key: value` text (close to YAML): readable in a terminal, cheap for an agent. */
export const toText = (value: unknown, indent = ''): string => {
  const scalar = (v: unknown): string => (typeof v === 'string' ? v : String(v));
  const isScalar = (v: unknown): boolean => v === null || typeof v !== 'object';
  if (isScalar(value)) return `${indent}${scalar(value)}`;
  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item)) lines.push(`${indent}- ${scalar(item)}`);
      else {
        const inner = toText(item, `${indent}  `).split('\n');
        lines.push(`${indent}- ${inner[0]!.trimStart()}`, ...inner.slice(1));
      }
    }
    return lines.join('\n');
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (isScalar(v)) lines.push(`${indent}${k}: ${scalar(v)}`);
    else if (Array.isArray(v) && v.length === 0) lines.push(`${indent}${k}: none`);
    else if (Array.isArray(v) && v.every(isScalar) && v.join(', ').length <= 90) lines.push(`${indent}${k}: ${v.map(scalar).join(', ')}`);
    else lines.push(`${indent}${k}:`, toText(v, `${indent}  `));
  }
  return lines.join('\n');
};
