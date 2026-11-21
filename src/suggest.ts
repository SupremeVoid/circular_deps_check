/**
 * Actionable, graph-verified suggestions for a cycle. Never proposes `import type` for value
 * usages: those imports are not the problem (type-only imports are already erased).
 */
import type { Cycle, FailurePoint, GraphEdge, ModuleGraph, Suggestion, Usage } from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';
import { reaches, type Adjacency } from './cycles.js';
import { relativeTo } from './util/paths.js';
import path from 'node:path';

export interface SuggestContext {
  graph: ModuleGraph;
  /** Runtime adjacency (non-erased, non-dynamic edges). */
  adj: Adjacency;
  exportCache: Map<string, ResolvedExport | null>;
}

const rel = (ctx: SuggestContext, p: string): string => relativeTo(ctx.graph.root, p);

/** Module specifier to write in `fromFile` for `target`: relative, without the `.ts` extension. */
export const importSpecifier = (fromFile: string, target: string): string => {
  let r = path.posix.relative(path.posix.dirname(fromFile), target).replace(/\.(d\.)?(ts|tsx|mts|cts)$/, '');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};

/** Value imports carried by an edge that are not in `moved` (they keep the import alive). */
const remainingImports = (edge: GraphEdge, moved: Set<string>): string[] => {
  const out: string[] = [];
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    if (r.kind === 'side-effect') out.push('(side-effect import)');
    if (r.kind === 'reexport' || r.kind === 'reexport-all') out.push('re-exports');
    for (const sp of r.specifiers) {
      if (sp.effectiveTiming === 'unused' || sp.effectiveTiming === 'type') continue;
      if (sp.imported === '*') {
        for (const m of new Set(sp.usages.map((u) => u.member).filter((x): x is string => Boolean(x)))) if (!moved.has(m)) out.push(`${sp.local}.${m}`);
      } else if (!moved.has(sp.imported)) out.push(sp.imported);
    }
  }
  return [...new Set(out)];
};

const strongestUsage = (edge: GraphEdge): { symbol: string; usage: Usage } | null => {
  let best: { symbol: string; usage: Usage } | null = null;
  const rank = { type: 0, deferred: 1, eager: 2 };
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      for (const u of s.usages) {
        if (!best || rank[u.timing] > rank[best.usage.timing]) best = { symbol: s.imported === '*' ? `${s.local}.${u.member ?? '*'}` : s.imported, usage: u };
      }
    }
  }
  return best;
};

/** Symbols (imported name -> origin) pulled over an edge, following barrels. */
const edgeSymbolOrigins = (ctx: SuggestContext, edge: GraphEdge): { symbol: string; origin: ResolvedExport | null; timing: string }[] => {
  const out: { symbol: string; origin: ResolvedExport | null; timing: string }[] = [];
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      if (s.effectiveTiming === 'unused' || s.effectiveTiming === 'type') continue;
      if (s.imported === '*') {
        const members = new Set(s.usages.map((u) => u.member).filter((m): m is string => Boolean(m)));
        for (const m of members) out.push({ symbol: m, origin: resolveExport(ctx.graph, edge.to, m, ctx.exportCache), timing: s.effectiveTiming });
        continue;
      }
      out.push({ symbol: s.imported, origin: resolveExport(ctx.graph, edge.to, s.imported, ctx.exportCache), timing: s.effectiveTiming });
    }
  }
  return out;
};

