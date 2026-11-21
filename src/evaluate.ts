/**
 * ES module evaluation-order simulation.
 *
 * ESM links the whole module graph first (all bindings exist, function declarations are already
 * initialised) and then evaluates modules depth-first in the order of their module requests
 * (`import` and `export … from` declarations, in source order). A module's body runs only after
 * every requested module is either done or still in progress (= an ancestor on the current
 * evaluation path, i.e. a cycle). While a body has not run, its `class`/`const`/`let` bindings are
 * in the temporal dead zone (ReferenceError) and its `var`/`enum`/`namespace` bindings are
 * `undefined` (that is also what bundlers such as esbuild produce for hoisted declarations).
 *
 * The evaluator replays exactly that order and, at the moment each module body runs, checks every
 * eager read of an imported binding – following barrels to the declaring module and following
 * load-time calls into other modules' functions – against the evaluation state at that moment.
 */
import type {
  BindingState,
  CallStep,
  EdgeBreakage,
  EntryEvaluation,
  EntryKind,
  ExportKind,
  FailingUsage,
  FootprintRef,
  ImportRecord,
  ImportSpecifierInfo,
  ModuleGraph,
  Usage,
} from './types.js';
import { resolveExport, type ResolvedExport } from './graph.js';

type EvalState = 0 | 1 | 2; // unvisited | in progress | done

/** Readable name for a file outside the analysed set (package name for node_modules). */
const shortPath = (p: string): string => {
  const i = p.lastIndexOf('/node_modules/');
  if (i >= 0) return p.slice(i + '/node_modules/'.length).replace(/(\/index)?\.d\.ts$/, '');
  return p.split('/').slice(-3).join('/');
};

const MAX_CALL_DEPTH = 8;
/** Safety net for the number of lazy-chunk replays per app entry (distinct load contexts). */
const MAX_LAZY_RUNS = 5000;

/**
 * "What if" changes to the import graph, used to replay the load order with a fix applied.
 * Keys are `from` + NUL + `to` (absolute paths).
 */
export interface EvalOverrides {
  /** The import no longer exists: its symbols were moved to a file outside the cycle (or it was dropped). */
  removed?: Set<string>;
  /** A barrel import replaced by direct imports of the declaring files; the bindings are still read. */
  rewired?: Map<string, string[]>;
  /** Files loaded in place of a removed import: what the new home of a moved symbol imports itself. */
  added?: Map<string, string[]>;
}

export interface EvaluatorOptions {
  overrides?: EvalOverrides;
  /** Cyclic group id per file: lets each evaluation record through which file it entered a group. */
  groupOf?: Map<string, number>;
}

export const edgeKey = (from: string, to: string): string => `${from}\0${to}`;

export const bindingStateFor = (kind: ExportKind, hoisted: boolean): BindingState => {
  if (hoisted || kind === 'function') return 'hoisted';
  if (kind === 'var' || kind === 'enum' || kind === 'namespace') return 'undefined';
  return 'tdz';
};

const isTypeKind = (k: ExportKind): boolean => k === 'type' || k === 'interface';

/** `export * as ns from './x'` – a namespace object exists from link time on. */
const isNamespaceReexport = (r: ResolvedExport): boolean => r.record.importedName === '*' && r.record.from !== undefined;

interface BodyCheck {
  /** Module whose body is running. */
  module: string;
  /** Evaluation path from the root to `module` (inclusive). */
  path: string[];
  state: Map<string, EvalState>;
}

export class Evaluator {
  /** Ordered runtime module requests per module (deduplicated). */
  private readonly requests = new Map<string, string[]>();
  private readonly dynamicTargets = new Map<string, string[]>();
  private readonly exportCache = new Map<string, ResolvedExport | null>();
  private readonly removed: Set<string> | undefined;
  private readonly rewired: Map<string, string[]> | undefined;
  private readonly groupOf: Map<string, number> | undefined;

