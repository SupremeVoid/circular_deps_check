import ts from 'typescript';
import type {
  AngularClassInfo,
  AngularDecoratorName,
  DiDependency,
  DiDependencyFlags,
  ExportKind,
  ExportRecord,
  Footprint,
  ImportRecord,
  ImportSpecifierInfo,
  ModuleInfo,
  ProviderInfo,
  TopLevelDecl,
  Usage,
  UsageContextKind,
  UsageTiming,
} from './types.js';
import type { ModuleResolver } from './resolver.js';
import { relativeTo } from './util/paths.js';

export interface ParseContext {
  root: string;
  resolver: ModuleResolver;
  emitDecoratorMetadata: boolean;
  verbatimModuleSyntax: boolean;
  /** `const enum` members are only inlined across files when isolatedModules is off. */
  isolatedModules?: boolean;
  angular: boolean;
}

interface WalkCtx {
  timing: UsageTiming;
  kind: UsageContextKind;
  desc: string;
  /** Inside a type position. */
  typePos: boolean;
  decorator?: string;
  property?: string;
  /** Name of the exported top-level declaration being walked (for symbol-level slices). */
  declName?: string;
  /** Footprint collection mode: record references into this footprint instead of usages. */
  footprint?: Footprint;
  /** Footprint mode: inside a branch that may not run. */
  conditional?: boolean;
  /** Footprint mode: inside a function returned by the walked function. */
  fpReturned?: boolean;
  /** The code only runs now under an assumption (reason shown to the user). */
  assumed?: string;
}

const ANGULAR_ALL_DECORATORS: ReadonlySet<string> = new Set([
  'Injectable', 'Component', 'Directive', 'Pipe', 'NgModule', 'Input', 'Output', 'HostBinding', 'HostListener',
  'ViewChild', 'ViewChildren', 'ContentChild', 'ContentChildren', 'Inject', 'Optional', 'Self', 'SkipSelf', 'Host', 'Attribute',
]);

const ANGULAR_DECORATORS: ReadonlySet<string> = new Set([
  'Injectable',
  'Component',
  'Directive',
  'Pipe',
  'NgModule',
]);

const TIMING_RANK: Record<UsageTiming, number> = { type: 0, deferred: 1, eager: 2 };

const strongerTiming = (a: UsageTiming | 'unused', b: UsageTiming): UsageTiming =>
  a === 'unused' || TIMING_RANK[b] > TIMING_RANK[a] ? b : a;

const scriptKindFor = (file: string): ts.ScriptKind => {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
};

/**
 * Parse a single TypeScript source file into a ModuleInfo: imports with usage classification,
 * exports with declaration kinds, and Angular DI metadata.
 */
export const parseModule = (filePath: string, source: string, ctx: ParseContext): ModuleInfo => {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const parser = new FileParser(sf, filePath, ctx);
  return parser.run();
};

