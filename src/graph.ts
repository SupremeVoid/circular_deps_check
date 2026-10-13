import type {
  ExportKind,
  ExportRecord,
  GraphEdge,
  ImportRecord,
  ImportSpecifierInfo,
  ModuleGraph,
  ModuleInfo,
  Usage,
  UsageTiming,
} from './types.js';

const RANK: Record<UsageTiming | 'none', number> = { none: 0, type: 1, deferred: 2, eager: 3 };

export const strongerUsage = (a: UsageTiming | 'none', b: UsageTiming | 'none'): UsageTiming | 'none' =>
  RANK[b] > RANK[a] ? b : a;

export interface ResolvedExport {
  /** Module that declares the binding (after following re-exports). */
  originPath: string;
  record: ExportRecord;
  /** Re-export hops from the requested module to the origin (excluding origin). */
  via: string[];
}

/**
 * Follow re-exports (including `export *`) to find where `name` exported by `modulePath` is
 * actually declared. Returns null when it cannot be found inside the analyzed set.
 */
export const resolveExport = (
  graph: ModuleGraph,
  modulePath: string,
  name: string,
  cache = new Map<string, ResolvedExport | null>(),
  state: { seen: Set<string>; guarded: boolean } = { seen: new Set(), guarded: false },
): ResolvedExport | null => {
  const key = `${modulePath}\0${name}`;
  if (cache.has(key)) return cache.get(key)!;
  if (state.seen.has(key)) {
    // Cyclic `export *` chain: unresolved *on this path only* – must not be cached as a final null.
    state.guarded = true;
    return null;
  }
  state.seen.add(key);

  const mod = graph.modules.get(modulePath);
  let result: ResolvedExport | null = null;
  if (mod) {
    const direct = mod.exports.filter((e) => e.name === name);
    // Prefer own declarations over re-exports with the same name.
    const own = direct.find((e) => e.kind !== 'reexport');
    if (own) {
      result = { originPath: modulePath, record: own, via: [] };
    } else {
      const re = direct.find((e) => e.kind === 'reexport');
      if (re) {
        if (re.from && re.importedName === '*') {
          // `export * as ns from` – a module namespace object, available from link time on.
          result = { originPath: re.from, record: { ...re, kind: 'namespace' }, via: [modulePath] };
        } else if (re.from && re.importedName && graph.modules.has(re.from)) {
          const inner = resolveExport(graph, re.from, re.importedName, cache, state);
          if (inner) result = { ...inner, via: [modulePath, ...inner.via] };
        }
        // Re-exports from packages / files outside the analysed set stay unresolved (null):
        // their evaluation state is unknown, so they must never produce a finding.
      } else if (name !== 'default') {
        for (const star of mod.exportStar) {
          if (!star || !graph.modules.has(star)) continue;
          const inner = resolveExport(graph, star, name, cache, state);
          if (inner) {
            result = { ...inner, via: [modulePath, ...inner.via] };
            break;
          }
        }
      }
    }
  }
  state.seen.delete(key);
  if (result !== null || !state.guarded) cache.set(key, result);
  return result;
};

const isValueKind = (k: ExportKind): boolean =>
  k === 'class' || k === 'function' || k === 'const' || k === 'let' || k === 'var' || k === 'enum' || k === 'namespace' || k === 'unknown';

/** Build the file-level dependency graph from parsed modules. */
/**
 * Value-looking usages of bindings that do not exist at runtime are type usages after all:
 * - interfaces/type aliases referenced by `emitDecoratorMetadata` or Angular factory parameters
 *   (the compiler emits `Object` / nothing for them),
 * - `const enum` members (inlined by the compiler; the import is elided),
 * - namespace members that resolve to types.
 * Returns true when any usage changed.
 */
const downgradeTypeBindings = (graph: ModuleGraph, record: ImportRecord, to: string, cache: Map<string, ResolvedExport | null>): boolean => {
  if (record.kind !== 'static' && record.kind !== 'import-equals') return false;
  let changed = false;
  const typeLike = (k: ExportKind): boolean => k === 'type' || k === 'interface';
  for (const spec of record.specifiers) {
    if (spec.typeOnly || spec.effectiveTiming === 'unused' || spec.effectiveTiming === 'type') continue;
    let specChanged = false;
    if (spec.imported === '*') {
      for (const u of spec.usages) {
        if (u.timing === 'type' || u.member === undefined) continue;
        const r = resolveExport(graph, to, u.member, cache);
        if (r && typeLike(r.record.kind)) {
          downgrade(u, r.record.kind);
          specChanged = true;
        }
      }
    } else {
      const r = resolveExport(graph, to, spec.imported, cache);
      for (const u of spec.usages) {
        if (u.timing === 'type') continue;
        const metadataOnly = u.contextKind === 'decorator-metadata' || u.contextKind === 'di-factory';
        // Unresolvable metadata references are assumed erased (no class to emit); other unresolved usages stay.
        if ((r && typeLike(r.record.kind)) || (!r && u.contextKind === 'decorator-metadata') || (r && metadataOnly && !isValueKind(r.record.kind))) {
          downgrade(u, r?.record.kind ?? 'type');
          specChanged = true;
        }
      }
    }
    if (specChanged) {
      spec.effectiveTiming = spec.usages.reduce<UsageTiming | 'unused'>((acc, u) => (acc === 'unused' || RANK[u.timing] > RANK[acc] ? u.timing : acc), 'unused');
      changed = true;
    }
  }
  return changed;
};