  constructor(private readonly graph: ModuleGraph, opts: EvaluatorOptions = {}) {
    this.removed = opts.overrides?.removed;
    this.rewired = opts.overrides?.rewired;
    this.groupOf = opts.groupOf;
    const rewired = this.rewired;
    const added = opts.overrides?.added;
    for (const mod of graph.modules.values()) {
      const list: string[] = [];
      const dyn: string[] = [];
      const request = (to: string): void => {
        if (to !== mod.path && !this.removed?.has(edgeKey(mod.path, to)) && !list.includes(to)) list.push(to);
      };
      const sorted = [...mod.imports].sort((a, b) => a.line - b.line || a.column - b.column);
      for (const record of sorted) {
        const to = record.resolvedPath;
        if (!to || to === mod.path) continue;
        if (record.external || !graph.modules.has(to)) {
          // Files outside the analysed set (packages, excluded or generated files) are opaque leaf
          // modules: their content is unknown, but *when* they load is part of the order.
          if (record.kind !== 'dynamic' && !record.erased && !list.includes(to)) list.push(to);
          continue;
        }
        if (record.kind === 'dynamic') {
          if (!dyn.includes(to)) dyn.push(to);
          continue;
        }
        if (record.erased) continue;
        const direct = rewired?.get(edgeKey(mod.path, to));
        if (!direct) {
          request(to);
          // a removed import whose symbol moved to a new file: that file loads the symbol's own imports here
          if (this.removed?.has(edgeKey(mod.path, to))) for (const d of added?.get(edgeKey(mod.path, to)) ?? []) request(d);
          continue;
        }
        // Each import statement is rewritten in place: it now loads the files declaring *its* names.
        for (const re of record.kind === 'reexport' ? (record.reexportedNames ?? []) : []) {
          const origin = re.imported === '*' ? undefined : resolveExport(graph, to, re.imported, this.exportCache)?.originPath;
          if (origin && direct.includes(origin)) request(origin);
        }
        for (const spec of record.specifiers) {
          if (spec.effectiveTiming === 'unused' || spec.effectiveTiming === 'type') continue;
          const names = spec.imported === '*' ? [...new Set(spec.usages.map((u) => u.member).filter((m): m is string => Boolean(m)))] : [spec.imported];
          for (const n of names) {
            const origin = resolveExport(graph, to, n, this.exportCache)?.originPath;
            if (origin && direct.includes(origin)) request(origin);
          }
        }
      }
      this.requests.set(mod.path, list);
      this.dynamicTargets.set(mod.path, dyn);
    }
  }

  /**
   * Evaluate starting at `entry`.
   *
   * For app entries, every dynamic `import()` target found on the way is evaluated as a lazy chunk
   * – each one on its own copy of the state its parent left behind. A lazy chunk can be the first
   * one a user loads (deep link), so it must not profit from modules that only a sibling chunk
   * would have loaded: fewer loaded modules can only add failures, never remove one. A chunk that
   * can be reached along several paths is replayed for every path that leaves different modules
   * loaded (and so are the chunks below it).
   *
   * Spec entries and hypothetical entries do not follow `import()`: nothing guarantees that a test
   * ever triggers it, and what could go wrong inside the chunk is covered by the hypothetical
   * replay of the cyclic groups it touches.
   */
  evaluateEntry(entry: string, kind: EntryKind): EntryEvaluation[] {
    const first = this.run(entry, kind, entry, new Map());
    const results = [first.evaluation];
    if (kind !== 'main') return results;

    const lazyByEntry = new Map<string, EntryEvaluation>();
    // States each chunk has already been replayed on. A replay on a superset of one of them cannot
    // find anything new (in the chunk or in the chunks below it), so it is skipped; anything else –
    // the same chunk reached along another path with other modules loaded – is replayed again.
    const replayedOn = new Map<string, Map<string, EvalState>[]>();
    const covers = (small: Map<string, EvalState>, big: Map<string, EvalState>): boolean => {
      if (small.size > big.size) return false;
      for (const k of small.keys()) if (!big.has(k)) return false;
      return true;
    };
    // Breadth-first: shallow contexts (fewest modules loaded) come first and prune the deeper ones.
    const queue: { target: string; state: Map<string, EvalState> }[] = first.lazy.map((target) => ({ target, state: first.state }));
    for (let runs = 0; queue.length > 0 && runs < MAX_LAZY_RUNS; ) {
      const item = queue.shift()!;
      if ((item.state.get(item.target) ?? 0) !== 0) continue; // already loaded in this context
      const earlier = replayedOn.get(item.target) ?? [];
      if (earlier.some((s) => covers(s, item.state))) continue;
      replayedOn.set(item.target, [...earlier, item.state]);
      runs++;
      const r = this.run(item.target, 'lazy', entry, new Map(item.state));
      const known = lazyByEntry.get(item.target);
      if (known) mergeEvaluation(known, r.evaluation);
      else {
        lazyByEntry.set(item.target, r.evaluation);
        results.push(r.evaluation);
      }
      for (const target of r.lazy) queue.push({ target, state: r.state });
    }
    return results;
  }