/** Does importing the symbols on `edge` directly from their origin files remove the cycle? */
export const directImportSuggestion = (ctx: SuggestContext, edge: GraphEdge): Suggestion | null => {
  const toMod = ctx.graph.modules.get(edge.to);
  if (!toMod?.isBarrel) return null;
  const symbols = edgeSymbolOrigins(ctx, edge);
  const reexports = edge.records.filter((r) => !r.erased && (r.kind === 'reexport' || r.kind === 'reexport-all'));
  if (symbols.length === 0 && reexports.length === 0) {
    return { kind: 'direct-import', text: `\`${rel(ctx, edge.from)}\` only imports the barrel \`${rel(ctx, edge.to)}\` for side effects – import the concrete module instead.`, verified: false };
  }
  if (symbols.length === 0) return null;

  const origins = new Map<string, string[]>();
  let unresolved = 0;
  for (const s of symbols) {
    if (!s.origin) {
      unresolved++;
      continue;
    }
    const list = origins.get(s.origin.originPath) ?? [];
    list.push(s.symbol);
    origins.set(s.origin.originPath, list);
  }
  if (origins.size === 0) return null;

  const blockers: string[] = [];
  for (const origin of origins.keys()) {
    if (origin === edge.from || reaches(ctx.adj, origin, edge.from)) blockers.push(origin);
  }
  const lines = [...origins.entries()].map(([origin, syms]) => `import { ${syms.join(', ')} } from '${importSpecifier(edge.from, origin)}';`);
  if (blockers.length === 0 && unresolved === 0) {
    return {
      kind: 'direct-import',
      text: `Replace the barrel import of \`${rel(ctx, edge.to)}\` in \`${rel(ctx, edge.from)}\` with direct imports – verified to remove this cycle.`,
      verified: true,
      details: lines,
    };
  }
  return {
    kind: 'direct-import',
    text: `Importing directly instead of via the barrel \`${rel(ctx, edge.to)}\` does NOT remove the cycle: ${blockers.map((b) => `\`${rel(ctx, b)}\``).join(', ')} still lead${blockers.length === 1 ? 's' : ''} back to \`${rel(ctx, edge.from)}\`.`,
    verified: false,
    details: lines,
  };
};

/**
 * Would moving the used symbol(s) into their own file (depending only on what they reference)
 * break the cycle? Verified with the symbol-level import slice recorded by the parser.
 */
export const moveSymbolSuggestion = (ctx: SuggestContext, edge: GraphEdge, onlySymbols?: Set<string>): Suggestion | null => {
  const symbols = edgeSymbolOrigins(ctx, edge).filter((s) => !onlySymbols || onlySymbols.has(s.symbol));
  if (symbols.length === 0) return null;
  const details: string[] = [];
  let allVerified = true;
  const names: string[] = [];
  for (const s of symbols) {
    if (!s.origin) {
      allVerified = false;
      continue;
    }
    const originMod = ctx.graph.modules.get(s.origin.originPath);
    if (!originMod) {
      allVerified = false;
      continue;
    }
    names.push(s.symbol);
    // What the declaration needs, following local helpers it references (they would move along).
    const imports = new Set<string>(s.origin.record.usesImports);
    const localName = s.origin.record.localName ?? s.symbol;
    const queue = [localName];
    const seenLocals = new Set(queue);
    while (queue.length > 0) {
      const d = originMod.declDeps[queue.pop()!];
      if (!d) continue;
      for (const i of d.imports) imports.add(i);
      for (const l of d.locals) if (!seenLocals.has(l)) { seenLocals.add(l); queue.push(l); }
    }
    const deps = new Set<string>();
    for (const local of imports) {
      for (const r of originMod.imports) {
        if (r.erased || r.kind === 'dynamic' || !r.resolvedPath || r.external) continue;
        if (r.specifiers.some((sp) => sp.local === local)) deps.add(r.resolvedPath);
      }
    }
    const blockers = [...deps].filter((d) => d === edge.from || reaches(ctx.adj, d, edge.from));
    if (blockers.length === 0) {
      details.push(`\`${s.symbol}\` (${s.origin.record.kind} in \`${rel(ctx, s.origin.originPath)}\`) depends on ${deps.size === 0 ? 'no other project file' : [...deps].map((d) => `\`${rel(ctx, d)}\``).join(', ')} – safe to extract.`);
    } else {
      allVerified = false;
      details.push(`\`${s.symbol}\` itself uses ${blockers.map((b) => `\`${rel(ctx, b)}\``).join(', ')}, which lead${blockers.length === 1 ? 's' : ''} back to \`${rel(ctx, edge.from)}\` – extracting it alone is not enough.`);
    }
  }
  if (names.length === 0) return null;
  const list = names.map((n) => `\`${n}\``).join(', ');
  const remaining = remainingImports(edge, new Set(names));
  const cycleStays = remaining.length > 0 && reaches(ctx.adj, edge.to, edge.from);
  if (allVerified && cycleStays) {
    details.push(`\`${rel(ctx, edge.from)}\` still imports ${remaining.map((r) => `\`${r}\``).join(', ')} from \`${rel(ctx, edge.to)}\`, so the import cycle itself remains (without this crash).`);
  }
  return {
    kind: 'move-symbol',
    text: allVerified
      ? `Move ${list} out of \`${rel(ctx, edge.to)}\` into a separate file and import it from there – verified to fix this crash${cycleStays ? '' : ' and remove this cycle'}.`
      : `Moving ${list} out of \`${rel(ctx, edge.to)}\` alone does not help (see details).`,
    verified: allVerified,
    details,
  };
};

