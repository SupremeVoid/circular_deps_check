/**
 * Angular dependency-injection cycle detection (NG0200).
 *
 * Builds a graph of injectables where an edge A -> B means "constructing A requires B":
 * constructor parameters, `inject(B)` in field initializers / constructor / parameter defaults,
 * inherited dependencies of base classes, `useClass` / `useExisting` / `useFactory` (`deps` and
 * `inject()` inside the factory), `InjectionToken` factories.
 *
 * Injector scopes are modelled: providers listed in a component's/directive's `providers` live in
 * that element injector (`Token@Component`). A root service can never see them, so a cycle through
 * a component-scoped provider and a root service is not reported unless it really closes.
 * `@SkipSelf()` dependencies resolve in the parent injector.
 */
import type { AngularClassInfo, DiCycle, DiDependency, DiDependencyFlags, DiEdge, DiNode, ModuleGraph, ModuleInfo, ProviderInfo } from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';
import { adjacencyFrom, enumerateCycles, stronglyConnectedComponents, subgraph } from './cycles.js';

export interface DiGraph {
  nodes: Map<string, DiNode>;
  edges: DiEdge[];
}

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'object', 'Object', 'Function', 'Array', 'Date', 'Promise']);
const ROOT = 'root';

interface Resolved {
  id: string;
  node: DiNode;
}

/** Resolve a token expression written in `mod` to a stable id (path#name, external:..., unknown:...). */
const resolveToken = (graph: ModuleGraph, mod: ModuleInfo, token: string, cache: Map<string, ResolvedExport | null>): Resolved => {
  const [head, ...rest] = token.split('.');
  const member = rest.length > 0 ? rest.join('.') : null;
  const name = head!;

  if (!member && mod.topLevel[name]) {
    const cls = mod.angular.find((a) => a.name === name);
    const id = `${mod.path}#${name}`;
    return { id, node: { id, name, path: mod.path, line: cls?.line ?? mod.topLevel[name]!.line, decorator: cls?.decorator ?? 'token' } };
  }

  for (const record of mod.imports) {
    for (const spec of record.specifiers) {
      if (spec.local !== name) continue;
      if (record.external || !record.resolvedPath || !graph.modules.has(record.resolvedPath)) {
        const id = `external:${record.specifierText}#${member ?? spec.imported}`;
        return { id, node: { id, name: member ?? spec.imported, path: null, line: 0, decorator: 'external' } };
      }
      const exportName = spec.imported === '*' ? (member ?? '*') : spec.imported;
      const resolved = resolveExport(graph, record.resolvedPath, exportName, cache);
      const originPath = resolved?.originPath ?? record.resolvedPath;
      const localName = resolved?.record.localName ?? exportName;
      const originMod = graph.modules.get(originPath);
      const cls = originMod?.angular.find((a) => a.name === localName);
      const id = `${originPath}#${localName}`;
      return { id, node: { id, name: localName, path: originPath, line: cls?.line ?? resolved?.record.line ?? 0, decorator: cls?.decorator ?? 'token' } };
    }
  }
  const id = `unknown:${token}`;
  return { id, node: { id, name: token, path: null, line: 0, decorator: 'external' } };
};