  /** One depth-first evaluation from `root` on top of `state` (mutated). */
  private run(root: string, kind: EntryKind, realRoot: string, state: Map<string, EvalState>): { evaluation: EntryEvaluation; state: Map<string, EvalState>; lazy: string[] } {
    const byEdge = new Map<string, EdgeBreakage>();
    const gateways = new Map<number, string>();
    const lazy: string[] = [];
    let evaluated = 0;
    const stack: { node: string; i: number }[] = [];
    const path: string[] = [];
    const enter = (n: string): void => {
      state.set(n, 1);
      stack.push({ node: n, i: 0 });
      path.push(n);
      const group = this.groupOf?.get(n);
      if (group !== undefined && !gateways.has(group)) gateways.set(group, n);
      for (const d of this.dynamicTargets.get(n) ?? []) if (!lazy.includes(d)) lazy.push(d);
    };
    if ((state.get(root) ?? 0) === 0) enter(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const reqs = this.requests.get(frame.node) ?? [];
      if (frame.i < reqs.length) {
        const to = reqs[frame.i++]!;
        if ((state.get(to) ?? 0) === 0) enter(to);
        continue;
      }
      // All requests are done or in progress: the module body runs now.
      this.checkBody({ module: frame.node, path: [...path], state }, byEdge);
      stack.pop();
      path.pop();
      state.set(frame.node, 2);
      if (this.graph.modules.has(frame.node)) evaluated++;
    }
    return { evaluation: { entry: root, kind, root: realRoot, breakages: [...byEdge.values()], evaluatedCount: evaluated, gateways }, state, lazy };
  }

  /**
   * What-if: is the import `from → to` gone? With `declaredIn`, also true for a binding that came
   * through a rewired barrel import whose new direct import of the declaring file was cut as well.
   */
  private isCut(from: string, to: string, declaredIn?: string): boolean {
    if (!this.removed) return false;
    if (this.removed.has(edgeKey(from, to))) return true;
    return declaredIn !== undefined && this.rewired?.has(edgeKey(from, to)) === true && this.removed.has(edgeKey(from, declaredIn));
  }

  /** Is the binding `decl` of `origin` initialised while `ctx.module`'s body is at the position of `at`? */
  private initialised(origin: string, decl: { line: number; endLine?: number; endColumn?: number }, kind: ExportKind, hoisted: boolean, at: Usage, ctx: BodyCheck): boolean {
    if (hoisted || kind === 'function') return true;
    const st = ctx.state.get(origin) ?? 0;
    if (st === 2) return true;
    // The running module itself (reached back through a barrel or a called function): a declaration
    // has run once its *end* lies before the read – a class is not initialised inside its own static
    // initialisers, a `const` not inside its own multi-line initialiser.
    if (origin !== ctx.module) return false;
    if (decl.endLine === undefined) return decl.line < at.line;
    return decl.endLine < at.line || (decl.endLine === at.line && (decl.endColumn ?? Infinity) <= at.column);
  }

  private isGetter(path: string, member: string): boolean {
    return this.graph.modules.get(path)?.footprints[member]?.getter === true;
  }

  /**
   * `export * as ns from './x'`: the namespace object always exists, but `ns.member` reads a binding
   * of `x`. Returns the binding to check, or null when nothing can be said.
   */
  private throughNamespace(resolved: ResolvedExport, member: string | undefined): { resolved: ResolvedExport; name: string } | null {
    if (!member || member === '*') return null;
    const inner = resolveExport(this.graph, resolved.originPath, member, this.exportCache);
    if (!inner || isNamespaceReexport(inner)) return null;
    return { resolved: inner, name: member };
  }

  private originState(origin: string, ctx: BodyCheck): FailingUsage['originState'] {
    const st = ctx.state.get(origin) ?? 0;
    return st === 2 ? 'done' : st === 1 ? 'in-progress' : 'not-started';
  }

