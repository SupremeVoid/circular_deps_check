/**
 * Actionable, graph-verified suggestions for a cycle. Never proposes `import type` for value
 * usages: those imports are not the problem (type-only imports are already erased).
 */
import type { Cycle, FailurePoint, GraphEdge, ModuleGraph, Suggestion, Usage } from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';
import { reaches, type Adjacency } from './cycles.js';
import { relativeTo } from './util/paths.js';

export interface SuggestContext {
  graph: ModuleGraph;
  /** Runtime adjacency (non-erased, non-dynamic edges). */
  adj: Adjacency;
  exportCache: Map<string, ResolvedExport | null>;
}

const rel = (ctx: SuggestContext, p: string): string => relativeTo(ctx.graph.root, p);

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
  const lines = [...origins.entries()].map(([origin, syms]) => `import { ${syms.join(', ')} } from '${rel(ctx, origin)}'`);
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
    const deps = new Set<string>();
    for (const local of s.origin.record.usesImports) {
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
  return {
    kind: 'move-symbol',
    text: allVerified
      ? `Move ${list} out of \`${rel(ctx, edge.to)}\` into a separate file and import it from there – verified to remove this cycle.`
      : `Moving ${list} out of \`${rel(ctx, edge.to)}\` alone does not remove the cycle (see details).`,
    verified: allVerified,
    details,
  };
};

/** Converting a static route reference into a lazy `loadComponent` removes the import edge entirely. */
const lazyRouteSuggestion = (ctx: SuggestContext, edge: GraphEdge): Suggestion | null => {
  for (const r of edge.records) {
    if (r.erased || r.kind === 'dynamic') continue;
    for (const s of r.specifiers) {
      const u = s.usages.find((x) => x.timing === 'eager' && x.contextKind === 'top-level' && x.property === 'component');
      if (!u) continue;
      const symbol = s.imported === '*' ? `${s.local}.${u.member ?? ''}` : s.imported;
      return {
        kind: 'lazy-route',
        text: `The route in \`${rel(ctx, edge.from)}\`:${u.line} references \`${symbol}\` eagerly. Use \`loadComponent: () => import('${r.specifierText}').then(m => m.${symbol})\` – the static import disappears and with it this cycle.`,
        verified: true,
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
      text: `The only eager reference comes from \`emitDecoratorMetadata\` (constructor parameter type in \`${from}\`). Angular's AOT compiler does not need it: set \`"emitDecoratorMetadata": false\` in tsconfig, or annotate the parameter with \`@Inject(forwardRef(() => ${best.symbol}))\`.`,
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