/**
 * Project files the symbols imported over `edge` import themselves (following local helpers they
 * use), in source order – what a new file holding those symbols would still load.
 */
export const movedSymbolDependencies = (ctx: SuggestContext, edge: GraphEdge): string[] => {
  const deps: string[] = [];
  for (const s of edgeSymbolOrigins(ctx, edge)) {
    const originMod = s.origin ? ctx.graph.modules.get(s.origin.originPath) : undefined;
    if (!s.origin || !originMod) continue;
    const imports = new Set<string>(s.origin.record.usesImports);
    const queue = [s.origin.record.localName ?? s.symbol];
    const seenLocals = new Set(queue);
    while (queue.length > 0) {
      const d = originMod.declDeps[queue.pop()!];
      if (!d) continue;
      for (const i of d.imports) imports.add(i);
      for (const l of d.locals) if (!seenLocals.has(l)) { seenLocals.add(l); queue.push(l); }
    }
    for (const r of originMod.imports) {
      if (r.erased || r.kind === 'dynamic' || !r.resolvedPath || r.external || !ctx.graph.modules.has(r.resolvedPath)) continue;
      if (r.specifiers.some((sp) => imports.has(sp.local)) && !deps.includes(r.resolvedPath)) deps.push(r.resolvedPath);
    }
  }
  return deps;
};

/** Converting a static route reference into a lazy `loadComponent` removes the import edge entirely. */
const lazyRouteSuggestion = (ctx: SuggestContext, edge: GraphEdge): Suggestion | null => {
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      const u = s.usages.find((x) => x.timing === 'eager' && x.contextKind === 'top-level' && x.property === 'component');
      if (!u) continue;
      const symbol = s.imported === '*' ? `${s.local}.${u.member ?? ''}` : s.imported;
      const remaining = remainingImports(edge, new Set([s.imported === '*' ? (u.member ?? '') : s.imported]));
      const lazy = `\`loadComponent: () => import('${r.specifierText}').then(m => m.${symbol})\``;
      return {
        kind: 'lazy-route',
        text:
          remaining.length === 0
            ? `The route in \`${rel(ctx, edge.from)}\`:${u.line} references \`${symbol}\` eagerly. Use ${lazy} – the static import disappears and with it this cycle.`
            : `The route in \`${rel(ctx, edge.from)}\`:${u.line} references \`${symbol}\` eagerly. ${lazy} removes this read, but ${remaining.map((x) => `\`${x}\``).join(', ')} still keep${remaining.length === 1 ? 's' : ''} the static import – move ${remaining.length === 1 ? 'it' : 'them'} too to remove the cycle.`,
        verified: remaining.length === 0,
      };
    }
  }
  return null;
};

const angularSuggestion = (ctx: SuggestContext, edge: GraphEdge, failure: FailurePoint | null): Suggestion | null => {
  const best = failure ? { symbol: failure.symbol, usage: failure.usage } : strongestUsage(edge);
  if (!best || best.usage.timing !== 'eager') return null;
  const u = best.usage;
  const from = rel(ctx, edge.from);
  if (u.contextKind === 'decorator' && (u.decorator === 'Component' || u.decorator === 'Directive' || u.decorator === 'NgModule')) {
    if (u.property === 'imports' || u.property === 'declarations' || u.property === 'exports') {
      return {
        kind: 'forward-ref',
        text: `Wrap the reference in \`${from}\` as \`forwardRef(() => ${best.symbol})\` inside the \`${u.property}\` array – Angular then resolves the dependency lazily (compiler emits a closure). Recursive/mutual components need this.`,
        verified: true,
      };
    }
    if (u.property === 'providers' || u.property === 'viewProviders') {
      return {
        kind: 'lazy-injector',
        text: `\`${best.symbol}\` is referenced eagerly in the \`${u.property}\` array of @${u.decorator}() in \`${from}\`. Prefer \`@Injectable({ providedIn: 'root' })\` on the service, or provide it in a route/\`app.config.ts\` – the provider array is evaluated at class definition time.`,
        verified: false,
      };
    }
  }
  if (u.contextKind === 'decorator-metadata') {
    return {
      kind: 'decorator-metadata',
      text: `The eager reference comes from \`emitDecoratorMetadata\`: TypeScript emits the parameter/property type \`${best.symbol}\` as a value when the class definition in \`${from}\` runs. Set \`"emitDecoratorMetadata": false\` if no library needs runtime type metadata, or type that parameter with an interface (or \`import type\`) – the metadata then records \`Object\` instead. (\`@Inject(forwardRef(...))\` does not help: the type is still emitted.)`,
      verified: true,
    };
  }
  if (u.contextKind === 'extends') {
    return {
      kind: 'move-symbol',
      text: `\`class extends ${best.symbol}\` needs the base class at definition time. Move \`${best.symbol}\` into its own file that does not import \`${from}\` (directly or via a barrel).`,
      verified: false,
    };
  }
  return null;
};