class FileParser {
  private readonly imports: ImportRecord[] = [];
  private readonly exports: ExportRecord[] = [];
  private readonly exportStar: (string | null)[] = [];
  private readonly angular: AngularClassInfo[] = [];
  private readonly localClasses: string[] = [];
  private readonly parseErrors: string[] = [];
  /** local binding name -> specifier info + owning record */
  private readonly bindings = new Map<string, { record: ImportRecord; spec: ImportSpecifierInfo }>();
  private readonly exportByDecl = new Map<string, ExportRecord[]>();
  private readonly scopes: Set<string>[] = [];
  private readonly lineStarts: readonly number[];
  private readonly lines: string[] | null = null;
  private hasOwnDeclarations = false;
  private hasReexports = false;
  /** Local functions/classes invoked in an eager context (module load). */
  private readonly eagerInvoked = new Set<string>();
  private readonly localCallables = new Map<string, ts.Node>();
  /** Keys of `localCallables` that are getters (`Class.prop` / `obj.prop`): reading the property runs them. */
  private readonly getters = new Set<string>();
  private readonly topLevel: Record<string, TopLevelDecl> = {};
  private readonly declDeps: Record<string, { imports: string[]; locals: string[] }> = {};
  private readonly rootProviders: ProviderInfo[] = [];
  private readonly footprints: Record<string, Footprint> = {};
  private readonly visitedEager = new Set<string>();
  /** de-dup usages by position per specifier */
  private readonly usageIndex = new Map<ImportSpecifierInfo, Map<string, Usage>>();

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly filePath: string,
    private readonly ctx: ParseContext,
  ) {
    this.lineStarts = sf.getLineStarts();
  }

  run(): ModuleInfo {
    for (const stmt of this.sf.statements) this.collectImportsAndExports(stmt);
    this.finishLocalExports();

    const top: WalkCtx = { timing: 'eager', kind: 'top-level', desc: 'top-level statement', typePos: false };
    for (const stmt of this.sf.statements) this.walkTopLevel(stmt, top);

    this.propagateEagerCalls();
    this.computeFootprints();

    for (const record of this.imports) {
      for (const spec of record.specifiers) {
        spec.usages.sort((a, b) => a.line - b.line || a.column - b.column);
        spec.effectiveTiming = spec.usages.reduce<UsageTiming | 'unused'>(
          (acc, u) => strongerTiming(acc, u.timing),
          'unused',
        );
      }
      record.erased = this.isErased(record);
    }

    if (this.ctx.angular) {
      for (const stmt of this.sf.statements) {
        if (ts.isClassDeclaration(stmt)) this.extractAngular(stmt);
        else if (ts.isVariableStatement(stmt)) this.extractInjectionTokens(stmt);
      }
      this.collectRootProviders();
    }

    const isBarrel = this.hasReexports && !this.hasOwnDeclarations;

    return {
      path: this.filePath,
      relPath: relativeTo(this.ctx.root, this.filePath),
      imports: this.imports,
      exports: this.exports,
      exportStar: this.exportStar,
      angular: this.angular,
      isBarrel,
      loc: this.lineStarts.length,
      localClasses: this.localClasses,
      topLevel: this.topLevel,
      footprints: this.footprints,
      declDeps: this.declDeps,
      rootProviders: this.rootProviders,
      parseErrors: this.parseErrors,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Pass 1: imports / exports
  // ---------------------------------------------------------------------------------------------

  private resolve(spec: string): { path: string | null; external: boolean } {
    return this.ctx.resolver.resolve(spec, this.filePath);
  }

  private pos(node: ts.Node): { line: number; column: number } {
    const lc = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    return { line: lc.line + 1, column: lc.character + 1 };
  }

  /** Start and end of a declaration: its binding is initialised when the end is reached, not before. */
  private span(node: ts.Node): { line: number; endLine: number; endColumn: number } {
    const end = this.sf.getLineAndCharacterOfPosition(node.getEnd());
    return { line: this.pos(node).line, endLine: end.line + 1, endColumn: end.character + 1 };
  }

  private makeRecord(
    kind: ImportRecord['kind'],
    specifierText: string,
    node: ts.Node,
    typeOnly: boolean,
  ): ImportRecord {
    const res = this.resolve(specifierText);
    const { line, column } = this.pos(node);
    const record: ImportRecord = {
      kind,
      specifierText,
      resolvedPath: res.path,
      external: res.external || (res.path === null && this.ctx.resolver.isExternalPackage(specifierText)),
      line,
      column,
      typeOnly,
      specifiers: [],
      erased: typeOnly,
    };
    this.imports.push(record);
    return record;
  }

  private addSpecifier(record: ImportRecord, imported: string, local: string, typeOnly: boolean): void {
    const spec: ImportSpecifierInfo = {
      imported,
      local,
      typeOnly: typeOnly || record.typeOnly,
      usages: [],
      effectiveTiming: 'unused',
    };
    record.specifiers.push(spec);
    this.bindings.set(local, { record, spec });
  }

  private collectImportsAndExports(stmt: ts.Statement): void {
    if (ts.isImportDeclaration(stmt)) {
      const specText = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const clause = stmt.importClause;
      if (!clause) {
        this.makeRecord('side-effect', specText, stmt, false);
        return;
      }
      const typeOnly = Boolean(clause.isTypeOnly);
      const record = this.makeRecord('static', specText, stmt, typeOnly);
      if (clause.name) this.addSpecifier(record, 'default', clause.name.text, typeOnly);
      const nb = clause.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) {
          this.addSpecifier(record, '*', nb.name.text, typeOnly);
        } else {
          for (const el of nb.elements) {
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            this.addSpecifier(record, imported, el.name.text, typeOnly || Boolean(el.isTypeOnly));
          }
        }
      }
      return;
    }

    if (ts.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        const record = this.makeRecord('import-equals', ref.expression.text, stmt, Boolean(stmt.isTypeOnly));
        this.addSpecifier(record, '*', stmt.name.text, Boolean(stmt.isTypeOnly));
      }
      return;
    }

    if (ts.isExportDeclaration(stmt)) {
      const typeOnly = Boolean(stmt.isTypeOnly);
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const specText = stmt.moduleSpecifier.text;
        this.hasReexports = true;
        if (!stmt.exportClause) {
          const record = this.makeRecord('reexport-all', specText, stmt, typeOnly);
          this.exportStar.push(record.resolvedPath);
          return;
        }
        if (ts.isNamespaceExport(stmt.exportClause)) {
          const record = this.makeRecord('reexport', specText, stmt, typeOnly);
          record.reexportedNames = [{ exported: stmt.exportClause.name.text, imported: '*' }];
          this.exports.push({
            name: stmt.exportClause.name.text,
            kind: 'reexport',
            hoisted: false,
            line: record.line,
            from: record.resolvedPath,
            importedName: '*',
            usesImports: [],
          });
          return;
        }
        const record = this.makeRecord('reexport', specText, stmt, typeOnly);
        record.reexportedNames = [];
        for (const el of stmt.exportClause.elements) {
          const imported = el.propertyName ? el.propertyName.text : el.name.text;
          const exported = el.name.text;
          record.reexportedNames.push({ exported, imported });
          this.exports.push({
            name: exported,
            kind: typeOnly || el.isTypeOnly ? 'type' : 'reexport',
            hoisted: false,
            line: record.line,
            from: record.resolvedPath,
            importedName: imported,
            usesImports: [],
          });
        }
        return;
      }
      // `export { a, b as c }` of local or imported bindings — resolved in pass 2 (after locals known).
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const localName = el.propertyName ? el.propertyName.text : el.name.text;
          const exported = el.name.text;
          const line = this.pos(el).line;
          this.deferredLocalExports.push({ localName, exported, line, typeOnly: typeOnly || Boolean(el.isTypeOnly) });
        }
      }
      return;
    }

    if (ts.isExportAssignment(stmt)) {
      // `export default expr` or `export = expr`
      const line = this.pos(stmt).line;
      if (stmt.isExportEquals) {
        this.exports.push({ name: 'default', kind: 'unknown', hoisted: false, line, usesImports: [] });
      } else {
        this.exports.push({ name: 'default', kind: 'const', hoisted: false, line, usesImports: [] });
      }
      this.hasOwnDeclarations = true;
      return;
    }

    // Declarations
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    const isDefault = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    const isDeclare = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));

    if (ts.isClassDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      const name = stmt.name?.text ?? 'default';
      this.localClasses.push(name);
      this.localCallables.set(name, stmt);
      for (const m of stmt.members) {
        const isStatic = ts.canHaveModifiers(m) && Boolean(ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword));
        if (isStatic && ts.isMethodDeclaration(m) && m.body && m.name && ts.isIdentifier(m.name)) this.localCallables.set(`${name}.${m.name.text}`, m);
        if (isStatic && ts.isGetAccessor(m) && m.body && ts.isIdentifier(m.name)) {
          this.localCallables.set(`${name}.${m.name.text}`, m);
          this.getters.add(`${name}.${m.name.text}`);
        }
      }
      this.topLevel[name] = { kind: isDeclare ? 'type' : 'class', ...this.span(stmt) };
      if (isExported) this.addExport(isDefault ? 'default' : name, isDeclare ? 'type' : 'class', false, stmt, name);
      return;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      const name = stmt.name?.text ?? 'default';
      this.localClasses.push(name);
      if (stmt.body) this.localCallables.set(name, stmt); // overload signatures have no body
      this.topLevel[name] = { kind: isDeclare ? 'type' : 'function', line: this.topLevel[name]?.line ?? this.pos(stmt).line };
      if (isExported && !this.exportByDecl.has(name)) this.addExport(isDefault ? 'default' : name, isDeclare ? 'type' : 'function', !isDeclare, stmt, name);
      return;
    }
    if (ts.isVariableStatement(stmt)) {
      this.hasOwnDeclarations = true;
      const flags = stmt.declarationList.flags;
      const kind: ExportKind =
        flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const decl of stmt.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) {
          this.localClasses.push(name);
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            this.localCallables.set(name, decl.initializer);
          }
          // `export const Utils = { make() { … }, get value() { … }, run: () => … }` – a singleton with methods.
          if (ts.isIdentifier(decl.name) && decl.initializer) this.collectObjectMethods(name, decl.initializer);
          this.topLevel[name] = { kind: isDeclare ? 'type' : kind, ...this.span(decl) };
          if (isExported) this.addExport(name, isDeclare ? 'type' : kind, false, decl, name);
        }
      }
      return;
    }
    if (ts.isEnumDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      this.localClasses.push(stmt.name.text);
      // `const enum` members are inlined across files by a full-program emit (isolatedModules off),
      // so importers never reference the enum object; with isolatedModules the import and the
      // runtime member access stay (verified against tsc 5.9 emit).
      const isConstEnum = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ConstKeyword));
      this.topLevel[stmt.name.text] = { kind: isDeclare ? 'type' : 'enum', ...this.span(stmt) };
      if (isExported) this.addExport(stmt.name.text, isDeclare || (isConstEnum && !this.ctx.isolatedModules) ? 'type' : 'enum', false, stmt, stmt.name.text);
      return;
    }
    if (ts.isInterfaceDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      if (isExported) this.addExport(stmt.name.text, 'interface', false, stmt, stmt.name.text);
      return;
    }
    if (ts.isTypeAliasDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      if (isExported) this.addExport(stmt.name.text, 'type', false, stmt, stmt.name.text);
      return;
    }
    if (ts.isModuleDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      const name = ts.isIdentifier(stmt.name) ? stmt.name.text : stmt.name.text;
      this.localClasses.push(name);
      // Namespaces that contain only types emit nothing.
      const instantiated = !isDeclare && (ts as unknown as { getModuleInstanceState(n: ts.Node): number }).getModuleInstanceState(stmt) !== 0;
      this.topLevel[name] = { kind: instantiated ? 'namespace' : 'type', ...this.span(stmt) };
      if (isExported) this.addExport(name, instantiated ? 'namespace' : 'type', false, stmt, name);
      return;
    }
    if (!ts.isEmptyStatement(stmt)) {
      // expression statements, if/for/try at top level, etc.
      this.hasOwnDeclarations = true;
    }
  }

  private collectObjectMethods(name: string, init: ts.Expression): void {
    let obj = init;
    while (ts.isParenthesizedExpression(obj) || ts.isAsExpression(obj) || ts.isSatisfiesExpression(obj)) obj = obj.expression;
    if (!ts.isObjectLiteralExpression(obj)) return;
    for (const p of obj.properties) {
      if (!p.name || !ts.isIdentifier(p.name)) continue;
      const key = `${name}.${p.name.text}`;
      if (ts.isMethodDeclaration(p) && p.body) this.localCallables.set(key, p);
      else if (ts.isGetAccessor(p) && p.body) {
        this.localCallables.set(key, p);
        this.getters.add(key);
      } else if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) this.localCallables.set(key, p.initializer);
    }
  }

  private readonly deferredLocalExports: { localName: string; exported: string; line: number; typeOnly: boolean }[] = [];

  private addExport(name: string, kind: ExportKind, hoisted: boolean, node: ts.Node, declName: string): void {
    const rec: ExportRecord = { name, kind, hoisted, ...this.span(node), localName: declName, usesImports: [] };
    this.exports.push(rec);
    const list = this.exportByDecl.get(declName) ?? [];
    list.push(rec);
    this.exportByDecl.set(declName, list);
  }

  private finishLocalExports(): void {
    for (const d of this.deferredLocalExports) {
      const binding = this.bindings.get(d.localName);
      if (binding) {
        // The import is kept as a live re-export; it must not be treated as unused/erased.
        if (!d.typeOnly) binding.spec.reexported = true;
        this.exports.push({
          name: d.exported,
          kind: d.typeOnly ? 'type' : 'reexport',
          hoisted: false,
          line: d.line,
          from: binding.record.resolvedPath,
          importedName: binding.spec.imported,
          usesImports: [],
        });
        this.hasReexports = true;
        continue;
      }
      const local = this.exportByDecl.get(d.localName)?.[0];
      const kind = local?.kind ?? this.localKind(d.localName);
      const rec: ExportRecord = {
        name: d.exported,
        kind: d.typeOnly ? 'type' : kind,
        hoisted: kind === 'function',
        line: this.topLevel[d.localName]?.line ?? d.line,
        endLine: this.topLevel[d.localName]?.endLine,
        endColumn: this.topLevel[d.localName]?.endColumn,
        localName: d.localName,
        usesImports: [],
      };
      this.exports.push(rec);
      const list = this.exportByDecl.get(d.localName) ?? [];
      list.push(rec);
      this.exportByDecl.set(d.localName, list);
    }
  }

  private localKind(name: string): ExportKind {
    const node = this.localCallables.get(name);
    if (node) {
      if (ts.isClassDeclaration(node)) return 'class';
      if (ts.isFunctionDeclaration(node)) return 'function';
      return 'const';
    }
    for (const stmt of this.sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (bindingNames(decl.name).includes(name)) {
            const flags = stmt.declarationList.flags;
            return flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
          }
        }
      }
      if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) return 'enum';
      if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return 'interface';
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return 'type';
      if (ts.isModuleDeclaration(stmt) && stmt.name.text === name) return 'namespace';
    }
    return 'unknown';
  }

  // ---------------------------------------------------------------------------------------------
  // Pass 2: usage classification
  // ---------------------------------------------------------------------------------------------

  private walkTopLevel(stmt: ts.Statement, top: WalkCtx): void {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) return;
    if (ts.isExportDeclaration(stmt)) return; // pure re-exports, no evaluation of bindings

    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isDeclare = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));
    if (isDeclare) {
      this.walk(stmt, { ...top, typePos: true, timing: 'type', kind: 'type', desc: 'ambient declaration' });
      return;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const names = bindingNames(decl.name);
        const declName = names[0];
        const kw = stmt.declarationList.flags & ts.NodeFlags.Const ? 'const' : stmt.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
        const ctx: WalkCtx = {
          ...top,
          desc: `top-level \`${kw} ${names.join(', ')}\` initializer`,
          declName,
        };
        if (decl.type) this.walk(decl.type, { ...ctx, typePos: true, timing: 'type', kind: 'type' });
        if (decl.initializer && !this.walkNamespaceDestructuring(decl, ctx)) this.walk(decl.initializer, ctx);
      }
      return;
    }
    if (ts.isExportAssignment(stmt)) {
      this.walk(stmt.expression, { ...top, desc: stmt.isExportEquals ? '`export =` expression' : '`export default` expression', declName: 'default' });
      return;
    }
    if (ts.isClassDeclaration(stmt)) {
      this.walkClass(stmt, { ...top, declName: stmt.name?.text ?? 'default' });
      return;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      this.walkFunctionLike(stmt, { ...top, declName: stmt.name?.text ?? 'default' }, false);
      return;
    }
    if (ts.isEnumDeclaration(stmt)) {
      this.walk(stmt, { ...top, kind: 'enum-member', desc: `enum \`${stmt.name.text}\` member initializer`, declName: stmt.name.text });
      return;
    }
    if (ts.isModuleDeclaration(stmt)) {
      this.walk(stmt, { ...top, kind: 'namespace-body', desc: `namespace \`${stmt.name.text}\` body (runs at module load)`, declName: stmt.name.text });
      return;
    }
    if (ts.isExpressionStatement(stmt)) {
      this.walk(stmt, { ...top, desc: 'top-level expression statement' });
      return;
    }
    this.walk(stmt, { ...top, desc: 'top-level statement' });
  }

  private walk(node: ts.Node, ctx: WalkCtx): void {
    if ((ctx.footprint || (ctx.timing === 'eager' && !ctx.typePos)) && this.walkControlFlow(node, ctx)) return;
    // Instantiation expression `Foo<string>` (TS 4.7+) is a value reference despite being a TypeNode.
    if (!ctx.typePos && ts.isExpressionWithTypeArguments(node) && !ts.isHeritageClause(node.parent)) {
      this.walk(node.expression, ctx);
      for (const ta of node.typeArguments ?? []) this.walk(ta, { ...ctx, typePos: true, timing: 'type', kind: 'type' });
      return;
    }
    // Type positions -------------------------------------------------------------------------
    if (!ctx.typePos && (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeParameterDeclaration(node))) {
      // ExpressionWithTypeArguments in an `extends` clause of a class is a value; handled in walkClass.
      const typeCtx: WalkCtx = { ...ctx, typePos: true, timing: 'type', kind: 'type' };
      ts.forEachChild(node, (child) => this.walk(child, typeCtx));
      return;
    }

    switch (node.kind) {
      case ts.SyntaxKind.Identifier:
        this.onIdentifier(node as ts.Identifier, ctx);
        return;

      case ts.SyntaxKind.PropertyAccessExpression: {
        const pa = node as ts.PropertyAccessExpression;
        if (ts.isIdentifier(pa.expression)) {
          // reading a local getter at load time runs it
          const getter = `${pa.expression.text}.${pa.name.text}`;
          if (!ctx.footprint && ctx.timing === 'eager' && !ctx.typePos && this.getters.has(getter) && !this.isShadowed(pa.expression.text)) this.eagerInvoked.add(getter);
          this.onIdentifier(pa.expression, ctx, pa.name.text);
        } else {
          this.walk(pa.expression, ctx);
        }
        // pa.name is not a usage
        return;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const ea = node as ts.ElementAccessExpression;
        if (ts.isIdentifier(ea.expression)) {
          const member = ts.isStringLiteral(ea.argumentExpression) ? ea.argumentExpression.text : undefined;
          this.onIdentifier(ea.expression, ctx, member);
        } else {
          this.walk(ea.expression, ctx);
        }
        this.walk(ea.argumentExpression, ctx);
        return;
      }
      case ts.SyntaxKind.QualifiedName: {
        // only reachable in type positions handled above; treat left-most as usage
        const qn = node as ts.QualifiedName;
        this.walk(qn.left, ctx);
        return;
      }

      case ts.SyntaxKind.PropertyAssignment: {
        const pa = node as ts.PropertyAssignment;
        const propName = ts.isIdentifier(pa.name) || ts.isStringLiteral(pa.name) ? pa.name.text : undefined;
        if (ts.isComputedPropertyName(pa.name)) this.walk(pa.name.expression, ctx);
        this.walk(pa.initializer, propName ? { ...ctx, property: propName } : ctx);
        return;
      }
      case ts.SyntaxKind.ShorthandPropertyAssignment: {
        const sp = node as ts.ShorthandPropertyAssignment;
        this.onIdentifier(sp.name, ctx);
        return;
      }
      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
      case ts.SyntaxKind.Constructor:
      case ts.SyntaxKind.ClassStaticBlockDeclaration:
        // Only reached for object-literal methods/accessors (class members go through walkClass)
        if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
          this.walkFunctionLike(node, ctx, false);
          return;
        }
        break;

      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
        this.walkFunctionLike(node as ts.SignatureDeclaration, ctx, isIife(node) || syncCallbackOf(node) !== null);
        return;

      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
        this.walkClass(node as ts.ClassLikeDeclaration, ctx);
        return;

      case ts.SyntaxKind.Decorator: {
        const dec = node as ts.Decorator;
        const name = decoratorName(dec);
        const decCtx: WalkCtx = ctx.timing === 'deferred' ? ctx : { ...ctx, timing: 'eager', kind: 'decorator', desc: name ? `@${name}() decorator argument` : 'decorator expression', decorator: name ?? ctx.decorator };
        ts.forEachChild(dec, (child) => this.walk(child, decCtx));
        return;
      }

      case ts.SyntaxKind.CallExpression: {
        const call = node as ts.CallExpression;
        if (ctx.footprint) {
          // Footprint mode: records/invocations were already collected by the main walk.
          if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return;
          ts.forEachChild(call, (child) => this.walk(child, ctx));
          return;
        }
        if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
          this.onDynamicImport(call, ctx);
          ts.forEachChild(call, (child) => this.walk(child, ctx));
          return;
        }
        if (ts.isIdentifier(call.expression)) {
          if (call.expression.text === 'require' && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
            this.onRequire(call, ctx);
            return;
          }
          if (ctx.timing === 'eager' && !ctx.typePos && this.localCallables.has(call.expression.text)) {
            this.eagerInvoked.add(call.expression.text);
          }
        }
        // `[1, 2].forEach(localFn)` – a local function passed by reference to a synchronous array method runs now
        if (ctx.timing === 'eager' && !ctx.typePos && ts.isPropertyAccessExpression(call.expression) && SYNC_CALLBACK_METHODS.has(call.expression.name.text)) {
          for (const arg of call.arguments) if (ts.isIdentifier(arg) && this.localCallables.has(arg.text) && !this.isShadowed(arg.text)) this.eagerInvoked.add(arg.text);
        }
        if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) && ctx.timing === 'eager' && !ctx.typePos) {
          // `LocalClass.staticMethod()` at load time
          const key = `${call.expression.expression.text}.${call.expression.name.text}`;
          if (this.localCallables.has(key) && !this.isShadowed(call.expression.expression.text)) this.eagerInvoked.add(key);
        }
        ts.forEachChild(call, (child) => this.walk(child, ctx));
        return;
      }
      case ts.SyntaxKind.NewExpression: {
        const ne = node as ts.NewExpression;
        if (!ctx.footprint && ts.isIdentifier(ne.expression) && ctx.timing === 'eager' && !ctx.typePos && this.localCallables.has(ne.expression.text)) {
          this.eagerInvoked.add(ne.expression.text);
        }
        ts.forEachChild(ne, (child) => this.walk(child, ctx));
        return;
      }

      case ts.SyntaxKind.VariableDeclaration: {
        const vd = node as ts.VariableDeclaration;
        // name is a declaration, not a usage (but binding pattern defaults are expressions)
        this.walkBindingName(vd.name, ctx);
        if (vd.type) this.walk(vd.type, ctx);
        if (vd.initializer && !this.walkNamespaceDestructuring(vd, ctx)) this.walk(vd.initializer, ctx);
        return;
      }
      case ts.SyntaxKind.Parameter: {
        const p = node as ts.ParameterDeclaration;
        for (const d of ts.getDecorators(p) ?? []) this.walk(d, ctx);
        this.walkBindingName(p.name, ctx);
        if (p.type) this.walk(p.type, ctx);
        if (p.initializer) this.walk(p.initializer, ctx);
        return;
      }
      case ts.SyntaxKind.BindingElement: {
        const be = node as ts.BindingElement;
        if (be.propertyName && ts.isComputedPropertyName(be.propertyName)) this.walk(be.propertyName.expression, ctx);
        this.walkBindingName(be.name, ctx);
        if (be.initializer) this.walk(be.initializer, ctx);
        return;
      }
      case ts.SyntaxKind.EnumMember: {
        const em = node as ts.EnumMember;
        if (ts.isComputedPropertyName(em.name)) this.walk(em.name.expression, ctx);
        if (em.initializer) this.walk(em.initializer, ctx);
        return;
      }
      case ts.SyntaxKind.LabeledStatement:
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement: {
        const ls = node as ts.LabeledStatement | ts.BreakStatement | ts.ContinueStatement;
        if (ts.isLabeledStatement(ls)) this.walk(ls.statement, ctx);
        return;
      }
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.CaseBlock: {
        const declared = collectBlockDeclarations(node);
        if (declared.size > 0) this.scopes.push(declared);
        // After `if (cached) return x;` (or a conditional throw/break/continue) the rest of the block
        // only runs when that exit was not taken.
        let cur = ctx;
        const branching = Boolean(ctx.footprint) || (ctx.timing === 'eager' && !ctx.typePos);
        ts.forEachChild(node, (child) => {
          this.walk(child, cur);
          if (branching && cur === ctx && mayExitEarly(child)) cur = this.inBranch(ctx);
        });
        if (declared.size > 0) this.scopes.pop();
        return;
      }
      case ts.SyntaxKind.CatchClause: {
        const cc = node as ts.CatchClause;
        const declared = new Set<string>();
        if (cc.variableDeclaration) for (const n of bindingNames(cc.variableDeclaration.name)) declared.add(n);
        this.scopes.push(declared);
        // a catch block only runs when something threw
        this.walk(cc.block, ctx.footprint || (ctx.timing === 'eager' && !ctx.typePos) ? this.inBranch(ctx) : ctx);
        this.scopes.pop();
        return;
      }
      case ts.SyntaxKind.JsxAttribute:
      case ts.SyntaxKind.JsxText:
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NumericLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
        return;
      default:
        break;
    }
    ts.forEachChild(node, (child) => this.walk(child, ctx));
  }

  /** `const { a, b: c, ...rest } = ns` reads the members `a`, `b` (and all of them for `...rest`). */
  private walkNamespaceDestructuring(vd: ts.VariableDeclaration, ctx: WalkCtx): boolean {
    const init = vd.initializer;
    if (!init || !ts.isIdentifier(init) || !ts.isObjectBindingPattern(vd.name)) return false;
    if (this.bindings.get(init.text)?.spec.imported !== '*' || this.isShadowed(init.text)) return false;
    for (const el of vd.name.elements) {
      const prop = el.propertyName ?? el.name;
      const member = el.dotDotDotToken ? '*' : ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : undefined;
      this.onIdentifier(init, ctx, member);
    }
    return true;
  }

  /** The context for code that only runs if a condition holds: such a read is possible, not certain. */
  private inBranch(ctx: WalkCtx): WalkCtx {
    if (ctx.footprint) return { ...ctx, conditional: true };
    return ctx.assumed ? ctx : { ...ctx, assumed: 'the read sits in a branch that may not run when the module loads' };
  }

  /**
   * Code in branches may not run (`if (lazy) return A;`, `isBrowser ? A : null`, `a ?? B`) – while
   * a module loads just as on a call of a function. In footprint mode additionally: a returned
   * function only runs if the caller invokes the result (decorator factories do).
   */
  private walkControlFlow(node: ts.Node, ctx: WalkCtx): boolean {
    const cond = this.inBranch(ctx);
    if (ts.isIfStatement(node)) {
      this.walk(node.expression, ctx);
      this.walk(node.thenStatement, cond);
      if (node.elseStatement) this.walk(node.elseStatement, cond);
      return true;
    }
    if (ts.isConditionalExpression(node)) {
      this.walk(node.condition, ctx);
      this.walk(node.whenTrue, cond);
      this.walk(node.whenFalse, cond);
      return true;
    }
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      const logical = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];
      if (logical.includes(k)) {
        this.walk(node.left, ctx);
        this.walk(node.right, cond);
        return true;
      }
      return false;
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      ts.forEachChild(node, (child) => this.walk(child, cond));
      return true;
    }
    if (ctx.footprint && ts.isReturnStatement(node) && node.expression && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) && !ctx.fpReturned) {
      this.walkFunctionLike(node.expression, { ...ctx, fpReturned: true }, true);
      return true;
    }
    return false;
  }

  private walkBindingName(name: ts.BindingName, ctx: WalkCtx): void {
    if (ts.isIdentifier(name)) return;
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) this.walk(el, ctx);
    }
  }

  private walkFunctionLike(fn: ts.SignatureDeclaration | ts.FunctionLikeDeclaration, ctx: WalkCtx, iife: boolean): void {
    // Footprints only cover code that runs when the function itself runs: skip nested callbacks.
    if (ctx.footprint && !iife) return;
    const fnBody = (fn as ts.FunctionLikeDeclaration).body;
    if (ctx.footprint && !ctx.fpReturned && fnBody && (ts.isArrowFunction(fnBody) || ts.isFunctionExpression(fnBody))) {
      // `(name) => (cls) => …` – the returned function is what a decorator factory applies.
      this.walkFunctionLike(fnBody, { ...ctx, fpReturned: true }, true);
      return;
    }
    const decorators = ts.canHaveDecorators(fn) ? ts.getDecorators(fn) : undefined;
    for (const d of decorators ?? []) this.walk(d, ctx);

    const declared = new Set<string>();
    for (const p of fn.parameters) for (const n of bindingNames(p.name)) declared.add(n);
    if ((ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.name) declared.add(fn.name.text);
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body && ts.isBlock(body)) for (const n of collectBlockDeclarations(body)) declared.add(n);

    let inner: WalkCtx;
    if (iife) {
      const cb = syncCallbackOf(fn);
      const assumed = cb && !cb.certain ? `callback passed to \`${cb.name}\`, assumed to run immediately (the receiver may not be an array)` : undefined;
      inner = {
        ...ctx,
        desc: cb && !ctx.footprint ? `${ctx.desc} (callback passed to \`${cb.name}\` runs immediately)` : ctx.footprint ? ctx.desc : `${ctx.desc} (immediately-invoked function)`,
        assumed: ctx.assumed ?? assumed,
      };
    } else if (ctx.timing === 'deferred' || ctx.timing === 'type') {
      inner = ctx;
    } else {
      inner = { ...ctx, timing: 'deferred', kind: 'function-body', desc: describeFunction(fn, this.sf) };
    }

    // Parameter *types* are type positions; defaults/decorators belong to the function body timing.
    if (fn.typeParameters) for (const tp of fn.typeParameters) this.walk(tp, inner);
    if (ts.isConstructorDeclaration(fn) && this.ctx.emitDecoratorMetadata) {
      // handled by walkClass (metadata emitted at class definition time)
    }
    this.scopes.push(declared);
    for (const p of fn.parameters) this.walk(p, inner);
    if (fn.type) this.walk(fn.type, inner);
    if (body) this.walk(body, inner);
    this.scopes.pop();
  }

  private walkClass(cls: ts.ClassLikeDeclaration, ctx: WalkCtx): void {
    if (ctx.footprint) return;
    const className = cls.name?.text ?? '(anonymous class)';
    const classDecorators = ts.getDecorators(cls) ?? [];
    const isAngular = this.ctx.angular && classDecorators.some((d) => ANGULAR_DECORATORS.has(decoratorName(d) ?? ''));
    for (const d of classDecorators) this.walk(d, ctx);
    if (cls.typeParameters) for (const tp of cls.typeParameters) this.walk(tp, ctx);

    for (const clause of cls.heritageClauses ?? []) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const t of clause.types) {
          const extCtx: WalkCtx = ctx.timing === 'deferred' ? { ...ctx, desc: `extends clause of class \`${className}\` (${ctx.desc})` } : { ...ctx, timing: 'eager', kind: 'extends', desc: `extends clause of class \`${className}\`` };
          this.walk(t.expression, extCtx);
          for (const ta of t.typeArguments ?? []) this.walk(ta, ctx);
        }
      } else {
        const typeCtx: WalkCtx = { ...ctx, typePos: true, timing: 'type', kind: 'type' };
        for (const t of clause.types) this.walk(t, typeCtx);
      }
    }

    // ngtsc removes Angular decorators before TypeScript's decorator transform runs, so
    // `emitDecoratorMetadata` only emits metadata for classes/members with other decorators.
    const decorated = classDecorators.some((d) => !this.isAngularDecorator(d));
    const scope = new Set<string>();
    if (cls.name) scope.add(cls.name.text);
    this.scopes.push(scope);

    for (const member of cls.members) {
      const memberDecorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
      for (const d of memberDecorators) this.walk(d, ctx);
      const isStatic = ts.canHaveModifiers(member) && Boolean(ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
      const memberName = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isPrivateIdentifier(member.name)) ? member.name.text : '?';

      if (this.ctx.emitDecoratorMetadata && (decorated || memberDecorators.some((d) => !this.isAngularDecorator(d)))) {
        this.walkDecoratorMetadata(member, memberDecorators.some((d) => !this.isAngularDecorator(d)), decorated, className, ctx);
      }

      if (ts.isPropertyDeclaration(member)) {
        if (member.name && ts.isComputedPropertyName(member.name)) this.walk(member.name.expression, ctx);
        if (member.type) this.walk(member.type, ctx);
        if (member.initializer) {
          const fieldCtx: WalkCtx = ctx.timing === 'deferred'
            ? ctx
            : isStatic
              ? { ...ctx, timing: 'eager', kind: 'static-member', desc: `static field \`${className}.${memberName}\` initializer (runs at class definition)` }
              : { ...ctx, timing: 'deferred', kind: 'class-field', desc: `instance field \`${className}.${memberName}\` initializer (runs on instantiation)` };
          this.walk(member.initializer, fieldCtx);
        }
        continue;
      }
      if (ts.isClassStaticBlockDeclaration(member)) {
        const sbCtx: WalkCtx = ctx.timing === 'deferred' ? ctx : { ...ctx, timing: 'eager', kind: 'static-member', desc: `static block of class \`${className}\`` };
        this.walk(member.body, sbCtx);
        continue;
      }
      if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        if (member.name && ts.isComputedPropertyName(member.name)) this.walk(member.name.expression, ctx);
        this.walkFunctionLike(member, ctx, false);
        if (isAngular && ts.isConstructorDeclaration(member)) this.walkAngularFactoryParams(member, className);
        continue;
      }
      if (ts.isIndexSignatureDeclaration(member) || ts.isSemicolonClassElement(member)) continue;
      ts.forEachChild(member, (child) => this.walk(child, ctx));
    }
    this.scopes.pop();
  }

  /**
   * ngtsc compiles an Angular class's constructor into `static ɵfac = (t) => new (t || C)(ɵɵinject(Dep), ...)`.
   * The parameter *types* therefore become value references (deferred: they run on instantiation),
   * which keeps their imports alive even though they look type-only in the source. Parameters with
   * `@Inject(token)` / `@Attribute()` use the token instead. Interfaces are downgraded in the graph phase.
   */
  private walkAngularFactoryParams(ctor: ts.ConstructorDeclaration, className: string): void {
    const fCtx: WalkCtx = {
      timing: 'deferred',
      kind: 'di-factory',
      desc: `constructor parameter of \`${className}\` (Angular's generated factory injects it on instantiation)`,
      typePos: false,
      declName: this.exportByDecl.has(className) ? className : undefined,
    };
    for (const p of ctor.parameters) {
      if ((ts.getDecorators(p) ?? []).some((d) => ['Inject', 'Attribute'].includes(decoratorName(d) ?? ''))) continue;
      const t = injectableTypeRef(p.type);
      if (!t) continue;
      let left: ts.EntityName = t.typeName;
      while (ts.isQualifiedName(left)) left = left.left;
      this.onIdentifier(left, fCtx, ts.isQualifiedName(t.typeName) ? t.typeName.right.text : undefined);
    }
  }

  /**
   * With `emitDecoratorMetadata`, TypeScript emits constructor parameter types (`design:paramtypes`),
   * decorated property types (`design:type`) and decorated method signatures as *values* at class
   * definition time. Record those as eager usages; the graph phase downgrades interfaces/types.
   */
  /** Decorator imported from an `@angular/*` package (or an Angular decorator name that cannot be resolved). */
  private isAngularDecorator(d: ts.Decorator): boolean {
    const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    const head = ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) ? expr.expression : null;
    if (!head) return false;
    const binding = this.bindings.get(head.text);
    if (binding) return binding.record.specifierText.startsWith('@angular/');
    return ANGULAR_ALL_DECORATORS.has(head.text) && !this.topLevel[head.text];
  }

  private walkDecoratorMetadata(member: ts.ClassElement, memberDecorated: boolean, classDecorated: boolean, className: string, ctx: WalkCtx): void {
    if (ctx.timing === 'deferred') return;
    const mdCtx: WalkCtx = { ...ctx, timing: 'eager', kind: 'decorator-metadata', desc: `emitDecoratorMetadata for class \`${className}\` (design:paramtypes / design:type emitted at class definition)`, typePos: false };
    const visitType = (t: ts.TypeNode | undefined): void => {
      if (!t) return;
      if (ts.isTypeReferenceNode(t)) {
        const tn = t.typeName;
        if (ts.isIdentifier(tn)) this.onIdentifier(tn, mdCtx);
        else if (ts.isQualifiedName(tn)) {
          let left: ts.EntityName = tn;
          while (ts.isQualifiedName(left)) left = left.left;
          this.onIdentifier(left, mdCtx, ts.isQualifiedName(tn) ? tn.right.text : undefined);
        }
      }
    };
    if (ts.isConstructorDeclaration(member)) {
      if (classDecorated) for (const p of member.parameters) visitType(p.type);
    } else if (memberDecorated) {
      if (ts.isPropertyDeclaration(member)) visitType(member.type);
      if (ts.isMethodDeclaration(member) || ts.isSetAccessor(member) || ts.isGetAccessor(member)) {
        for (const p of member.parameters) visitType(p.type);
        visitType(member.type);
      }
    }
  }

  private isShadowed(name: string): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i]!.has(name)) return true;
    return false;
  }

  private onIdentifier(id: ts.Identifier, ctx: WalkCtx, member?: string): void {
    if (!ctx.footprint && !ctx.typePos && ctx.declName && id.text !== ctx.declName && !this.isShadowed(id.text)) {
      const deps = (this.declDeps[ctx.declName] ??= { imports: [], locals: [] });
      if (this.bindings.has(id.text)) {
        if (!deps.imports.includes(id.text)) deps.imports.push(id.text);
      } else if (this.topLevel[id.text] && !deps.locals.includes(id.text)) {
        deps.locals.push(id.text);
      }
    }
    // `ns.Member.method()` on a namespace import: a load-time call of a static method.
    const method = member !== undefined && this.bindings.get(id.text)?.spec.imported === '*' ? staticCallOf(id) : undefined;
    if (ctx.footprint) {
      if (ctx.typePos || this.isShadowed(id.text)) return;
      const ref = { line: this.pos(id).line, call: isInvoked(id, member !== undefined) || method !== undefined, conditional: ctx.conditional || undefined, assumed: ctx.assumed, method };
      const target = ctx.fpReturned ? ctx.footprint.returned : ctx.footprint;
      if (this.bindings.has(id.text)) target.imports.push({ local: id.text, member, ...ref });
      else if (this.topLevel[id.text]) target.locals.push({ name: id.text, member, ...ref });
      return;
    }
    const binding = this.bindings.get(id.text);
    if (!binding) return;
    if (this.isShadowed(id.text)) return;
    const { spec, record } = binding;
    const { line, column } = this.pos(id);
    const timing: UsageTiming = ctx.typePos ? 'type' : ctx.timing;
    const usage: Usage = {
      line,
      column,
      timing,
      contextKind: ctx.typePos ? 'type' : ctx.kind,
      context: ctx.typePos ? 'type position' : ctx.desc,
      snippet: this.lineText(line),
    };
    if (member !== undefined && spec.imported === '*') usage.member = member;
    if (member !== undefined) usage.access = member;
    else if (spec.imported === '*' && !ctx.typePos && isEnumerated(id)) {
      // Object.keys(ns) / { ...ns } / Object.values(ns) read every exported binding.
      usage.member = '*';
      usage.access = '*';
    }
    if (ctx.decorator && !ctx.typePos) usage.decorator = ctx.decorator;
    if (ctx.property && !ctx.typePos) usage.property = ctx.property;
    if (!ctx.typePos && isInvoked(id, member !== undefined)) usage.call = true;
    if (!ctx.typePos && method !== undefined) {
      usage.call = true;
      usage.staticCall = method;
    }
    if (!ctx.typePos && isDecoratorFactoryCallee(id, member !== undefined)) usage.decoratorFactory = true;
    if (ctx.assumed && !ctx.typePos && timing === 'eager') usage.assumed = ctx.assumed;
    this.recordUsage(spec, usage);

    if (timing !== 'type' && ctx.declName) {
      for (const rec of this.exportByDecl.get(ctx.declName) ?? []) {
        if (!rec.usesImports.includes(spec.local)) rec.usesImports.push(spec.local);
      }
    }
    void record;
  }

  private recordUsage(spec: ImportSpecifierInfo, usage: Usage): void {
    let idx = this.usageIndex.get(spec);
    if (!idx) {
      idx = new Map();
      this.usageIndex.set(spec, idx);
    }
    const key = `${usage.line}:${usage.column}`;
    const existing = idx.get(key);
    if (existing) {
      if (TIMING_RANK[usage.timing] > TIMING_RANK[existing.timing]) {
        Object.assign(existing, usage);
      }
      return;
    }
    idx.set(key, usage);
    spec.usages.push(usage);
  }

  private onDynamicImport(call: ts.CallExpression, ctx: WalkCtx): void {
    const arg = call.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg)) return;
    const record = this.makeRecord('dynamic', arg.text, call, false);
    record.dynamicAtTopLevel = ctx.timing === 'eager' && !ctx.typePos;
    record.erased = false;
  }

  private onRequire(call: ts.CallExpression, ctx: WalkCtx): void {
    const arg = call.arguments[0] as ts.StringLiteral;
    const record = this.makeRecord('require', arg.text, call, false);
    const { line, column } = this.pos(call);
    const spec: ImportSpecifierInfo = { imported: '*', local: '(require)', typeOnly: false, usages: [], effectiveTiming: 'unused' };
    spec.usages.push({ line, column, timing: ctx.typePos ? 'type' : ctx.timing, contextKind: ctx.kind, context: `require() call — ${ctx.desc}`, snippet: this.lineText(line) });
    record.specifiers.push(spec);
    record.erased = false;
  }

  /** Functions/classes invoked at module load make their bodies effectively eager. */
  private propagateEagerCalls(): void {
    const queue = [...this.eagerInvoked];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (this.visitedEager.has(name)) continue;
      this.visitedEager.add(name);
      const node = this.localCallables.get(name);
      if (!node) continue;
      const before = new Set(this.eagerInvoked);
      const ctx: WalkCtx = {
        timing: 'eager',
        kind: 'top-level-call',
        desc: ts.isClassDeclaration(node)
          ? `class \`${name}\` instantiated at module load (constructor / field initializers run eagerly)`
          : `inside \`${name}()\`, which is called at module load`,
        typePos: false,
        declName: this.exportByDecl.has(name) ? name : undefined,
      };
      if (ts.isClassDeclaration(node)) {
        // Instantiating a class also runs the constructor and field initialisers of its base class.
        const base = baseClassOf(node);
        if (base && !this.isShadowed(base.text)) {
          if (this.localCallables.has(base.text)) this.eagerInvoked.add(base.text);
          const imported = this.bindings.get(base.text);
          const at = this.pos(base);
          const usage = imported && this.usageIndex.get(imported.spec)?.get(`${at.line}:${at.column}`);
          if (usage && usage.timing === 'eager') usage.call = true;
        }
        this.scopes.push(new Set([name]));
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) this.walkFunctionLike(member, ctx, true);
          else if (ts.isPropertyDeclaration(member) && member.initializer && !ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) {
            this.walk(member.initializer, ctx);
          }
        }
        this.scopes.pop();
      } else {
        this.walkFunctionLike(node as ts.FunctionLikeDeclaration, ctx, true);
      }
      for (const n of this.eagerInvoked) if (!before.has(n)) queue.push(n);
    }
  }

  /**
   * For every top-level function / arrow-function constant / class, record what it touches when it
   * runs (direct body only, plus immediately-invoked closures). The evaluator follows these when a
   * module calls an imported function at load time.
   */
  private computeFootprints(): void {
    for (const [name, node] of this.localCallables) {
      const fp: Footprint = { line: this.pos(node).line, imports: [], locals: [], returned: { imports: [], locals: [] } };
      if (this.getters.has(name)) fp.getter = true;
      const ctx: WalkCtx = { timing: 'eager', kind: 'top-level-call', desc: '', typePos: false, footprint: fp };
      if (ts.isClassDeclaration(node)) {
        const base = baseClassOf(node);
        if (base) {
          const ref = { line: this.pos(base).line, call: true, inherit: true };
          if (this.bindings.has(base.text)) fp.imports.push({ local: base.text, ...ref });
          else if (this.topLevel[base.text]) fp.locals.push({ name: base.text, ...ref });
        }
        this.scopes.push(new Set());
        for (const member of node.members) {
          const isStatic = ts.canHaveModifiers(member) && Boolean(ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
          if (ts.isConstructorDeclaration(member)) this.walkFunctionLike(member, ctx, true);
          else if (ts.isPropertyDeclaration(member) && member.initializer && !isStatic) this.walk(member.initializer, ctx);
        }
        this.scopes.pop();
      } else {
        this.walkFunctionLike(node as ts.FunctionLikeDeclaration, ctx, true);
      }
      this.footprints[name] = fp;
    }
  }

  private isErased(record: ImportRecord): boolean {
    if (record.typeOnly) return true;
    if (record.kind !== 'static' && record.kind !== 'import-equals') return false;
    if (record.specifiers.length === 0) return false;
    if (this.ctx.verbatimModuleSyntax) {
      return record.specifiers.every((s) => s.typeOnly);
    }
    return record.specifiers.every((s) => s.typeOnly || (!s.reexported && (s.effectiveTiming === 'type' || s.effectiveTiming === 'unused')));
  }

  private lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? 0;
    const end = this.lineStarts[line] ?? this.sf.text.length;
    return this.sf.text.slice(start, end).replace(/\r?\n$/, '').trim().slice(0, 160);
  }

  // ---------------------------------------------------------------------------------------------
  // Angular DI extraction
  // ---------------------------------------------------------------------------------------------

  private extractAngular(cls: ts.ClassDeclaration): void {
    const decorators = ts.getDecorators(cls) ?? [];
    let ngDecorator: { name: AngularDecoratorName; call: ts.CallExpression | null } | null = null;
    for (const d of decorators) {
      const name = decoratorName(d);
      if (name && ANGULAR_DECORATORS.has(name)) {
        ngDecorator = { name: name as AngularDecoratorName, call: ts.isCallExpression(d.expression) ? d.expression : null };
        break;
      }
    }
    if (!cls.name) return;
    const extendsExpr = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const info: AngularClassInfo = {
      name: cls.name.text,
      line: this.pos(cls).line,
      decorator: ngDecorator?.name ?? 'none',
      deps: [],
      providers: [],
      imports: [],
      extends: extendsExpr ? exprText(extendsExpr, this.sf) : undefined,
      hasConstructor: cls.members.some((m) => ts.isConstructorDeclaration(m) && m.body !== undefined),
    };

    const arg = ngDecorator?.call?.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        if (key === 'providedIn') info.providedIn = exprText(prop.initializer, this.sf);
        if (ngDecorator?.name === 'Injectable' && (key === 'useClass' || key === 'useExisting' || key === 'useFactory' || key === 'deps')) {
          const self = (info.selfProvider ??= { provide: info.name, line: this.pos(prop).line, snippet: this.lineText(this.pos(prop).line) });
          this.applyProviderProp(self, key, prop.initializer);
        }
        if (key === 'providers' || key === 'viewProviders') this.collectProviders(prop.initializer, info.providers);
        if (key === 'imports') for (const el of flattenArray(prop.initializer)) info.imports.push(unwrapForwardRef(el, this.sf));
      }
    }

    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const p of member.parameters) {
          // Only Angular classes get a generated factory that injects parameter types.
          const dep = ngDecorator ? this.constructorParamDependency(p) : null;
          if (dep) info.deps.push(dep);
          if (p.initializer) this.collectInjectCalls(p.initializer, 'inject-constructor', info.deps);
        }
        if (member.body) this.collectInjectCalls(member.body, 'inject-constructor', info.deps);
      } else if (ts.isPropertyDeclaration(member) && member.initializer) {
        const isStatic = ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (!isStatic) this.collectInjectCalls(member.initializer, 'inject-field', info.deps);
      }
    }
    // Undecorated classes only matter as base classes of Angular classes.
    if (!ngDecorator && info.deps.length === 0 && !info.extends) return;
    this.angular.push(info);
  }

  private constructorParamDependency(p: ts.ParameterDeclaration): DiDependency | null {
    const flags: DiDependencyFlags = {};
    let token: string | null = null;
    for (const d of ts.getDecorators(p) ?? []) {
      const name = decoratorName(d);
      const call = ts.isCallExpression(d.expression) ? d.expression : null;
      switch (name) {
        case 'Inject':
          if (call?.arguments[0]) token = unwrapForwardRef(call.arguments[0], this.sf);
          break;
        case 'Optional':
          flags.optional = true;
          break;
        case 'Self':
          flags.self = true;
          break;
        case 'SkipSelf':
          flags.skipSelf = true;
          break;
        case 'Host':
          flags.host = true;
          break;
        case 'Attribute':
          return null;
        default:
          break;
      }
    }
    if (!token) {
      const ref = injectableTypeRef(p.type);
      if (!ref) return null;
      token = entityNameText(ref.typeName);
    }
    const { line, column } = this.pos(p);
    return { token, line, column, via: 'constructor-param', flags, snippet: this.lineText(line) };
  }

  private collectInjectCalls(node: ts.Node, via: DiDependency['via'], out: DiDependency[]): void {
    const visit = (n: ts.Node): void => {
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n)) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const isInject = (ts.isIdentifier(callee) && callee.text === 'inject') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'inject');
        if (isInject && n.arguments[0]) {
          const token = unwrapForwardRef(n.arguments[0], this.sf);
          const flags: DiDependencyFlags = {};
          const opts = n.arguments[1];
          if (opts && ts.isObjectLiteralExpression(opts)) {
            for (const prop of opts.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                const k = prop.name.text as keyof DiDependencyFlags;
                if (k === 'optional' || k === 'self' || k === 'skipSelf' || k === 'host') flags[k] = true;
              }
            }
          }
          const { line, column } = this.pos(n);
          out.push({ token, line, column, via, flags, snippet: this.lineText(line) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  private collectProviders(expr: ts.Expression, out: ProviderInfo[]): void {
    for (const el of flattenArray(expr)) {
      const line = this.pos(el).line;
      if (ts.isIdentifier(el) || ts.isPropertyAccessExpression(el)) {
        out.push({ provide: exprText(el, this.sf), line });
        continue;
      }
      if (ts.isObjectLiteralExpression(el)) {
        const info: ProviderInfo = { provide: '', line, snippet: this.lineText(line) };
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          this.applyProviderProp(info, prop.name.text, prop.initializer);
        }
        if (info.provide) out.push(info);
      }
    }
  }

  private applyProviderProp(info: ProviderInfo, key: string, value: ts.Expression): void {
    if (key === 'provide') info.provide = unwrapForwardRef(value, this.sf);
    else if (key === 'useClass') info.useClass = unwrapForwardRef(value, this.sf);
    else if (key === 'useExisting') info.useExisting = unwrapForwardRef(value, this.sf);
    else if (key === 'deps') {
      // `deps: [A, [new Optional(), new SkipSelf(), B]]`
      let cur: ts.Expression = value;
      while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
      if (!ts.isArrayLiteralExpression(cur)) return;
      for (const el of cur.elements) {
        if (ts.isArrayLiteralExpression(el)) {
          const flags: DiDependencyFlags = {};
          let token: string | null = null;
          for (const part of el.elements) {
            const ctor = ts.isNewExpression(part) ? part.expression : part;
            const n = ts.isIdentifier(ctor) ? ctor.text : '';
            if (n === 'Optional') flags.optional = true;
            else if (n === 'SkipSelf') flags.skipSelf = true;
            else if (n === 'Self') flags.self = true;
            else if (n === 'Host') flags.host = true;
            else if (ts.isNewExpression(part) && n === 'Inject' && part.arguments?.[0]) token = unwrapForwardRef(part.arguments[0], this.sf);
            else if (!ts.isNewExpression(part)) token = unwrapForwardRef(part, this.sf);
          }
          if (token) (info.deps ??= []).push({ token, flags });
        } else if (!ts.isSpreadElement(el)) {
          (info.deps ??= []).push({ token: unwrapForwardRef(el, this.sf), flags: {} });
        }
      }
    } else if (key === 'useFactory') {
      // `useFactory: () => new X(inject(A))` – inject() runs in the factory's injection context.
      if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return;
      const deps: DiDependency[] = [];
      this.collectInjectCalls(value.body, 'provider', deps);
      for (const d of deps) (info.deps ??= []).push({ token: d.token, flags: d.flags });
    }
  }

  /** Providers in object literals outside decorators (`app.config.ts`, `bootstrapApplication`, route providers). */
  private collectRootProviders(): void {
    const visit = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isDecorator(n)) return;
      if (ts.isObjectLiteralExpression(n) && n.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'provide')) {
        this.collectProviders(n, this.rootProviders);
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const stmt of this.sf.statements) if (!ts.isImportDeclaration(stmt)) visit(stmt);
  }

  /** `export const T = new InjectionToken<X>('…', { factory: () => inject(A) })` is a DI node depending on A. */
  private extractInjectionTokens(stmt: ts.VariableStatement): void {
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (!ts.isIdentifier(decl.name) || !init || !ts.isNewExpression(init)) continue;
      const callee = init.expression;
      const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (calleeName !== 'InjectionToken') continue;
      const opts = init.arguments?.[1];
      const info: AngularClassInfo = { name: decl.name.text, line: this.pos(decl).line, decorator: 'InjectionToken', deps: [], providers: [], imports: [], hasConstructor: false };
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const prop of opts.properties) {
          const isFactory = (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) && ts.isIdentifier(prop.name) && prop.name.text === 'factory';
          if (!isFactory) continue;
          if (ts.isPropertyAssignment(prop) && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))) {
            this.collectInjectCalls(prop.initializer.body, 'token-factory', info.deps);
          } else if (ts.isMethodDeclaration(prop) && prop.body) {
            this.collectInjectCalls(prop.body, 'token-factory', info.deps);
          }
        }
      }
      this.angular.push(info);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------------