  private checkBody(ctx: BodyCheck, byEdge: Map<string, EdgeBreakage>): void {
    const mod = this.graph.modules.get(ctx.module);
    if (!mod) return;
    for (const record of mod.imports) {
      const to = record.resolvedPath;
      if (!to || record.external || record.erased || !this.graph.modules.has(to) || to === ctx.module) continue;
      if (record.kind !== 'static' && record.kind !== 'import-equals') continue;
      if (this.isCut(ctx.module, to)) continue; // what-if: these symbols no longer come from the cycle
      for (const spec of record.specifiers) {
        for (const usage of spec.usages) {
          if (usage.timing === 'type') continue;
          const member = spec.imported === '*' ? usage.member : spec.imported;
          if (member === undefined) continue; // namespace object itself exists from link time
          // `Object.keys(ns)` / `{ ...ns }` read every exported binding.
          const names = member === '*' ? this.allExportNames(to) : [member];
          for (const exported of names) {
            let name = exported;
            let resolved = resolveExport(this.graph, to, name, this.exportCache);
            const failing: FailingUsage[] = [];
            if (!resolved) {
              // Re-exported from a file outside the analysed set: its content is unknown, but if it
              // has not even loaded yet the read cannot succeed (reported as uncertain).
              const opaque = usage.timing === 'eager' ? this.opaqueOrigin(to, name, ctx) : null;
              if (opaque) {
                failing.push({ specifier: spec, usage, binding: name, originPath: opaque.path, originKind: 'unknown', state: 'tdz', originState: 'not-started', uncertain: opaque.reason });
                this.edge(byEdge, ctx, record).failing.push(...failing);
              }
              continue;
            }
            let viaNamespace = false;
            if (isNamespaceReexport(resolved)) {
              const inner = spec.imported === '*' ? null : this.throughNamespace(resolved, usage.access);
              if (!inner) continue;
              ({ resolved, name } = inner);
              viaNamespace = true;
            }
            if (isTypeKind(resolved.record.kind)) continue;
            const { originPath, record: exp } = resolved;
            if (this.isCut(ctx.module, to, originPath)) continue;
            if (!this.initialised(originPath, exp, exp.kind, exp.hoisted, usage, ctx)) {
              if (usage.timing === 'eager') {
                failing.push({
                  specifier: spec,
                  usage,
                  binding: name,
                  originPath,
                  originKind: exp.kind,
                  state: bindingStateFor(exp.kind, exp.hoisted),
                  originState: this.originState(originPath, ctx),
                  uncertain: usage.assumed,
                });
              } else {
                this.edge(byEdge, ctx, record).deferredCount++;
              }
            } else if (usage.timing === 'eager') {
              // A load-time call into another module: what the called function reads must be ready too.
              // `Imported.staticMethod()` / `ns.Member.staticMethod()` follow the static method, and
              // reading `Imported.prop` runs `prop` when it is a getter.
              const local = exp.localName ?? name;
              const method = spec.imported === '*' ? usage.staticCall : viaNamespace ? undefined : usage.access;
              const member = method && method !== '*' ? `${local}.${method}` : undefined;
              if (usage.call) {
                this.followCall(originPath, member ?? local, usage, spec, ctx, [], new Set(), failing, usage.assumed, usage.decoratorFactory === true);
              } else if (member && this.isGetter(originPath, member)) {
                this.followCall(originPath, member, usage, spec, ctx, [], new Set(), failing, usage.assumed);
              }
            }
            if (failing.length > 0) {
              this.edge(byEdge, ctx, record).failing.push(...failing);
              if (member === '*') break; // one uninitialised binding is enough to make the enumeration throw
            }
          }
        }
      }
    }
  }

  private edge(byEdge: Map<string, EdgeBreakage>, ctx: BodyCheck, record: ImportRecord): EdgeBreakage {
    const key = record.resolvedPath!;
    let b = byEdge.get(`${ctx.module}\0${key}`);
    if (!b) {
      b = { from: ctx.module, to: key, failing: [], deferredCount: 0, chain: ctx.path };
      byEdge.set(`${ctx.module}\0${key}`, b);
    }
    return b;
  }

