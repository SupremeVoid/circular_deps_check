/**
 * Core data model shared by parser, graph, analysis and reports.
 */

/** When (and whether) an imported binding is touched at runtime. */
export type UsageTiming =
  /** Used only in type positions -> erased by the compiler. */
  | 'type'
  /** Evaluated while the module body runs (top-level, extends, decorators, static fields...). */
  | 'eager'
  /** Evaluated later, inside a function/method/constructor/instance field. */
  | 'deferred';

export type UsageContextKind =
  | 'extends'
  | 'decorator'
  | 'decorator-metadata'
  | 'top-level'
  | 'top-level-call'
  | 'static-member'
  | 'enum-member'
  | 'namespace-body'
  | 'class-field'
  | 'function-body'
  | 'type';

export interface Usage {
  /** 1-based line */
  line: number;
  /** 1-based column */
  column: number;
  timing: UsageTiming;
  contextKind: UsageContextKind;
  /** Human readable description, e.g. "extends clause of class Foo". */
  context: string;
  /** Trimmed source line. */
  snippet: string;
  /** For namespace imports: the accessed member (`ns.member`). */
  member?: string;
  /** Name of the decorator when the usage sits inside a decorator argument. */
  decorator?: string;
  /** Nearest enclosing object literal property name (e.g. `providers`, `imports`, `component`). */
  property?: string;
}

export interface ImportSpecifierInfo {
  /** Exported name in the target module. `default` for default imports, `*` for namespace imports. */
  imported: string;
  /** Local binding name. */
  local: string;
  /** `import type` / `import { type X }` */
  typeOnly: boolean;
  usages: Usage[];
  /** Strongest usage timing across all usages (`unused` when never referenced). */
  effectiveTiming: UsageTiming | 'unused';
  /** The binding is re-exported (`export { X }`), which keeps the import alive without a usage. */
  reexported?: boolean;
}

export type ImportKind =
  | 'static'
  | 'reexport'
  | 'reexport-all'
  | 'side-effect'
  | 'dynamic'
  | 'require'
  | 'import-equals';

export interface ImportRecord {
  kind: ImportKind;
  /** The raw module specifier as written, e.g. `./foo` or `@app/shared`. */
  specifierText: string;
  /** Absolute normalized path of the resolved module or null when unresolved. */
  resolvedPath: string | null;
  /** True when the target lives outside the analyzed file set (node_modules, other project...). */
  external: boolean;
  line: number;
  column: number;
  /** Whole declaration is type-only (`import type ...` / `export type ... from`). */
  typeOnly: boolean;
  specifiers: ImportSpecifierInfo[];
  /**
   * True when the import is erased by TypeScript/esbuild: type-only, or every specifier is
   * unused/type-only under isolatedModules (and verbatimModuleSyntax is off).
   */
  erased: boolean;
  /** For dynamic imports: whether it is executed at module load (top-level await) or later. */
  dynamicAtTopLevel?: boolean;
  /** Names re-exported by this declaration (for reexport kinds). */
  reexportedNames?: { exported: string; imported: string }[];
}

export type ExportKind =
  | 'class'
  | 'function'
  | 'const'
  | 'let'
  | 'var'
  | 'enum'
  | 'type'
  | 'interface'
  | 'namespace'
  | 'reexport'
  | 'unknown';

export interface ExportRecord {
  /** The exported name (`default` for default exports). */
  name: string;
  kind: ExportKind;
  /** Function declarations are hoisted and initialised before any module body runs. */
  hoisted: boolean;
  line: number;
  /** For re-exports: resolved path of the source module (null if unresolved). */
  from?: string | null;
  /** For re-exports: name in the source module. */
  importedName?: string;
  /**
   * Local names of imported bindings referenced inside this declaration (symbol-level slice).
   * Used to verify "move symbol to its own file" suggestions.
   */
  usesImports: string[];
}

export interface DiDependencyFlags {
  optional?: boolean;
  self?: boolean;
  skipSelf?: boolean;
  host?: boolean;
}

export interface DiDependency {
  /** Token expression text as written (`UserService`, `APP_CONFIG`, `ns.Foo`). */
  token: string;
  line: number;
  column: number;
  via: 'constructor-param' | 'inject-field' | 'inject-constructor';
  flags: DiDependencyFlags;
}

export interface ProviderInfo {
  provide: string;
  line: number;
  useClass?: string;
  useExisting?: string;
  deps?: string[];
}

export type AngularDecoratorName = 'Injectable' | 'Component' | 'Directive' | 'Pipe' | 'NgModule';

export interface AngularClassInfo {
  name: string;
  line: number;
  decorator: AngularDecoratorName;
  providedIn?: string;
  deps: DiDependency[];
  providers: ProviderInfo[];
  /** Names listed in the `imports` array of a standalone component/NgModule. */
  imports: string[];
}

export interface ModuleInfo {
  /** Absolute normalized path. */
  path: string;
  /** Path relative to project root, using forward slashes. */
  relPath: string;
  imports: ImportRecord[];
  exports: ExportRecord[];
  /** Resolved paths of `export * from` targets (in source order). */
  exportStar: (string | null)[];
  angular: AngularClassInfo[];
  /** Consists only of re-exports (or is an index file that only re-exports). */
  isBarrel: boolean;
  loc: number;
  /** Top-level declaration names (exported or not), used to resolve DI tokens declared in the same file. */
  localClasses: string[];
  parseErrors: string[];
}