const bindingNames = (name: ts.BindingName): string[] => {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
};

/**
 * Names declared in a block. Block-scoped declarations (`let`/`const`/`class`/`function`) count only
 * at the block's own level; `var` declarations are collected from nested blocks too (function-scoped).
 * Nested functions/classes are never entered.
 */
const collectBlockDeclarations = (block: ts.Node): Set<string> => {
  const out = new Set<string>();
  const visit = (n: ts.Node, nested: boolean): void => {
    if (ts.isVariableStatement(n)) {
      const blockScoped = Boolean(n.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let));
      if (!nested || !blockScoped) {
        for (const d of n.declarationList.declarations) for (const name of bindingNames(d.name)) out.add(name);
      }
      return;
    }
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) {
      if (n.name && !nested) out.add(n.name.text);
      return;
    }
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) {
      const init = n.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        const blockScoped = Boolean(init.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let));
        if (!blockScoped) for (const d of init.declarations) for (const name of bindingNames(d.name)) out.add(name);
      }
      ts.forEachChild(n, (c) => visit(c, true));
      return;
    }
    const entersBlock = ts.isBlock(n) || ts.isCaseBlock(n);
    ts.forEachChild(n, (c) => visit(c, nested || entersBlock));
  };
  ts.forEachChild(block, (c) => visit(c, false));
  return out;
};

