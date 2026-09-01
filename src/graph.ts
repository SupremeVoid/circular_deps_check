import type {
  ExportKind,
  ExportRecord,
  GraphEdge,
  ImportRecord,
  ModuleGraph,
  ModuleInfo,
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
  seen = new Set<string>(),
): ResolvedExport | null => {
  const key = `${modulePath}\0${name}`;
  if (cache.has(key)) return cache.get(key)!;
  if (seen.has(key)) return null;
  seen.add(key);

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
          result = { originPath: re.from, record: { ...re, kind: 'namespace' }, via: [modulePath] };
        } else if (re.from && re.importedName) {
          const inner = resolveExport(graph, re.from, re.importedName, cache, seen);
          if (inner) result = { ...inner, via: [modulePath, ...inner.via] };
          else result = { originPath: re.from, record: { ...re, kind: 'unknown' }, via: [modulePath] };
        } else {
          result = { originPath: modulePath, record: { ...re, kind: 'unknown' }, via: [] };
        }
      } else if (name !== 'default') {
        for (const star of mod.exportStar) {
          if (!star) continue;
          const inner = resolveExport(graph, star, name, cache, seen);
          if (inner) {
            result = { ...inner, via: [modulePath, ...inner.via] };
            break;
          }
        }
      }
    }
  }
  cache.set(key, result);
  return result;
};

const isValueKind = (k: ExportKind): boolean =>
  k === 'class' || k === 'function' || k === 'const' || k === 'let' || k === 'var' || k === 'enum' || k === 'namespace' || k === 'unknown';

/** Build the file-level dependency graph from parsed modules. */
export const buildGraph = (root: string, modules: Map<string, ModuleInfo>): ModuleGraph => {
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

  const exportCache = new Map();

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

      // emitDecoratorMetadata usages of interfaces/types are not emitted -> downgrade to type.
      for (const spec of record.specifiers) {
        if (!spec.usages.some((u) => u.contextKind === 'decorator-metadata')) continue;
        const resolved = spec.imported === '*' ? null : resolveExport(graph, to, spec.imported, exportCache);
        const isValue = resolved ? isValueKind(resolved.record.kind) : false;
        if (!isValue) {
          for (const u of spec.usages) {
            if (u.contextKind === 'decorator-metadata') {
              u.timing = 'type';
              u.contextKind = 'type';
              u.context = 'type position (interface/type alias – no metadata emitted)';
            }
          }
          spec.effectiveTiming = spec.usages.reduce<UsageTiming | 'unused'>((acc, u) => (acc === 'unused' || RANK[u.timing] > RANK[acc] ? u.timing : acc), 'unused');
          if (record.kind === 'static' && !record.typeOnly && record.specifiers.every((s) => s.typeOnly || (!s.reexported && (s.effectiveTiming === 'type' || s.effectiveTiming === 'unused')))) {
            record.erased = true;
          }
        }
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