/** A directed edge between two analyzed files (all import records aggregated). */
export interface GraphEdge {
  from: string;
  to: string;
  records: ImportRecord[];
  /** Participates in the runtime module graph (not erased, not dynamic). */
  runtime: boolean;
  /** Only dynamic import() records. */
  dynamicOnly: boolean;
  /** Strongest binding usage across all records. */
  usage: UsageTiming | 'none';
  /** The target is a barrel and the edge only pulls re-exports. */
  viaBarrel: boolean;
}

export interface ModuleGraph {
  root: string;
  modules: Map<string, ModuleInfo>;
  /** from -> (to -> edge) */
  out: Map<string, Map<string, GraphEdge>>;
  /** to -> set(from) */
  in: Map<string, Set<string>>;
  externals: Set<string>;
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface Cycle {
  /** Nodes in cycle order; edges[i] goes nodes[i] -> nodes[(i+1) % n]. */
  nodes: string[];
  edges: GraphEdge[];
}

export interface Scc {
  id: number;
  nodes: string[];
  /** Number of runtime edges inside the SCC. */
  edgeCount: number;
  cycles: Cycle[];
  /** True when cycle enumeration was truncated. */
  truncated: boolean;
  /** Barrel files inside the SCC. */
  barrels: string[];
}

export type BindingState = 'initialised' | 'tdz' | 'undefined' | 'hoisted';

export interface FailingUsage {
  specifier: ImportSpecifierInfo;
  usage: Usage;
  /** Module where the binding is declared (after following re-exports). */
  originPath: string | null;
  originKind: ExportKind;
  /** State of the binding at the moment of the usage. */
  state: BindingState;
  /** Evaluation state of the origin module. */
  originState: 'in-progress' | 'not-started' | 'done';
}

export interface EdgeBreakage {
  from: string;
  to: string;
  /** Eager usages of not-yet-initialised bindings. */
  failing: FailingUsage[];
  /** Deferred usages of not-yet-initialised bindings (fine at load time). */
  deferredCount: number;
  /** Full evaluation chain from the entry to `from`; `to` appears on it as the in-progress ancestor. */
  chain: string[];
}

export interface EntryEvaluation {
  entry: string;
  kind: 'main' | 'test' | 'lazy';
  breakages: EdgeBreakage[];
  evaluatedCount: number;
}

export interface DiNode {
  id: string;
  name: string;
  path: string | null;
  line: number;
  decorator: AngularDecoratorName | 'token' | 'external';
}

export interface DiEdge {
  from: string;
  to: string;
  dep: DiDependency;
  fromPath: string;
}

export interface DiCycle {
  nodes: DiNode[];
  edges: DiEdge[];
  /** All edges are plain (no SkipSelf/Host) -> certainly NG0200. */
  certain: boolean;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingKind =
  | 'runtime-break'
  | 'test-break'
  | 'di-cycle'
  | 'latent-cycle'
  | 'deferred-cycle'
  | 'type-only-cycle';

export interface Suggestion {
  kind:
    | 'direct-import'
    | 'move-symbol'
    | 'forward-ref'
    | 'lazy-route'
    | 'lazy-injector'
    | 'di-restructure'
    | 'decorator-metadata'
    | 'extract-shared'
    | 'cut-edge'
    | 'no-action';
  text: string;
  /** The suggestion has been verified against the graph to actually remove the cycle. */
  verified: boolean;
  /** Extra detail lines. */
  details?: string[];
}

export interface FailurePoint {
  from: string;
  to: string;
  usage: Usage;
  symbol: string;
  originPath: string | null;
  originKind: ExportKind;
  state: BindingState;
  /** Entries under which this failure is triggered. */
  entries: { entry: string; kind: 'main' | 'test' | 'lazy'; chain: string[] }[];
}

export interface Finding {
  id: string;
  severity: Severity;
  kind: FindingKind;
  title: string;
  summary: string;
  sccId: number;
  cycle?: Cycle;
  diCycle?: DiCycle;
  failures: FailurePoint[];
  suggestions: Suggestion[];
  /** Cycle-level edge annotations for the report. */
  edgeNotes: EdgeNote[];
}

export interface EdgeNote {
  from: string;
  to: string;
  usage: UsageTiming | 'none';
  symbols: string[];
  viaBarrel: boolean;
  /** Strongest usage sample for display. */
  sample?: Usage & { symbol: string };
}

export interface AnalysisStats {
  files: number;
  loc: number;
  edges: number;
  runtimeEdges: number;
  erasedEdges: number;
  dynamicEdges: number;
  externals: number;
  unresolved: number;
  sccs: number;
  cyclicFiles: number;
  cycles: number;
  typeOnlyCycles: number;
  diCycles: number;
  entries: number;
  durationMs: number;
  phases: Record<string, number>;
}

export interface AnalysisResult {
  root: string;
  generatedAt: string;
  options: ResolvedOptionsSummary;
  stats: AnalysisStats;
  findings: Finding[];
  sccs: Scc[];
  typeOnlySccs: Scc[];
  entries: EntryEvaluation[];
  diCycles: DiCycle[];
  graph: ModuleGraph;
  /** Greedy feedback-arc-set style plan per SCC. */
  fixPlans: FixPlan[];
}

export interface FixPlan {
  sccId: number;
  /** Ordered edges whose removal makes the SCC acyclic (greedy). */
  cuts: { from: string; to: string; symbols: string[]; usage: UsageTiming | 'none'; reason: string }[];
  verified: boolean;
}

export interface ResolvedOptionsSummary {
  tsconfig: string | null;
  include: string[];
  exclude: string[];
  entries: string[];
  testEntries: string[];
  emitDecoratorMetadata: boolean;
  verbatimModuleSyntax: boolean;
}