const SYNC_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'flatMap', 'sort', 'toSorted', 'from',
]);

/**
 * Callbacks that run synchronously while their caller runs: array iteration methods
 * (`items.map(cb)`), `Array.from(x, cb)` and `new Promise(executor)`. Returns a display name.
 */
const syncCallbackOf = (fn: ts.Node): { name: string; certain: boolean } | null => {
  const p = fn.parent;
  if (!p) return null;
  if (ts.isCallExpression(p) && p.arguments.includes(fn as ts.Expression) && ts.isPropertyAccessExpression(p.expression)) {
    const name = p.expression.name.text;
    if (SYNC_CALLBACK_METHODS.has(name)) {
      if (name === 'from') {
        const recv = p.expression.expression;
        if (!ts.isIdentifier(recv) || recv.text !== 'Array') return null;
        return { name: 'Array.from()', certain: p.arguments[0] !== undefined && hasElements(p.arguments[0], 1) };
      }
      // A comparator / reducer needs two elements to be called at all.
      const needs = name === 'sort' || name === 'toSorted' || name === 'reduce' || name === 'reduceRight' ? 2 : 1;
      return { name: `.${name}()`, certain: hasElements(p.expression.expression, needs) };
    }
  }
  if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'Promise' && p.arguments?.[0] === fn) return { name: 'new Promise()', certain: true };
  return null;
};

