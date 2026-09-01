import ts from 'typescript';
import type {
  AngularClassInfo,
  AngularDecoratorName,
  DiDependency,
  DiDependencyFlags,
  ExportKind,
  ExportRecord,
  ImportRecord,
  ImportSpecifierInfo,
  ModuleInfo,
  ProviderInfo,
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
}

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
      }
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
      if (isExported) this.addExport(isDefault ? 'default' : name, 'class', false, stmt, name);
      return;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      const name = stmt.name?.text ?? 'default';
      this.localClasses.push(name);
      this.localCallables.set(name, stmt);
      if (isExported) this.addExport(isDefault ? 'default' : name, 'function', true, stmt, name);
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
          if (isExported) this.addExport(name, isDeclare ? 'type' : kind, false, decl, name);
        }
      }
      return;
    }
    if (ts.isEnumDeclaration(stmt)) {
      this.hasOwnDeclarations = true;
      this.localClasses.push(stmt.name.text);
      if (isExported) this.addExport(stmt.name.text, isDeclare ? 'type' : 'enum', false, stmt, stmt.name.text);
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
      if (isExported) this.addExport(name, isDeclare ? 'type' : 'namespace', false, stmt, name);
      return;
    }
    if (!ts.isEmptyStatement(stmt)) {
      // expression statements, if/for/try at top level, etc.
      this.hasOwnDeclarations = true;
    }
  }

  private readonly deferredLocalExports: { localName: string; exported: string; line: number; typeOnly: boolean }[] = [];

  private addExport(name: string, kind: ExportKind, hoisted: boolean, node: ts.Node, declName: string): void {
    const rec: ExportRecord = { name, kind, hoisted, line: this.pos(node).line, usesImports: [] };
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
        line: d.line,
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
        if (decl.initializer) this.walk(decl.initializer, ctx);
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
        this.walkFunctionLike(node as ts.SignatureDeclaration, ctx, isIife(node));
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
        ts.forEachChild(call, (child) => this.walk(child, ctx));
        return;
      }
      case ts.SyntaxKind.NewExpression: {
        const ne = node as ts.NewExpression;
        if (ts.isIdentifier(ne.expression) && ctx.timing === 'eager' && !ctx.typePos && this.localCallables.has(ne.expression.text)) {
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
        if (vd.initializer) this.walk(vd.initializer, ctx);
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
        ts.forEachChild(node, (child) => this.walk(child, ctx));
        if (declared.size > 0) this.scopes.pop();
        return;
      }
      case ts.SyntaxKind.CatchClause: {
        const cc = node as ts.CatchClause;
        const declared = new Set<string>();
        if (cc.variableDeclaration) for (const n of bindingNames(cc.variableDeclaration.name)) declared.add(n);
        this.scopes.push(declared);
        this.walk(cc.block, ctx);
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

  private walkBindingName(name: ts.BindingName, ctx: WalkCtx): void {
    if (ts.isIdentifier(name)) return;
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) this.walk(el, ctx);
    }
  }

  private walkFunctionLike(fn: ts.SignatureDeclaration | ts.FunctionLikeDeclaration, ctx: WalkCtx, iife: boolean): void {
    const decorators = ts.canHaveDecorators(fn) ? ts.getDecorators(fn) : undefined;
    for (const d of decorators ?? []) this.walk(d, ctx);

    const declared = new Set<string>();
    for (const p of fn.parameters) for (const n of bindingNames(p.name)) declared.add(n);
    if ((ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.name) declared.add(fn.name.text);
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body && ts.isBlock(body)) for (const n of collectBlockDeclarations(body)) declared.add(n);

    let inner: WalkCtx;
    if (iife) {
      inner = { ...ctx, desc: `${ctx.desc} (immediately-invoked function)` };
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
    const className = cls.name?.text ?? '(anonymous class)';
    const classDecorators = ts.getDecorators(cls) ?? [];
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

    const decorated = classDecorators.length > 0;
    const scope = new Set<string>();
    if (cls.name) scope.add(cls.name.text);
    this.scopes.push(scope);

    for (const member of cls.members) {
      const memberDecorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
      for (const d of memberDecorators) this.walk(d, ctx);
      const isStatic = ts.canHaveModifiers(member) && Boolean(ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
      const memberName = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isPrivateIdentifier(member.name)) ? member.name.text : '?';

      if (this.ctx.emitDecoratorMetadata && decorated) this.walkDecoratorMetadata(member, memberDecorators.length > 0, className, ctx);

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
        continue;
      }
      if (ts.isIndexSignatureDeclaration(member) || ts.isSemicolonClassElement(member)) continue;
      ts.forEachChild(member, (child) => this.walk(child, ctx));
    }
    this.scopes.pop();
  }

  /**
   * With `emitDecoratorMetadata`, TypeScript emits constructor parameter types (`design:paramtypes`),
   * decorated property types (`design:type`) and decorated method signatures as *values* at class
   * definition time. Record those as eager usages; the graph phase downgrades interfaces/types.
   */
  private walkDecoratorMetadata(member: ts.ClassElement, memberDecorated: boolean, className: string, ctx: WalkCtx): void {
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
      for (const p of member.parameters) visitType(p.type);
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
    if (ctx.decorator && !ctx.typePos) usage.decorator = ctx.decorator;
    if (ctx.property && !ctx.typePos) usage.property = ctx.property;
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

  private isErased(record: ImportRecord): boolean {
    if (record.typeOnly) return true;
    if (record.kind !== 'static') return false;
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
    if (!ngDecorator || !cls.name) return;

    const info: AngularClassInfo = {
      name: cls.name.text,
      line: this.pos(cls).line,
      decorator: ngDecorator.name,
      deps: [],
      providers: [],
      imports: [],
    };

    const arg = ngDecorator.call?.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        if (key === 'providedIn') info.providedIn = exprText(prop.initializer, this.sf);
        if (key === 'providers' || key === 'viewProviders') this.collectProviders(prop.initializer, info.providers);
        if (key === 'imports') for (const el of flattenArray(prop.initializer)) info.imports.push(unwrapForwardRef(el, this.sf));
      }
    }

    for (const member of cls.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const p of member.parameters) {
          const dep = this.constructorParamDependency(p);
          if (dep) info.deps.push(dep);
        }
        if (member.body) this.collectInjectCalls(member.body, 'inject-constructor', info.deps);
      } else if (ts.isPropertyDeclaration(member) && member.initializer) {
        const isStatic = ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (!isStatic) this.collectInjectCalls(member.initializer, 'inject-field', info.deps);
      }
    }
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
      if (!p.type || !ts.isTypeReferenceNode(p.type)) return null;
      token = entityNameText(p.type.typeName);
    }
    const { line, column } = this.pos(p);
    return { token, line, column, via: 'constructor-param', flags };
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
          out.push({ token, line, column, via, flags });
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
        const info: ProviderInfo = { provide: '', line };
        for (const prop of el.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          const k = prop.name.text;
          if (k === 'provide') info.provide = unwrapForwardRef(prop.initializer, this.sf);
          else if (k === 'useClass') info.useClass = unwrapForwardRef(prop.initializer, this.sf);
          else if (k === 'useExisting') info.useExisting = unwrapForwardRef(prop.initializer, this.sf);
          else if (k === 'deps') info.deps = flattenArray(prop.initializer).map((d) => unwrapForwardRef(d, this.sf));
        }
        if (info.provide) out.push(info);
      }
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
