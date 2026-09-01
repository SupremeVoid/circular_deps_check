/**
 * Angular dependency-injection cycle detection (NG0200).
 *
 * Builds a graph of injectables (services, components, directives, pipes, tokens) where an edge
 * A -> B means "constructing A requires B" (constructor parameter, `inject(B)` in a field
 * initializer or constructor body, `useExisting`, `useClass`, factory `deps`).
 */
import type { DiCycle, DiDependency, DiEdge, DiNode, ModuleGraph, ModuleInfo } from './types.js';
import { resolveExport } from './graph.js';
import { adjacencyFrom, enumerateCycles, stronglyConnectedComponents, subgraph } from './cycles.js';

export interface DiGraph {
  nodes: Map<string, DiNode>;
  edges: DiEdge[];
}

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'object', 'Object', 'Function', 'Array', 'Date', 'Promise']);

/** Resolve a token expression written in `mod` to a stable node id. */
const resolveToken = (graph: ModuleGraph, mod: ModuleInfo, token: string, cache: Map<string, unknown>): { id: string; node: DiNode } => {
  const [head, ...rest] = token.split('.');
  const member = rest.length > 0 ? rest.join('.') : null;
  const name = head!;

  // Local declaration in the same file?
  if (!member && (mod.localClasses.includes(name) || mod.exports.some((e) => e.name === name && e.kind !== 'reexport'))) {
    const cls = mod.angular.find((a) => a.name === name);
    const id = `${mod.path}#${name}`;
    return { id, node: { id, name, path: mod.path, line: cls?.line ?? mod.exports.find((e) => e.name === name)?.line ?? 0, decorator: cls?.decorator ?? 'token' } };
  }

  // Imported binding?
  for (const record of mod.imports) {
    for (const spec of record.specifiers) {
      if (spec.local !== name) continue;
      if (record.external || !record.resolvedPath || !graph.modules.has(record.resolvedPath)) {
        const id = `external:${record.specifierText}#${member ?? spec.imported}`;
        return { id, node: { id, name: member ?? spec.imported, path: null, line: 0, decorator: 'external' } };
      }
      const exportName = spec.imported === '*' ? member ?? '*' : spec.imported;
      const resolved = resolveExport(graph, record.resolvedPath, exportName, cache as Map<string, never>);
      const originPath = resolved?.originPath ?? record.resolvedPath;
      const originMod = graph.modules.get(originPath);
      const cls = originMod?.angular.find((a) => a.name === exportName);
      const id = `${originPath}#${exportName}`;
      return { id, node: { id, name: exportName, path: originPath, line: cls?.line ?? resolved?.record.line ?? 0, decorator: cls?.decorator ?? 'token' } };
    }
  }
  const id = `unknown:${token}`;
  return { id, node: { id, name: token, path: null, line: 0, decorator: 'external' } };
};

export const buildDiGraph = (graph: ModuleGraph): DiGraph => {
  const nodes = new Map<string, DiNode>();
  const edges: DiEdge[] = [];
  const cache = new Map<string, unknown>();
  const addNode = (n: DiNode): void => {
    const existing = nodes.get(n.id);
    if (!existing) nodes.set(n.id, n);
    else if (existing.decorator === 'token' && n.decorator !== 'token') nodes.set(n.id, n);
  };

  for (const mod of graph.modules.values()) {
    for (const cls of mod.angular) {
      const selfId = `${mod.path}#${cls.name}`;
      addNode({ id: selfId, name: cls.name, path: mod.path, line: cls.line, decorator: cls.decorator });

      for (const dep of cls.deps) {
        if (PRIMITIVES.has(dep.token)) continue;
        const { id, node } = resolveToken(graph, mod, dep.token, cache);
        if (id === selfId) continue; // self injection: Angular also reports, but not a graph cycle we care about
        addNode(node);
        edges.push({ from: selfId, to: id, dep, fromPath: mod.path });
      }

      for (const prov of cls.providers) {
        const provided = resolveToken(graph, mod, prov.provide, cache);
        addNode(provided.node);
        const target = prov.useClass ?? prov.useExisting;
        if (target && target !== prov.provide) {
          const t = resolveToken(graph, mod, target, cache);
          addNode(t.node);
          const dep: DiDependency = { token: target, line: prov.line, column: 0, via: 'constructor-param', flags: {} };
          edges.push({ from: provided.id, to: t.id, dep: { ...dep, via: 'inject-field' }, fromPath: mod.path });
        }
        for (const d of prov.deps ?? []) {
          const t = resolveToken(graph, mod, d, cache);
          addNode(t.node);
          const dep: DiDependency = { token: d, line: prov.line, column: 0, via: 'constructor-param', flags: {} };
          edges.push({ from: provided.id, to: t.id, dep, fromPath: mod.path });
        }
      }
    }
  }
  return { nodes, edges };
};

export const findDiCycles = (di: DiGraph, maxCycles = 100): DiCycle[] => {
  const adj = adjacencyFrom(di.edges, di.nodes.keys());
  const sccs = stronglyConnectedComponents(adj);
  const edgeIndex = new Map<string, DiEdge>();
  for (const e of di.edges) if (!edgeIndex.has(`${e.from}\0${e.to}`)) edgeIndex.set(`${e.from}\0${e.to}`, e);

  const out: DiCycle[] = [];
  for (const comp of sccs) {
    const sub = subgraph(adj, comp);
    const { cycles } = enumerateCycles(sub, { maxCycles, maxLength: 12 });
    for (const cyc of cycles) {
      const edges: DiEdge[] = [];
      for (let i = 0; i < cyc.length; i++) {
        const e = edgeIndex.get(`${cyc[i]}\0${cyc[(i + 1) % cyc.length]}`);
        if (e) edges.push(e);
      }
      const nodes = cyc.map((id) => di.nodes.get(id)!).filter(Boolean);
      const certain = edges.every((e) => !e.dep.flags.skipSelf && !e.dep.flags.host);
      out.push({ nodes, edges, certain });
    }
  }
  return out;
};