/**
 * Does the expression certainly evaluate to an array with at least `min` elements? Only then is a
 * callback passed to `.map()` / `.forEach()` / `.sort()` certain to run: array literals,
 * `Array.of(...)`, `{ length: n }` for `Array.from`, and length-preserving chains on them.
 * `Object.keys(x)`, `.filter()` results or plain identifiers may be empty.
 */
const hasElements = (e: ts.Expression, min: number): boolean => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  if (ts.isArrayLiteralExpression(cur)) return cur.elements.filter((el) => !ts.isSpreadElement(el) && !ts.isOmittedExpression(el)).length >= min;
  if (ts.isObjectLiteralExpression(cur)) {
    // `Array.from({ length: 3 }, cb)`
    const len = cur.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'length');
    return Boolean(len && ts.isPropertyAssignment(len) && ts.isNumericLiteral(len.initializer) && Number(len.initializer.text) >= min);
  }
  if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const recv = cur.expression.expression;
    const name = cur.expression.name.text;
    if (ts.isIdentifier(recv) && recv.text === 'Array' && name === 'of') return cur.arguments.filter((a) => !ts.isSpreadElement(a)).length >= min;
    if (['map', 'toSorted', 'sort', 'reverse', 'toReversed', 'concat'].includes(name)) return hasElements(recv, min);
  }
  return false;
};