const downgrade = (u: Usage, kind: ExportKind): void => {
  u.context =
    u.contextKind === 'decorator-metadata' || u.contextKind === 'di-factory'
      ? `type position (${kind === 'interface' ? 'interface' : 'type'} – the compiler emits no value reference)`
      : 'type position (const enum / type – inlined or erased by the compiler)';
  u.timing = 'type';
  u.contextKind = 'type';
  delete u.call;
};

export interface BuildGraphOptions {
  verbatimModuleSyntax?: boolean;
}

export const buildGraph = (root: string, modules: Map<string, ModuleInfo>, opts: BuildGraphOptions = {}): ModuleGraph => {
  const graph: ModuleGraph = {
    root,
    modules,
    out: new Map(),
    in: new Map(),
    externals: new Set(),
    unresolved: [],
  };
  for (const p of modules.keys()) {
    graph.out.set(p, new Map());
    graph.in.set(p, new Set());
  }

  const exportCache = new Map<string, ResolvedExport | null>();

  for (const mod of modules.values()) {
    for (const record of mod.imports) {
      if (!record.resolvedPath || record.external || !modules.has(record.resolvedPath)) {
        if (record.external && record.resolvedPath) graph.externals.add(record.resolvedPath);
        else if (record.external) graph.externals.add(record.specifierText);
        else graph.unresolved.push({ from: mod.path, specifier: record.specifierText, line: record.line });
        continue;
      }
      const to = record.resolvedPath;
      if (to === mod.path) continue; // self import – ignore

      const typeLike = (n: string): boolean => {
        const r = resolveExport(graph, to, n, exportCache);
        return r !== null && (r.record.kind === 'type' || r.record.kind === 'interface');
      };
      // `import { T } from './t'; export { T }` of a type: tsc elides both (isolatedModules forbids it).
      if (!opts.verbatimModuleSyntax) for (const spec of record.specifiers) if (spec.reexported && spec.imported !== '*' && typeLike(spec.imported)) spec.reexported = false;
      const changed = downgradeTypeBindings(graph, record, to, exportCache);
      if (record.kind === 'static' && !record.typeOnly && (changed || record.specifiers.some((s) => s.reexported === false))) {
        const erasable = (s: ImportSpecifierInfo): boolean => s.typeOnly || (!opts.verbatimModuleSyntax && !s.reexported && (s.effectiveTiming === 'type' || s.effectiveTiming === 'unused'));
        if (record.specifiers.length > 0 && record.specifiers.every(erasable)) record.erased = true;
      }
      // `export { T } from './t'` where every name is a type: elided by tsc.
      if (record.kind === 'reexport' && !record.erased && !opts.verbatimModuleSyntax && record.reexportedNames?.length && record.reexportedNames.every((n) => n.imported !== '*' && typeLike(n.imported))) {
        record.erased = true;
      }

      const outMap = graph.out.get(mod.path)!;
      let edge = outMap.get(to);
      if (!edge) {
        edge = { from: mod.path, to, records: [], runtime: false, dynamicOnly: true, usage: 'none', viaBarrel: Boolean(modules.get(to)?.isBarrel) };
        outMap.set(to, edge);
        graph.in.get(to)!.add(mod.path);
      }
      edge.records.push(record);
      applyRecord(edge, record);
    }
  }
  return graph;
};

const applyRecord = (edge: GraphEdge, record: ImportRecord): void => {
  if (record.kind !== 'dynamic') edge.dynamicOnly = false;
  if (!record.erased && record.kind !== 'dynamic') edge.runtime = true;
  if (record.erased || record.kind === 'dynamic') return;
  for (const spec of record.specifiers) {
    if (spec.effectiveTiming === 'unused') continue;
    edge.usage = strongerUsage(edge.usage, spec.effectiveTiming);
  }
};

/** Runtime edges only (non-erased, non-dynamic). */
export const runtimeEdges = (graph: ModuleGraph): GraphEdge[] => {
  const out: GraphEdge[] = [];
  for (const m of graph.out.values()) for (const e of m.values()) if (e.runtime) out.push(e);
  return out;
};

export const allStaticEdges = (graph: ModuleGraph): GraphEdge[] => {
  const out: GraphEdge[] = [];
  for (const m of graph.out.values()) for (const e of m.values()) if (!e.dynamicOnly) out.push(e);
  return out;
};

/** Symbols imported over an edge (non-erased records). */
export const edgeSymbols = (edge: GraphEdge): string[] => {
  const names = new Set<string>();
  for (const r of edge.records) {
    if (r.erased) {
      for (const s of r.specifiers) names.add(`${s.imported === '*' ? `* as ${s.local}` : s.imported} (type)`);
      continue;
    }
    if (r.kind === 'side-effect') names.add('(side-effect import)');
    else if (r.kind === 'reexport-all') names.add('export *');
    else if (r.kind === 'reexport') for (const n of r.reexportedNames ?? []) names.add(`export { ${n.imported} }`);
    else if (r.kind === 'dynamic') names.add('import()');
    else
      for (const s of r.specifiers) {
        const base = s.imported === '*' ? `* as ${s.local}` : s.imported;
        names.add(s.typeOnly || s.effectiveTiming === 'type' ? `${base} (type)` : base);
      }
  }
  return [...names];
};
