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
  /** Angular (ngtsc) constructor-parameter type: referenced as a value inside the generated `ɵfac` factory. */
  | 'di-factory'
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
  /** The binding is invoked here (`x()`, `new x()`, tagged template), not just read. */
  call?: boolean;
  /**
   * Property read on the binding (`X.prop`, `X['prop']`); for a call this is the invoked static
   * method. `'*'` means every member is read (`Object.keys(ns)`, `{ ...ns }`, `const { a, b } = ns`
   * records the individual members instead).
   */
  access?: string;
  /** The read only happens under an assumption the analysis cannot prove (e.g. a `.forEach` receiver that may not be an array). */
  assumed?: string;
  /** Callee of a decorator factory call (`@Register('x')`): the returned decorator also runs at class definition. */
  decoratorFactory?: boolean;
  /** Namespace imports: `ns.Member.method()` is called here – `method` is the invoked static method of `Member`. */
  staticCall?: string;
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
  /** Where the declaration ends: the binding is initialised only once the whole declaration has run. */
  endLine?: number;
  endColumn?: number;
  /** Name of the top-level declaration in this module that backs the export (absent for re-exports / `export default expr`). */
  localName?: string;
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

/** Top-level declaration of a module (exported or not). */
export interface TopLevelDecl {
  kind: ExportKind;
  line: number;
  /** Where the declaration ends (a class with static initialisers or a multi-line initialiser is not ready before). */
  endLine?: number;
  endColumn?: number;
}

/**
 * What a top-level function (or class constructor) touches when it is called: module-level
 * bindings of its own file and imported bindings, referenced directly in its body (nested
 * callbacks that are not invoked immediately are excluded to avoid false positives).
 */
export interface FootprintRef {
  line: number;
  call: boolean;
  /** Inside a branch (if/else, ternary, &&, ||, ??, switch case, catch) – may not run on every call. */
  conditional?: boolean;
  /** Read inside a callback that is only assumed to run synchronously. */
  assumed?: string;
  /** Namespace imports: `ns.Member.method()` – the invoked static method. */
  method?: string;
  /** The base class of an instantiated class: its constructor and fields run, but the binding itself is not read again. */
  inherit?: boolean;
}

export interface Footprint {
  line: number;
  imports: (FootprintRef & { local: string; member?: string })[];
  locals: (FootprintRef & { name: string; member?: string })[];
  /** A static getter / object-literal getter: merely reading the property runs it. */
  getter?: boolean;
  /** References inside a function the callee returns (followed for decorator factories: the result is applied at once). */
  returned: { imports: (FootprintRef & { local: string; member?: string })[]; locals: (FootprintRef & { name: string; member?: string })[] };
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
  via: 'constructor-param' | 'inject-field' | 'inject-constructor' | 'provider' | 'token-factory';
  flags: DiDependencyFlags;
  /** Trimmed source line of the injection. */
  snippet?: string;
}

export interface ProviderInfo {
  provide: string;
  line: number;
  /** Trimmed source line of the provider. */
  snippet?: string;
  useClass?: string;
  useExisting?: string;
  /** `deps: [...]` entries and tokens passed to `inject()` inside `useFactory`. */
  deps?: { token: string; flags: DiDependencyFlags }[];
}

export type AngularDecoratorName = 'Injectable' | 'Component' | 'Directive' | 'Pipe' | 'NgModule' | 'InjectionToken';