/** `class X extends Base` – the base class when it is a plain identifier. */
const baseClassOf = (cls: ts.ClassLikeDeclaration): ts.Identifier | null => {
  const expr = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return expr && ts.isIdentifier(expr) ? expr : null;
};

/** `ns.Member.method(...)`: returns `method` when the identifier `ns` starts such a call. */
const staticCallOf = (id: ts.Identifier): string | undefined => {
  const member = id.parent;
  if (!member || !ts.isPropertyAccessExpression(member) || member.expression !== id) return undefined;
  const method = member.parent;
  if (!method || !ts.isPropertyAccessExpression(method) || method.expression !== member) return undefined;
  const call = method.parent;
  return call && ts.isCallExpression(call) && call.expression === method ? method.name.text : undefined;
};

/**
 * Can this statement leave the enclosing block early on some runs – a `return`, `throw`, `break`
 * or `continue` under a condition (not looking into nested functions)?
 */
const mayExitEarly = (stmt: ts.Node): boolean => {
  if (!(ts.isIfStatement(stmt) || ts.isSwitchStatement(stmt) || ts.isTryStatement(stmt) || ts.isIterationStatement(stmt, false) || ts.isLabeledStatement(stmt) || ts.isBlock(stmt))) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(stmt, visit);
  return found;
};