  /**
   * `fn` (declared in `origin`) is called while `ctx.module`'s body runs. Check every module-level
   * binding the function reads directly (its own file's and imported ones) and follow further calls.
   */
  private followCall(
    origin: string,
    fn: string,
    usage: Usage,
    spec: ImportSpecifierInfo,
    ctx: BodyCheck,
    steps: CallStep[],
    visited: Set<string>,
    out: FailingUsage[],
    uncertain?: string,
    includeReturned = false,
  ): void {
    if (steps.length >= MAX_CALL_DEPTH) return;
    const key = `${origin}#${fn}`;
    if (visited.has(key)) return;
    visited.add(key);
    const omod = this.graph.modules.get(origin);
    const fp = omod?.footprints[fn];
    if (!omod || !fp) return;

    const why = (ref: FootprintRef): string | undefined =>
      uncertain ?? (ref.conditional ? `the read sits in a branch of \`${fn}()\` that may not run on this call` : ref.assumed);
    const fail = (binding: string, bindingOrigin: string, kind: ExportKind, hoisted: boolean, ref: FootprintRef): void => {
      out.push({
        specifier: spec,
        usage,
        binding,
        via: [...steps, { fn, path: origin, line: ref.line }],
        originPath: bindingOrigin,
        originKind: kind,
        state: bindingStateFor(kind, hoisted),
        originState: this.originState(bindingOrigin, ctx),
        uncertain: why(ref),
      });
    };
    // A decorator factory's returned function is applied immediately at class definition.
    const locals = includeReturned ? [...fp.locals, ...fp.returned.locals] : fp.locals;
    const imports = includeReturned ? [...fp.imports, ...fp.returned.imports] : fp.imports;

    for (const loc of locals) {
      const decl = omod.topLevel[loc.name];
      if (!decl || isTypeKind(decl.kind)) continue;
      if (!this.initialised(origin, decl, decl.kind, false, usage, ctx)) {
        // An uninitialised *base class* is not read here: the `extends` clause already failed on it,
        // and a class that could not be defined has no inherited constructor to run.
        if (!loc.inherit) fail(loc.name, origin, decl.kind, false, loc);
      } else if (loc.call || (loc.member !== undefined && this.isGetter(origin, `${loc.name}.${loc.member}`))) {
        this.followCall(origin, loc.member ? `${loc.name}.${loc.member}` : loc.name, usage, spec, ctx, [...steps, { fn, path: origin, line: loc.line }], visited, out, why(loc));
      }
    }

    for (const imp of imports) {
      const found = this.findBinding(omod.imports, imp.local);
      if (!found) continue;
      const { record, spec: ospec } = found;
      const to = record.resolvedPath;
      if (!to || record.external || record.erased || record.kind === 'dynamic' || !this.graph.modules.has(to)) continue;
      if (this.isCut(origin, to)) continue;
      let name = ospec.imported === '*' ? imp.member : ospec.imported;
      if (name === undefined) continue;
      let resolved = resolveExport(this.graph, to, name, this.exportCache);
      if (!resolved) continue;
      let viaNamespace = false;
      if (isNamespaceReexport(resolved)) {
        const inner = ospec.imported === '*' ? null : this.throughNamespace(resolved, imp.member);
        if (!inner) continue;
        ({ resolved, name } = inner);
        viaNamespace = true;
      }
      if (isTypeKind(resolved.record.kind)) continue;
      if (this.isCut(origin, to, resolved.originPath)) continue;
      const exp = resolved.record;
      if (!this.initialised(resolved.originPath, exp, exp.kind, exp.hoisted, usage, ctx)) {
        if (!imp.inherit) fail(name, resolved.originPath, exp.kind, exp.hoisted, imp);
      } else if (imp.call || (!viaNamespace && ospec.imported !== '*' && imp.member !== undefined && this.isGetter(resolved.originPath, `${exp.localName ?? name}.${imp.member}`))) {
        const local = exp.localName ?? name;
        const method = ospec.imported === '*' ? imp.method : viaNamespace ? undefined : imp.member;
        const next = method ? `${local}.${method}` : local;
        this.followCall(resolved.originPath, next, usage, spec, ctx, [...steps, { fn, path: origin, line: imp.line }], visited, out, why(imp));
      }
    }
  }