export const buildDiGraph = (graph: ModuleGraph): DiGraph => {
  const nodes = new Map<string, DiNode>();
  const edges: DiEdge[] = [];
  const edgeKeys = new Set<string>();
  const cache = new Map<string, ResolvedExport | null>();

  const classes = new Map<string, { info: AngularClassInfo; mod: ModuleInfo }>();
  for (const mod of graph.modules.values()) for (const info of mod.angular) classes.set(`${mod.path}#${info.name}`, { info, mod });

  const scoped = (baseId: string, scope: string): string => (scope === ROOT ? baseId : `${baseId}@${scope}`);
  const addNode = (n: DiNode, scope: string, scopeName?: string): string => {
    const id = scoped(n.id, scope);
    const existing = nodes.get(id);
    const node: DiNode = { ...n, id, scope: scope === ROOT ? ROOT : scopeName };
    if (!existing || (existing.decorator === 'token' && n.decorator !== 'token')) nodes.set(id, node);
    return id;
  };
  const addEdge = (from: string, to: string, dep: DiDependency, fromPath: string): void => {
    const key = `${from}\0${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, dep, fromPath });
  };

  /** Dependencies used to construct `id`, including inherited ones (Angular inherits the factory when there is no own constructor). */
  const effectiveDeps = (id: string): { dep: DiDependency; mod: ModuleInfo }[] => {
    const out: { dep: DiDependency; mod: ModuleInfo }[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    let needCtor = true;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const entry = classes.get(cur);
      if (!entry) break;
      const { info, mod } = entry;
      for (const dep of info.deps) {
        const isCtorDep = dep.via === 'constructor-param' || dep.via === 'inject-constructor';
        if (!isCtorDep || needCtor) out.push({ dep, mod });
      }
      if (info.hasConstructor) needCtor = false;
      cur = info.extends ? resolveToken(graph, mod, info.extends, cache).id : null;
    }
    return out;
  };

  /** Provider tokens declared in a component's injector, by resolved base id. */
  const scopeProviders = new Map<string, Map<string, { provider: ProviderInfo; mod: ModuleInfo }>>();
  for (const [id, { info, mod }] of classes) {
    if (info.providers.length === 0 || (info.decorator !== 'Component' && info.decorator !== 'Directive')) continue;
    const map = new Map<string, { provider: ProviderInfo; mod: ModuleInfo }>();
    for (const p of info.providers) map.set(resolveToken(graph, mod, p.provide, cache).id, { provider: p, mod });
    scopeProviders.set(id, map);
  }

  /** Resolve a dependency token as seen from `scope`. Returns the scoped node id. */
  const resolveIn = (mod: ModuleInfo, token: string, flags: DiDependencyFlags, scope: string, scopeName?: string): string | null => {
    if (PRIMITIVES.has(token)) return null;
    const r = resolveToken(graph, mod, token, cache);
    const local = scope !== ROOT && !flags.skipSelf ? scopeProviders.get(scope)?.get(r.id) : undefined;
    if (local) return addNode(r.node, scope, scopeName);
    return addNode(r.node, ROOT);
  };

  /** Edges for constructing class `classId` inside `scope`. */
  const built = new Set<string>();
  const buildClass = (classId: string, scope: string, scopeName?: string): void => {
    const key = scoped(classId, scope);
    if (built.has(key)) return;
    built.add(key);
    const entry = classes.get(classId);
    if (!entry) return;
    const { info, mod } = entry;
    const selfId = addNode({ id: classId, name: info.name, path: mod.path, line: info.line, decorator: info.decorator }, scope, scopeName);
    if (info.selfProvider && scope === ROOT) {
      buildProvider(info.selfProvider, mod, selfId, ROOT);
      return;
    }
    for (const { dep, mod: depMod } of effectiveDeps(classId)) {
      const target = resolveIn(depMod, dep.token, dep.flags, scope, scopeName);
      if (target && target !== selfId) addEdge(selfId, target, dep, depMod.path);
      else if (target === selfId && !dep.flags.skipSelf) addEdge(selfId, target, dep, depMod.path);
    }
  };

  const buildProvider = (p: ProviderInfo, mod: ModuleInfo, providedId: string, scope: string, scopeName?: string): void => {
    const dep = (token: string, flags: DiDependencyFlags = {}): DiDependency => ({ token, line: p.line, column: 0, via: 'provider', flags });
    if (p.useClass) {
      const target = resolveToken(graph, mod, p.useClass, cache);
      if (classes.has(target.id)) {
        buildClass(target.id, scope, scopeName);
        const to = scoped(target.id, scope);
        if (to !== providedId) addEdge(providedId, to, dep(p.useClass), mod.path);
      }
    }
    if (p.useExisting) {
      const to = resolveIn(mod, p.useExisting, {}, scope, scopeName);
      if (to && to !== providedId) addEdge(providedId, to, dep(p.useExisting), mod.path);
    }
    for (const d of p.deps ?? []) {
      const to = resolveIn(mod, d.token, d.flags, scope, scopeName);
      if (!to) continue;
      if (to === providedId && d.flags.skipSelf) continue; // parent-or-new pattern
      addEdge(providedId, to, dep(d.token, d.flags), mod.path);
    }
  };

  // Root scope: every injectable/component/directive/pipe/module/token constructs from root.
  for (const [id, { info }] of classes) {
    if (info.decorator === 'none') continue;
    buildClass(id, ROOT);
  }
  // Root-level providers (app.config.ts, bootstrapApplication, routes) and NgModule providers
  // (a module's providers live in its module/environment injector, shared with root services).
  for (const mod of graph.modules.values()) {
    const moduleProviders = mod.angular.filter((a) => a.decorator === 'NgModule').flatMap((a) => a.providers);
    for (const p of [...mod.rootProviders, ...moduleProviders]) {
      const r = resolveToken(graph, mod, p.provide, cache);
      const providedId = addNode(r.node, ROOT);
      if (!p.useClass && !p.useExisting && !p.deps && classes.has(r.id)) buildClass(r.id, ROOT);
      else buildProvider(p, mod, providedId, ROOT);
    }
  }
  // Component/directive scopes: the class itself resolves its deps in its own injector first.
  for (const [ownerId, providers] of scopeProviders) {
    const owner = classes.get(ownerId)!;
    const scopeName = owner.info.name;
    for (const [providedBase, { provider, mod }] of providers) {
      const r = resolveToken(graph, mod, provider.provide, cache);
      const providedId = addNode(r.node, ownerId, scopeName);
      if (!provider.useClass && !provider.useExisting && !provider.deps && classes.has(providedBase)) {
        // plain class provider: constructed in this injector with its own dependencies
        built.delete(scoped(providedBase, ownerId));
        buildClass(providedBase, ownerId, scopeName);
      } else {
        buildProvider(provider, mod, providedId, ownerId, scopeName);
      }
    }
    // the owning component itself
    const ownerNode = addNode({ id: ownerId, name: owner.info.name, path: owner.mod.path, line: owner.info.line, decorator: owner.info.decorator }, ROOT);
    for (const { dep, mod: depMod } of effectiveDeps(ownerId)) {
      const target = resolveIn(depMod, dep.token, dep.flags, ownerId, scopeName);
      if (target && target !== ownerNode) addEdge(ownerNode, target, dep, depMod.path);
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
  const seen = new Set<string>();
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
      // The same cycle can exist in several scopes; report it once.
      const key = nodes.map((n) => `${n.path}#${n.name}`).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      // @Optional() does not help: Angular throws NG0200 before it could fall back to null.
      const certain = edges.every((e) => !e.dep.flags.skipSelf && !e.dep.flags.host);
      out.push({ nodes, edges, certain });
    }
  }
  return out;
};