/** `@Register('x')`: the identifier is the callee of a call that is itself the decorator expression. */
const isDecoratorFactoryCallee = (id: ts.Identifier, viaMember: boolean): boolean => {
  let node: ts.Node = id;
  if (viaMember && id.parent && ts.isPropertyAccessExpression(id.parent)) node = id.parent;
  const p = node.parent;
  return Boolean(p && ts.isCallExpression(p) && p.expression === node && p.parent && ts.isDecorator(p.parent));
};

/** `Object.keys(ns)`, `Object.values(ns)`, `{ ...ns }`, `[...Object.entries(ns)]`, `for (k in ns)` read every binding. */
const isEnumerated = (id: ts.Identifier): boolean => {
  const p = id.parent;
  if (!p) return false;
  if (ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) return true;
  if (ts.isForInStatement(p) && p.expression === id) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(id) && ts.isPropertyAccessExpression(p.expression) && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'Object') {
    return ['keys', 'values', 'entries', 'assign', 'getOwnPropertyNames', 'freeze'].includes(p.expression.name.text);
  }
  return false;
};

/** The class type of an injectable parameter: `X`, `X | null`, `X | undefined` (ngtsc unwraps the nullable union). */
const injectableTypeRef = (t: ts.TypeNode | undefined): ts.TypeReferenceNode | null => {
  if (!t) return null;
  if (ts.isTypeReferenceNode(t)) return t;
  if (ts.isUnionTypeNode(t)) {
    const rest = t.types.filter((m) => !(ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword) && m.kind !== ts.SyntaxKind.UndefinedKeyword);
    if (rest.length === 1 && ts.isTypeReferenceNode(rest[0]!)) return rest[0];
  }
  return null;
};