/**
 * @param failures   load-time failures found on this cycle (may be empty)
 * @param breakable  edge keys (`from\0to`) whose eager usage could break under some load order;
 *                   used for order-dependent cycles without a concrete failure
 */
export const suggestForCycle = (ctx: SuggestContext, cycle: Cycle, failures: FailurePoint[], breakable: Set<string> = new Set()): Suggestion[] => {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion | null): void => {
    if (!s) return;
    const key = `${s.kind}:${s.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  const failingEdges = new Set(failures.map((f) => `${f.from}\0${f.to}`));
  const ordered = [...cycle.edges].sort((a, b) => {
    const fa = failingEdges.has(`${a.from}\0${a.to}`) ? 0 : 1;
    const fb = failingEdges.has(`${b.from}\0${b.to}`) ? 0 : 1;
    return fa - fb;
  });

  for (const edge of ordered) {
    const key = `${edge.from}\0${edge.to}`;
    const failure = failures.find((f) => f.from === edge.from && f.to === edge.to) ?? null;
    const toMod = ctx.graph.modules.get(edge.to);
    // Angular-specific hints only for edges that fail or could fail.
    if (failure || breakable.has(key)) push(angularSuggestion(ctx, edge, failure));
    push(lazyRouteSuggestion(ctx, edge));
    push(directImportSuggestion(ctx, edge));
    if ((failure || breakable.has(key)) && !toMod?.isBarrel) {
      const only = failure ? new Set(failures.filter((f) => f.from === edge.from && f.to === edge.to).map((f) => f.symbol)) : undefined;
      push(moveSymbolSuggestion(ctx, edge, only));
    }
  }

  // Prefer verified suggestions first.
  out.sort((a, b) => Number(b.verified) - Number(a.verified));

  if (out.length === 0 || !out.some((s) => s.verified)) {
    const eager = cycle.edges.filter((e) => e.usage === 'eager');
    if (eager.length === 0) {
      push({
        kind: 'no-action',
        text: 'All bindings in this cycle are used inside functions/methods/instance fields, so nothing is touched while modules load. It works today but will break as soon as one usage moves to top level – consider extracting the shared piece into a third module.',
        verified: false,
      });
    } else {
      push({
        kind: 'extract-shared',
        text: `Extract what both sides need into a new module that imports neither of them. Eager edges to break: ${eager.map((e) => `\`${rel(ctx, e.from)}\` → \`${rel(ctx, e.to)}\``).join(', ')}.`,
        verified: false,
      });
    }
  }
  return out;
};

export const suggestForDiCycle = (names: string[]): Suggestion[] => {
  const a = names[0] ?? 'A';
  const b = names[1] ?? 'B';
  return [
    {
      kind: 'di-restructure',
      text: `Angular cannot construct ${names.map((n) => `\`${n}\``).join(' → ')} → \`${a}\`: each needs the other during construction (NG0200). \`forwardRef\` and \`import type\` do not help here.`,
      verified: true,
      details: [
        `Extract the shared state/behaviour into a third service that both \`${a}\` and \`${b}\` inject.`,
        `Or resolve one side lazily: inject \`Injector\` and call \`this.injector.get(${b})\` inside the method that needs it (not in the constructor/field initializer).`,
        `Or invert one dependency with an event stream (Subject/signal) so that only one side knows the other.`,
      ],
    },
  ];
};