export interface AngularClassInfo {
  name: string;
  line: number;
  /** `none`: undecorated class that injects something – only relevant as a base class. */
  decorator: AngularDecoratorName | 'none';
  providedIn?: string;
  /** Own dependencies: constructor parameters, `inject()` in field initializers / constructor / parameter defaults. */
  deps: DiDependency[];
  /** `providers` / `viewProviders` of a component, directive or NgModule (scoped to that injector). */
  providers: ProviderInfo[];
  /** `@Injectable({ useClass | useExisting | useFactory })`: how the class's own token is created. */
  selfProvider?: ProviderInfo;
  /** Names listed in the `imports` array of a standalone component/NgModule. */
  imports: string[];
  /** Base class expression (`extends X`) – Angular inherits its factory and field injections. */
  extends?: string;
  hasConstructor: boolean;
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
  /** Top-level declarations by name with their kind and line (for initialisation-state checks). */
  topLevel: Record<string, TopLevelDecl>;
  /** Footprints of top-level functions, arrow-function constants and classes (by local name). */
  footprints: Record<string, Footprint>;
  /** Value dependencies of each top-level declaration: imports and other top-level declarations it references. */
  declDeps: Record<string, { imports: string[]; locals: string[] }>;
  /** Providers declared outside decorators (`app.config.ts`, `bootstrapApplication`, routes) – root scope. */
  rootProviders: ProviderInfo[];
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

/** One hop of a load-time call chain into another module's function. */
export interface CallStep {
  /** Function (or class) being called. */
  fn: string;
  /** Module declaring it. */
  path: string;
  /** Line inside that function where the next hop / the failing read happens. */
  line: number;
}

export type EntryKind = 'main' | 'test' | 'lazy' | 'hypothetical';

export interface FailingUsage {
  specifier: ImportSpecifierInfo;
  usage: Usage;
  /** Name of the binding that is not initialised (differs from the import when reached through a call chain). */
  binding: string;
  /** Call chain from the usage into the function(s) that read the uninitialised binding. */
  via?: CallStep[];
  /** Set when the failure depends on something the analysis cannot prove (branch, assumed callback, opaque module). */
  uncertain?: string;
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
  kind: EntryKind;
  /** The real entry point this evaluation belongs to (for a lazy chunk: the app entry that leads to it). */
  root: string;
  breakages: EdgeBreakage[];
  evaluatedCount: number;
  /** First file of each cyclic group (by group id) that this evaluation loaded – it alone fixes the group's internal order. */
  gateways: Map<number, string>;
}

export interface DiNode {
  id: string;
  name: string;
  path: string | null;
  line: number;
  decorator: AngularDecoratorName | 'none' | 'token' | 'external';
  /** Injector the node lives in: `root`, or the component/directive whose `providers` declare it. */
  scope?: string;
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
  /** Crashes when loaded from the app entry or a lazy chunk. */
  | 'runtime-break'
  /** Crashes only when a spec file is the entry. */
  | 'test-break'
  /** Reached in a real load order, but whether the read runs depends on something the analysis cannot prove. */
  | 'possible-break'
  | 'di-cycle'
  /**
   * Works in every current load order; reads that would crash if another file of the cyclic group
   * were imported first (proven by replaying that order). One finding per cyclic group.
   */
  | 'latent-cycle'
  /** Runtime import cycle that cannot crash under any load order (one finding per cyclic group). */
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
  /** The imported symbol used at `usage`. */
  symbol: string;
  /** The binding that is not initialised (equals `symbol` unless reached through a call chain). */
  binding: string;
  via?: CallStep[];
  /** The crash is possible but not certain (reason). */
  uncertain?: string;
  originPath: string | null;
  originKind: ExportKind;
  state: BindingState;
  /**
   * Identity of this read that survives a re-run after unrelated edits: file, symbol, binding and
   * declaring file – no line numbers (`#n` distinguishes repeated reads of the same binding).
   */
  key: string;
  /** Entries under which this failure is triggered. */
  entries: { entry: string; kind: EntryKind; chain: string[] }[];
  /** Order-dependent reads only: number of files that, imported first, trigger it (`entries` keeps three examples). */
  triggerCount?: number;
}

export interface Finding {
  /** Display id of this run (`C1`, `C2` … by severity); changes when findings appear or disappear. */
  id: string;
  /** Identity that survives a re-run: the import (crashes), the group (cycles) or the services (DI). */
  key: string;
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
  /** For `latent-cycle`: how today's entry points enter the group (the reason nothing crashes). */
  enteredThrough?: GroupGateway[];
}

/** A file through which real entry points first reach a cyclic group. */
export interface GroupGateway {
  file: string;
  /** Number of app entries / lazy chunks / spec files whose load reaches the group through `file` first. */
  main: number;
  lazy: number;
  test: number;
}

export interface EdgeNote {
  from: string;
  to: string;
  usage: UsageTiming | 'none';
  symbols: string[];
  viaBarrel: boolean;
  /** Strongest usage sample for display. */
  sample?: Usage & { symbol: string };
  /** The import statement(s) behind the edge, written on one line each. */
  imports: { line: number; text: string }[];
  /** The lines that use the imported bindings: load-time reads first, at most six. */
  uses: (Usage & { symbol: string })[];
  /** Further usages not listed in `uses`. */
  moreUses: number;
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
  /** Hypothetical load orders replayed (one per file of each cyclic group). */
  replayedOrders: number;
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
  /** Absolute paths of the real entry points that were replayed. */
  entryFiles: { main: string[]; test: string[] };
}

export interface FixPlan {
  sccId: number;
  /** Ordered edges whose removal (or barrel rewiring) makes the SCC acyclic (greedy). */
  cuts: {
    from: string;
    to: string;
    symbols: string[];
    usage: UsageTiming | 'none';
    /** rewire-barrel: import from the declaring files; drop-reexport: barrel re-export; move-code / remove-import: break the dependency. */
    action: 'rewire-barrel' | 'drop-reexport' | 'move-code' | 'remove-import';
    /** For rewire-barrel: the declaring files the import is redirected to. */
    rewiredTo?: string[];
    /** For a symbol that moves to a new file: the project files it imports itself – its new home still loads them. */
    loadsInstead?: string[];
    reason: string;
  }[];
  verified: boolean;
  /** Result of replaying every real entry point with the cuts applied (only for groups that crash today). */
  preview?: FixPreview;
}

/** A read that fails when the real entry points are replayed with a (partial) fix applied. */
export interface PreviewFailure {
  from: string;
  line: number;
  column: number;
  symbol: string;
  binding: string;
  sccId: number;
  /** One real entry under which it fails. */
  entry: string;
  entryKind: EntryKind;
  uncertain?: string;
  /** Finding that already lists this read (e.g. as order-dependent, or as a crash that only specs hit today). */
  knownAs?: string;
  knownKind?: FindingKind;
}

/** State after applying `cuts[0..i]` of a fix plan. */
export interface FixPreviewStep {
  /** Findings whose crash no longer occurs. */
  resolved: string[];
  /** Reads of this group that still fail under a real entry. */
  remaining: PreviewFailure[];
  /** Reads that did not fail before and fail now, because the change altered the load order. */
  exposed: PreviewFailure[];
}

export interface FixPreview {
  /** False when the plan could not be replayed (reason given). */
  simulated: boolean;
  reason?: string;
  /** One step per cut, cumulative. */
  steps: FixPreviewStep[];
  /** Real entry points replayed per step. */
  entries: number;
  /** Spec files that load the changed files but were left out to keep the replay cheap (app entries only). */
  skippedTests?: number;
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