/** Is the identifier (or `id.member` when `viaMember`) the callee of a call / `new` / tagged template / decorator? */
const isInvoked = (id: ts.Identifier, viaMember: boolean): boolean => {
  let node: ts.Node = id;
  if (viaMember && id.parent && (ts.isPropertyAccessExpression(id.parent) || ts.isElementAccessExpression(id.parent))) node = id.parent;
  while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isAsExpression(node.parent))) node = node.parent;
  const p = node.parent;
  if (!p) return false;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) return true;
  // passed by reference to a synchronous array method: `[...].forEach(fn)`
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression) && ts.isPropertyAccessExpression(p.expression) && SYNC_CALLBACK_METHODS.has(p.expression.name.text)) return true;
  if (ts.isTaggedTemplateExpression(p) && p.tag === node) return true;
  if (ts.isDecorator(p)) return true;
  return false;
};

const isIife = (fn: ts.Node): boolean => {
  let p: ts.Node | undefined = fn.parent;
  let cur: ts.Node = fn;
  while (p && ts.isParenthesizedExpression(p)) {
    cur = p;
    p = p.parent;
  }
  return Boolean(p && ts.isCallExpression(p) && p.expression === cur);
};

const describeFunction = (fn: ts.SignatureDeclaration, sf: ts.SourceFile): string => {
  if (ts.isFunctionDeclaration(fn)) return `inside function \`${fn.name?.text ?? 'default'}()\``;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessor(fn) || ts.isSetAccessor(fn)) {
    const owner = fn.parent && ts.isClassLike(fn.parent) ? fn.parent.name?.text : undefined;
    const name = fn.name && !ts.isComputedPropertyName(fn.name) ? fn.name.getText(sf) : '?';
    return owner ? `inside method \`${owner}.${name}()\`` : `inside method \`${name}()\``;
  }
  if (ts.isConstructorDeclaration(fn)) {
    const owner = fn.parent && ts.isClassLike(fn.parent) ? fn.parent.name?.text : undefined;
    return `inside constructor of \`${owner ?? '?'}\` (runs on instantiation)`;
  }
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return `inside function \`${p.name.text}()\``;
    if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return `inside callback \`${p.name.text}: () => ...\``;
    if (p && ts.isCallExpression(p)) {
      const callee = p.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name) return `inside callback passed to \`${name}()\``;
    }
    if (p && ts.isPropertyDeclaration(p) && p.name && ts.isIdentifier(p.name)) return `inside arrow-function field \`${p.name.text}\``;
    return 'inside arrow function';
  }
  return 'inside function';
};

const decoratorName = (d: ts.Decorator): string | null => {
  const expr = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
};

const entityNameText = (name: ts.EntityName): string => {
  if (ts.isIdentifier(name)) return name.text;
  return `${entityNameText(name.left)}.${name.right.text}`;
};

const exprText = (e: ts.Expression, sf: ts.SourceFile): string => {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.getText(sf);
  return e.getText(sf);
};

/** `forwardRef(() => X)` -> `X`; identifiers/property accesses -> text. */
const unwrapForwardRef = (e: ts.Expression, sf: ts.SourceFile): string => {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === 'forwardRef') {
    const arg = cur.arguments[0];
    if (arg && ts.isArrowFunction(arg)) {
      const body = arg.body;
      if (!ts.isBlock(body)) return unwrapForwardRef(body, sf);
      const ret = body.statements.find(ts.isReturnStatement);
      if (ret?.expression) return unwrapForwardRef(ret.expression, sf);
    }
  }
  return exprText(cur, sf);
};

const flattenArray = (e: ts.Expression): ts.Expression[] => {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
  if (ts.isArrayLiteralExpression(cur)) {
    const out: ts.Expression[] = [];
    for (const el of cur.elements) {
      if (ts.isSpreadElement(el)) out.push(...flattenArray(el.expression));
      else out.push(...flattenArray(el));
    }
    return out;
  }
  return [cur];
};