  /**
   * `name` is not declared inside the analysed set. If `path` (or a barrel it re-exports through)
   * names a file outside the set as its source and that file has not loaded yet, the read fails.
   */
  private opaqueOrigin(path: string, name: string, ctx: BodyCheck, seen = new Set<string>()): { path: string; reason: string } | null {
    if (seen.has(path)) return null;
    seen.add(path);
    const mod = this.graph.modules.get(path);
    if (!mod) return null;
    const re = mod.exports.find((e) => e.name === name && e.kind === 'reexport' && e.from && !this.graph.modules.has(e.from));
    if (re?.from) {
      return (ctx.state.get(re.from) ?? 0) === 2
        ? null
        : { path: re.from, reason: `\`${name}\` is re-exported from \`${shortPath(re.from)}\` (outside the analysed files), which has not loaded yet at this point` };
    }
    for (const star of mod.exportStar) {
      if (!star) continue;
      if (this.graph.modules.has(star)) {
        const inner = this.opaqueOrigin(star, name, ctx, seen);
        if (inner) return inner;
      } else if ((ctx.state.get(star) ?? 0) !== 2) {
        return { path: star, reason: `\`${name}\` probably comes from \`export * from '${shortPath(star)}'\` (outside the analysed files), which has not loaded yet at this point` };
      }
    }
    return null;
  }

  /** Every name exported by `path`, including names reached through `export *` (inside the analysed set). */
  private allExportNames(path: string, seen = new Set<string>()): string[] {
    if (seen.has(path)) return [];
    seen.add(path);
    const mod = this.graph.modules.get(path);
    if (!mod) return [];
    const names = new Set(mod.exports.map((e) => e.name));
    for (const star of mod.exportStar) if (star) for (const n of this.allExportNames(star, seen)) if (n !== 'default') names.add(n);
    return [...names];
  }

  private findBinding(records: ImportRecord[], local: string): { record: ImportRecord; spec: ImportSpecifierInfo } | null {
    for (const record of records) {
      for (const spec of record.specifiers) if (spec.local === local) return { record, spec };
    }
    return null;
  }
}

/** Stable identity of a failing read inside one importing file. */
export const failingKey = (f: FailingUsage): string => `${f.usage.line}:${f.usage.column}\0${f.binding}\0${(f.via ?? []).map((s) => `${s.path}#${s.fn}`).join('>')}`;

/** Fold a second replay of the same lazy chunk (reached through another parent) into the first. */
const mergeEvaluation = (into: EntryEvaluation, other: EntryEvaluation): void => {
  for (const b of other.breakages) {
    const mine = into.breakages.find((x) => x.from === b.from && x.to === b.to);
    if (!mine) {
      into.breakages.push(b);
      continue;
    }
    const have = new Set(mine.failing.map(failingKey));
    for (const f of b.failing) if (!have.has(failingKey(f))) mine.failing.push(f);
    mine.deferredCount = Math.max(mine.deferredCount, b.deferredCount);
  }
  into.evaluatedCount = Math.max(into.evaluatedCount, other.evaluatedCount);
  for (const [group, file] of other.gateways) if (!into.gateways.has(group)) into.gateways.set(group, file);
};

export const evaluateAll = (graph: ModuleGraph, mainEntries: string[], testEntries: string[], opts: EvaluatorOptions = {}): EntryEvaluation[] => {
  const ev = new Evaluator(graph, opts);
  const out: EntryEvaluation[] = [];
  for (const e of mainEntries) out.push(...ev.evaluateEntry(e, 'main'));
  for (const e of testEntries) out.push(...ev.evaluateEntry(e, 'test'));
  return out;
};

/**
 * Replay the load order once per file of each cyclic group, as if that file were the first of the
 * group to be imported (by a new spec, a new feature, a reordered barrel …). Within a strongly
 * connected group the entry file alone determines the evaluation order, so this enumerates every
 * reachable order and proves whether a cycle can crash at all.
 */
export const evaluateHypothetical = (graph: ModuleGraph, groups: string[][]): EntryEvaluation[] => {
  const ev = new Evaluator(graph);
  const out: EntryEvaluation[] = [];
  for (const group of groups) for (const node of group) out.push(...ev.evaluateEntry(node, 'hypothetical'));
  return out;
};
