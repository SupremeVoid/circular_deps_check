import { describe, it, expect } from 'bun:test';
import { parseModule } from '../src/parser.js';
import type { ModuleResolver } from '../src/resolver.js';
import type { ImportRecord, ImportSpecifierInfo, ModuleInfo, Usage } from '../src/types.js';

// -------------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------------

const fakeResolver = {
  resolve: (spec: string) =>
    spec.startsWith('.') ? { path: `/proj/${spec.replace('./', '')}.ts`, external: false } : { path: null, external: true },
  isExternalPackage: (s: string) => !s.startsWith('.'),
} as unknown as ModuleResolver;

type Opts = Partial<{ emitDecoratorMetadata: boolean; verbatimModuleSyntax: boolean; angular: boolean }>;

const parse = (src: string, opts: Opts = {}): ModuleInfo =>
  parseModule('/proj/file.ts', src, {
    root: '/proj',
    resolver: fakeResolver,
    emitDecoratorMetadata: false,
    verbatimModuleSyntax: false,
    angular: true,
    ...opts,
  });

const spec = (mod: ModuleInfo, local: string): ImportSpecifierInfo =>
  mod.imports.flatMap((i) => i.specifiers).find((s) => s.local === local)!;

const record = (mod: ModuleInfo, specifierText: string, kind?: ImportRecord['kind']): ImportRecord =>
  mod.imports.find((i) => i.specifierText === specifierText && (kind === undefined || i.kind === kind))!;

const usage = (mod: ModuleInfo, local: string, index = 0): Usage => spec(mod, local).usages[index]!;

const exp = (mod: ModuleInfo, name: string) => mod.exports.find((e) => e.name === name)!;

// -------------------------------------------------------------------------------------------------
// 1-3: top-level / extends / implements
// -------------------------------------------------------------------------------------------------

describe('parseModule usage classification', () => {
  it('1. top-level `export const x = Foo.bar` is eager (top-level)', () => {
    const mod = parse(`
import { Foo } from './foo';
export const x = Foo.bar;
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(1);
    expect(s.usages[0]!.contextKind).toBe('top-level');
    expect(s.usages[0]!.context).toContain('const x');
    expect(s.usages[0]!.line).toBe(3);
  });

  it('2. `class A extends Base {}` is eager (extends)', () => {
    const mod = parse(`
import { Base } from './base';
class A extends Base {}
`);
    const s = spec(mod, 'Base');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages[0]!.contextKind).toBe('extends');
    expect(s.usages[0]!.context).toContain('A');
  });

  it('3. `class A implements Iface {}` is type-only', () => {
    const mod = parse(`
import { Iface } from './iface';
class A implements Iface {}
`);
    const s = spec(mod, 'Iface');
    expect(s.effectiveTiming).toBe('type');
    expect(s.usages[0]!.contextKind).toBe('type');
  });

  // -----------------------------------------------------------------------------------------------
  // 4: type positions
  // -----------------------------------------------------------------------------------------------

  it('4. annotations / generics / satisfies / as / typeof / interface extends are type-only', () => {
    const mod = parse(`
import { Foo } from './foo';
export const a: Foo = null!;
export const b = new Array<Foo>();
export const c = {} satisfies Foo;
export const d = {} as Foo;
export let e: typeof Foo;
export interface I extends Foo {}
`);
    const s = spec(mod, 'Foo');
    expect(s.usages.length).toBe(6);
    for (const u of s.usages) {
      expect(u.timing).toBe('type');
      expect(u.contextKind).toBe('type');
    }
    expect(s.effectiveTiming).toBe('type');
  });

  it('4b. `import type` and `import { type X }` mark the specifier typeOnly and the record erased', () => {
    const mod = parse(`
import type { T1 } from './t1';
import { type T2 } from './t2';
export let a: T1;
export let b: T2;
`);
    expect(spec(mod, 'T1').typeOnly).toBe(true);
    expect(record(mod, './t1').typeOnly).toBe(true);
    expect(record(mod, './t1').erased).toBe(true);

    expect(spec(mod, 'T2').typeOnly).toBe(true);
    expect(record(mod, './t2').typeOnly).toBe(false);
    expect(record(mod, './t2').erased).toBe(true);
  });

  // -----------------------------------------------------------------------------------------------
  // 5: function bodies
  // -----------------------------------------------------------------------------------------------

  it('5. usage inside function / method / constructor / arrow is deferred (function-body)', () => {
    const mod = parse(`
import { Foo } from './foo';
export function foo() { Foo.init(); }
export class A { bar() { Foo.x; } constructor() { Foo.y; } }
export const arrow = () => Foo.z;
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('deferred');
    expect(s.usages).toHaveLength(4);
    for (const u of s.usages) {
      expect(u.timing).toBe('deferred');
      expect(u.contextKind).toBe('function-body');
    }
    expect(s.usages[0]!.context).toContain('foo()');
    expect(s.usages[1]!.context).toContain('A.bar()');
    expect(s.usages[2]!.context).toContain('constructor of');
    expect(s.usages[3]!.context).toContain('arrow()');
  });

  // -----------------------------------------------------------------------------------------------
  // 6: class fields
  // -----------------------------------------------------------------------------------------------

  it('6. instance field deferred (class-field); static field & static block eager (static-member)', () => {
    const mod = parse(`
import { inject } from '@angular/core';
import { Foo } from './foo';
export class A {
  x = inject(Foo);
  static s = Foo.y;
  static { Foo.init(); }
}
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(3);
    expect(s.usages[0]!.timing).toBe('deferred');
    expect(s.usages[0]!.contextKind).toBe('class-field');
    expect(s.usages[0]!.context).toContain('A.x');

    expect(s.usages[1]!.timing).toBe('eager');
    expect(s.usages[1]!.contextKind).toBe('static-member');
    expect(s.usages[1]!.context).toContain('A.s');

    expect(s.usages[2]!.timing).toBe('eager');
    expect(s.usages[2]!.contextKind).toBe('static-member');
    expect(s.usages[2]!.context).toContain('static block');

    expect(s.effectiveTiming).toBe('eager');
  });

  // -----------------------------------------------------------------------------------------------
  // 7-8: decorators
  // -----------------------------------------------------------------------------------------------

  it('7. decorator arguments are eager with decorator/property; forwardRef arrow is deferred', () => {
    const mod = parse(`
import { Component, forwardRef } from '@angular/core';
import { Foo } from './foo';
import { Bar } from './bar';
import { Baz } from './baz';
@Component({ imports: [Foo, forwardRef(() => Baz)], providers: [Bar] })
export class C {}
`);
    const foo = usage(mod, 'Foo');
    expect(spec(mod, 'Foo').effectiveTiming).toBe('eager');
    expect(foo.contextKind).toBe('decorator');
    expect(foo.decorator).toBe('Component');
    expect(foo.property).toBe('imports');

    const bar = usage(mod, 'Bar');
    expect(bar.timing).toBe('eager');
    expect(bar.contextKind).toBe('decorator');
    expect(bar.decorator).toBe('Component');
    expect(bar.property).toBe('providers');

    const baz = usage(mod, 'Baz');
    expect(spec(mod, 'Baz').effectiveTiming).toBe('deferred');
    expect(baz.contextKind).toBe('function-body');
    expect(baz.context).toContain('forwardRef');
  });

  it('8. property decorator argument is eager, the field initializer is deferred', () => {
    const mod = parse(`
import { Input } from '@angular/core';
import { Foo } from './foo';
import { Bar } from './bar';
export class A { @Input(Bar.opts) x = Foo.DEFAULT; }
`);
    const bar = spec(mod, 'Bar');
    expect(bar.effectiveTiming).toBe('eager');
    expect(bar.usages[0]!.contextKind).toBe('decorator');
    expect(bar.usages[0]!.decorator).toBe('Input');

    const foo = spec(mod, 'Foo');
    expect(foo.effectiveTiming).toBe('deferred');
    expect(foo.usages[0]!.contextKind).toBe('class-field');
  });

  // -----------------------------------------------------------------------------------------------
  // 9-10: IIFE and eager local calls
  // -----------------------------------------------------------------------------------------------

  it('9. top-level IIFEs (arrow and function expression) are eager', () => {
    const mod = parse(`
import { Foo } from './foo';
(() => { Foo.init(); })();
(function () { Foo.start(); })();
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(2);
    for (const u of s.usages) {
      expect(u.timing).toBe('eager');
      expect(u.contextKind).toBe('top-level');
      expect(u.context).toContain('immediately-invoked');
    }
  });

  it('10a. local function called at top level makes its body eager (top-level-call)', () => {
    const mod = parse(`
import { Foo } from './foo';
function setup() { Foo.init(); }
setup();
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(1);
    expect(s.usages[0]!.contextKind).toBe('top-level-call');
    expect(s.usages[0]!.context).toContain('setup()');
  });

  it('10b. the same local function NOT called stays deferred', () => {
    const mod = parse(`
import { Foo } from './foo';
function setup() { Foo.init(); }
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('deferred');
    expect(s.usages[0]!.contextKind).toBe('function-body');
  });

  it('10c. transitive eager calls: a() -> b() -> Foo', () => {
    const mod = parse(`
import { Foo } from './foo';
function a() { b(); }
function b() { Foo.x; }
a();
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages[0]!.contextKind).toBe('top-level-call');
    expect(s.usages[0]!.context).toContain('b()');
  });

  it('10d. `new LocalClass()` at top level makes its instance field initializers eager', () => {
    const mod = parse(`
import { Foo } from './foo';
class L { x = Foo.y; constructor() { Foo.z; } }
new L();
`);
    const s = spec(mod, 'Foo');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(2);
    for (const u of s.usages) {
      expect(u.timing).toBe('eager');
      expect(u.contextKind).toBe('top-level-call');
      expect(u.context).toContain('L');
    }
  });

  // -----------------------------------------------------------------------------------------------
  // 11: enum / namespace / declare
  // -----------------------------------------------------------------------------------------------

  it('11. enum member and namespace body are eager; `declare` is type', () => {
    const mod = parse(`
import { Foo } from './foo';
enum E { A = Foo.value }
namespace N { export const x = Foo.y }
declare const z: Foo;
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(3);
    expect(s.usages[0]!.timing).toBe('eager');
    expect(s.usages[0]!.contextKind).toBe('enum-member');
    expect(s.usages[0]!.context).toContain('E');

    expect(s.usages[1]!.timing).toBe('eager');
    expect(s.usages[1]!.contextKind).toBe('namespace-body');
    expect(s.usages[1]!.context).toContain('N');

    expect(s.usages[2]!.timing).toBe('type');
    expect(s.usages[2]!.contextKind).toBe('type');
  });

  // -----------------------------------------------------------------------------------------------
  // 12: shadowing
  // -----------------------------------------------------------------------------------------------

  it('12a. a parameter named like the import shadows it', () => {
    const mod = parse(`
import { Foo } from './foo';
export function f(Foo: string) { return Foo; }
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(0);
    expect(s.effectiveTiming).toBe('unused');
  });

  it('12b. a local const named like the import shadows it', () => {
    const mod = parse(`
import { Foo } from './foo';
export function g() { const Foo = 1; return Foo; }
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(0);
    expect(s.effectiveTiming).toBe('unused');
  });

  it('12c. shadowing inside a nested block', () => {
    const mod = parse(`
import { Foo } from './foo';
export function h(c: boolean) { if (c) { const Foo = 2; return Foo.x; } return 0; }
{ const Foo = 3; Foo.y; }
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(0);
    expect(s.effectiveTiming).toBe('unused');
  });

  // Discrepancy: `collectBlockDeclarations` descends into nested blocks (it only stops at
  // function-/class-likes), so a `const Foo` declared in an *inner* block is registered on the
  // enclosing function scope and hides the import for the whole function body.
  // Input : function h() { { const Foo = 1; } return Foo.x; }
  // Actual: no usage recorded for `Foo` (effectiveTiming 'unused')
  // Expected: one deferred usage on `return Foo.x` (the inner-block const is out of scope there)
  it('12d. a const in an inner block must not shadow the import outside that block', () => {
    const mod = parse(`
import { Foo } from './foo';
export function h() { { const Foo = 1; } return Foo.x; }
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(1);
    expect(s.effectiveTiming).toBe('deferred');
  });

  it('12e. catch clause variable shadows the import', () => {
    const mod = parse(`
import { Foo } from './foo';
try { run(); } catch (Foo) { Foo.message; }
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(0);
    expect(s.effectiveTiming).toBe('unused');
  });

  // -----------------------------------------------------------------------------------------------
  // 13-14: namespace / default imports
  // -----------------------------------------------------------------------------------------------

  it('13. namespace import records the accessed member', () => {
    const mod = parse(`
import * as ns from './m';
ns.Foo;
ns['Bar'];
use(ns);
`);
    const s = spec(mod, 'ns');
    expect(s.imported).toBe('*');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(3);
    expect(s.usages[0]!.member).toBe('Foo');
    expect(s.usages[0]!.timing).toBe('eager');
    expect(s.usages[1]!.member).toBe('Bar');
    expect(s.usages[2]!.member).toBeUndefined();
  });

  it('14. default import has imported === "default"', () => {
    const mod = parse(`
import Foo from './m';
Foo.x;
`);
    const s = spec(mod, 'Foo');
    expect(s.imported).toBe('default');
    expect(s.local).toBe('Foo');
    expect(s.effectiveTiming).toBe('eager');
  });

  // -----------------------------------------------------------------------------------------------
  // 15: side-effect / dynamic / import-equals / require
  // -----------------------------------------------------------------------------------------------

  it('15. side-effect, dynamic (deferred vs top-level await), import-equals and require records', () => {
    const mod = parse(`
import './polyfills';
import y = require('./y');
export function lazy() { return import('./x'); }
export const z = await import('./z');
const r = require('./r');
`);
    const side = record(mod, './polyfills');
    expect(side.kind).toBe('side-effect');
    expect(side.erased).toBe(false);
    expect(side.resolvedPath).toBe('/proj/polyfills.ts');

    const eq = record(mod, './y');
    expect(eq.kind).toBe('import-equals');
    expect(eq.specifiers[0]!.local).toBe('y');
    expect(eq.specifiers[0]!.imported).toBe('*');

    const dyn = record(mod, './x');
    expect(dyn.kind).toBe('dynamic');
    expect(dyn.dynamicAtTopLevel).toBe(false);
    expect(dyn.erased).toBe(false);

    const top = record(mod, './z');
    expect(top.kind).toBe('dynamic');
    expect(top.dynamicAtTopLevel).toBe(true);

    const req = record(mod, './r');
    expect(req.kind).toBe('require');
    expect(req.erased).toBe(false);
    expect(req.specifiers[0]!.usages[0]!.timing).toBe('eager');
  });

  // -----------------------------------------------------------------------------------------------
  // 16: re-exports
  // -----------------------------------------------------------------------------------------------

  it('16a. `export * from` -> reexport-all + exportStar', () => {
    const mod = parse(`export * from './a';`);
    const r = record(mod, './a');
    expect(r.kind).toBe('reexport-all');
    expect(mod.exportStar).toEqual(['/proj/a.ts']);
    expect(mod.isBarrel).toBe(true);
  });

  it('16b. `export { A as B } from` -> reexport record + export record', () => {
    const mod = parse(`export { A as B } from './a';`);
    const r = record(mod, './a');
    expect(r.kind).toBe('reexport');
    expect(r.reexportedNames).toEqual([{ exported: 'B', imported: 'A' }]);
    const e = exp(mod, 'B');
    expect(e.kind).toBe('reexport');
    expect(e.importedName).toBe('A');
    expect(e.from).toBe('/proj/a.ts');
    expect(e.hoisted).toBe(false);
  });

  it('16c. `export * as ns from`', () => {
    const mod = parse(`export * as ns from './a';`);
    const r = record(mod, './a');
    expect(r.kind).toBe('reexport');
    expect(r.reexportedNames).toEqual([{ exported: 'ns', imported: '*' }]);
    const e = exp(mod, 'ns');
    expect(e.kind).toBe('reexport');
    expect(e.importedName).toBe('*');
    expect(e.from).toBe('/proj/a.ts');
  });

  it('16d. `export type { T } from` -> typeOnly/erased record and export kind type', () => {
    const mod = parse(`export type { T } from './t';`);
    const r = record(mod, './t');
    expect(r.typeOnly).toBe(true);
    expect(r.erased).toBe(true);
    expect(exp(mod, 'T').kind).toBe('type');
  });

  it('16e. `import { A }; export { A }` -> export record reexport with from', () => {
    const mod = parse(`
import { A } from './a';
export { A };
`);
    const e = exp(mod, 'A');
    expect(e.kind).toBe('reexport');
    expect(e.from).toBe('/proj/a.ts');
    expect(e.importedName).toBe('A');
    expect(mod.isBarrel).toBe(true);
  });

  // Discrepancy: the import backing a local `export { A }` re-export is reported as erased.
  // `walkTopLevel` skips ExportDeclarations entirely so `A` gets no usage, effectiveTiming is
  // 'unused' and `isErased` returns true. TypeScript keeps this import (it is a value re-export;
  // under isolatedModules a type would even require `export type`), so the graph phase drops a
  // real runtime edge (applyRecord ignores erased records).
  // Input : import { A } from './a'; export { A };
  // Actual: record.erased === true, spec(A).effectiveTiming === 'unused'
  // Expected: record.erased === false
  it('16f. the import behind `export { A }` is not erased', () => {
    const mod = parse(`
import { A } from './a';
export { A };
`);
    expect(record(mod, './a').erased).toBe(false);
    expect(spec(mod, 'A').reexported).toBe(true);
    expect(mod.isBarrel).toBe(true);
  });

  it('16h. a type-only local re-export does not keep the import alive', () => {
    const mod = parse(`
import { A } from './a';
export type { A };
`);
    expect(record(mod, './a').erased).toBe(true);
  });

  it('16g. a file with any own declaration is not a barrel', () => {
    const mod = parse(`
export * from './a';
export const own = 1;
`);
    expect(mod.isBarrel).toBe(false);
  });

  // -----------------------------------------------------------------------------------------------
  // 17: export kinds
  // -----------------------------------------------------------------------------------------------

  it('17a. declaration export kinds and hoisting', () => {
    const mod = parse(`
export class C {}
export function f() {}
export const c1 = 1;
export let l1 = 1;
export var v1 = 1;
export enum E { A }
export interface I {}
export type T = string;
export namespace N { export const q = 1; }
`);
    expect(exp(mod, 'C')).toMatchObject({ kind: 'class', hoisted: false });
    expect(exp(mod, 'f')).toMatchObject({ kind: 'function', hoisted: true });
    expect(exp(mod, 'c1')).toMatchObject({ kind: 'const', hoisted: false });
    expect(exp(mod, 'l1')).toMatchObject({ kind: 'let' });
    expect(exp(mod, 'v1')).toMatchObject({ kind: 'var' });
    expect(exp(mod, 'E')).toMatchObject({ kind: 'enum' });
    expect(exp(mod, 'I')).toMatchObject({ kind: 'interface' });
    expect(exp(mod, 'T')).toMatchObject({ kind: 'type' });
    expect(exp(mod, 'N')).toMatchObject({ kind: 'namespace' });
    expect(mod.exports).toHaveLength(9);
  });

  it('17b. `export default class X`', () => {
    const mod = parse(`export default class X {}`);
    expect(exp(mod, 'default')).toMatchObject({ kind: 'class', hoisted: false });
  });

  it('17c. `export default function` is hoisted', () => {
    const mod = parse(`export default function () {}`);
    expect(exp(mod, 'default')).toMatchObject({ kind: 'function', hoisted: true });
  });

  it('17d. `export default expr` has kind const', () => {
    const mod = parse(`export default 42;`);
    expect(exp(mod, 'default')).toMatchObject({ kind: 'const', hoisted: false });
  });

  it('17e. `export { localFn }` of a local function is hoisted', () => {
    const mod = parse(`
function localFn() {}
const localConst = 1;
export { localFn, localConst as renamed };
`);
    expect(exp(mod, 'localFn')).toMatchObject({ kind: 'function', hoisted: true });
    expect(exp(mod, 'renamed')).toMatchObject({ kind: 'const', hoisted: false });
    expect(exp(mod, 'localFn').from).toBeUndefined();
  });

  it('17f. destructured `export const { a, b } = obj` yields two export records', () => {
    const mod = parse(`
declare const obj: { a: number; b: number };
export const { a, b } = obj;
`);
    expect(exp(mod, 'a')).toMatchObject({ kind: 'const' });
    expect(exp(mod, 'b')).toMatchObject({ kind: 'const' });
    expect(mod.exports.filter((e) => e.name === 'a' || e.name === 'b')).toHaveLength(2);
  });

  // -----------------------------------------------------------------------------------------------
  // 18: usesImports
  // -----------------------------------------------------------------------------------------------

  it('18. usesImports lists value usages but not type-only ones', () => {
    const mod = parse(`
import { Base } from './base';
import { helper } from './helper';
import { Iface } from './iface';
export class A extends Base implements Iface { m() { return helper(); } }
`);
    const e = exp(mod, 'A');
    expect(e.usesImports).toContain('Base');
    expect(e.usesImports).toContain('helper');
    expect(e.usesImports).not.toContain('Iface');
  });

  // -----------------------------------------------------------------------------------------------
  // 19: erasure
  // -----------------------------------------------------------------------------------------------

  it('19a. import used only as a type is erased', () => {
    const mod = parse(`
import { Foo } from './foo';
export let x: Foo;
`);
    expect(spec(mod, 'Foo').effectiveTiming).toBe('type');
    expect(record(mod, './foo').erased).toBe(true);
  });

  it('19b. unused import is erased', () => {
    const mod = parse(`import { Foo } from './foo';`);
    expect(spec(mod, 'Foo').effectiveTiming).toBe('unused');
    expect(record(mod, './foo').erased).toBe(true);
  });

  it('19c. with verbatimModuleSyntax plain imports are kept; only type imports are erased', () => {
    const mod = parse(
      `
import { Unused } from './unused';
import { TypeUsed } from './type-used';
import type { T1 } from './t1';
import { type T2 } from './t2';
export let x: TypeUsed;
`,
      { verbatimModuleSyntax: true },
    );
    expect(record(mod, './unused').erased).toBe(false);
    expect(record(mod, './type-used').erased).toBe(false);
    expect(spec(mod, 'TypeUsed').effectiveTiming).toBe('type');
    expect(record(mod, './t1').erased).toBe(true);
    expect(record(mod, './t2').erased).toBe(true);
  });

  // -----------------------------------------------------------------------------------------------
  // 20: emitDecoratorMetadata
  // -----------------------------------------------------------------------------------------------

  const ctorSrc = `
import { Injectable } from '@angular/core';
import { BService } from './b';
@Injectable()
export class S { constructor(private b: BService) {} }
`;
  // A non-Angular decorator (class-transformer, typedi, NestJS-style …): TypeScript emits design:paramtypes.
  const customSrc = `
import { Service } from 'some-di-lib';
import { BService } from './b';
@Service()
export class S { constructor(private b: BService) {} }
`;

  it('20a0. emitDecoratorMetadata is not emitted for Angular-decorated classes (ngtsc strips the decorators first)', () => {
    const mod = parse(ctorSrc, { emitDecoratorMetadata: true });
    const s = spec(mod, 'BService');
    expect(s.effectiveTiming).toBe('deferred');
    expect(s.usages[0]!.contextKind).toBe('di-factory');
  });

  it('20a. emitDecoratorMetadata: constructor param type of a class with a non-Angular decorator is eager', () => {
    const mod = parse(customSrc, { emitDecoratorMetadata: true });
    const s = spec(mod, 'BService');
    expect(s.effectiveTiming).toBe('eager');
    expect(s.usages).toHaveLength(1);
    expect(s.usages[0]!.contextKind).toBe('decorator-metadata');
    expect(record(mod, './b').erased).toBe(false);
  });

  it('20b. without emitDecoratorMetadata an Angular constructor param is a deferred factory reference (ngtsc factory)', () => {
    const mod = parse(ctorSrc, { emitDecoratorMetadata: false });
    const s = spec(mod, 'BService');
    expect(s.effectiveTiming).toBe('deferred');
    expect(s.usages).toHaveLength(1);
    expect(s.usages[0]!.contextKind).toBe('di-factory');
    expect(record(mod, './b').erased).toBe(false);
  });

  it('20b2. non-Angular decorated classes and @Inject() params keep constructor types type-only', () => {
    const mod = parse(`
import { Inject, Injectable } from '@angular/core';
import { Plain } from './plain';
import { Tok, TokType } from './tok';
function Custom(): ClassDecorator { return () => {}; }
@Custom()
export class A { constructor(private p: Plain) {} }
@Injectable()
export class B { constructor(@Inject(Tok) private t: TokType) {} }
`);
    expect(spec(mod, 'Plain').effectiveTiming).toBe('type');
    expect(record(mod, './plain').erased).toBe(true);
    expect(spec(mod, 'TokType').effectiveTiming).toBe('type');
    expect(spec(mod, 'Tok').effectiveTiming).toBe('deferred');
  });

  it('20c. undecorated class stays type-only even with emitDecoratorMetadata', () => {
    const mod = parse(
      `
import { BService } from './b';
export class S { constructor(private b: BService) {} }
`,
      { emitDecoratorMetadata: true },
    );
    expect(spec(mod, 'BService').effectiveTiming).toBe('type');
  });

  it('20d. decorated property type `@Input() x: Foo` is eager metadata', () => {
    const mod = parse(
      `
import { Component, Input } from '@angular/core';
import { Expose } from 'class-transformer';
import { Foo } from './foo';
import { Plain } from './plain';
import { NgOnly } from './ng-only';
@Component({})
export class C { @Expose() x: Foo; y: Plain; @Input() z: NgOnly; }
`,
      { emitDecoratorMetadata: true },
    );
    // Angular member decorators are stripped by ngtsc: no design:type for `z`
    expect(spec(mod, 'NgOnly').effectiveTiming).toBe('type');
    const foo = spec(mod, 'Foo');
    expect(foo.effectiveTiming).toBe('eager');
    expect(foo.usages[0]!.contextKind).toBe('decorator-metadata');
    // undecorated property: no design:type emitted
    expect(spec(mod, 'Plain').effectiveTiming).toBe('type');
  });

  // -----------------------------------------------------------------------------------------------
  // 21: Angular extraction
  // -----------------------------------------------------------------------------------------------

  it('21a. Injectable: providedIn, constructor params, inject() in constructor and fields', () => {
    const mod = parse(`
import { Injectable, Inject, Optional, SkipSelf, Attribute, inject } from '@angular/core';
import { TOKEN, T, Parent, AService, Logger, BService } from './deps';
@Injectable({ providedIn: 'root' })
export class S {
  constructor(
    @Inject(TOKEN) t: T,
    @Optional() @SkipSelf() private p: Parent,
    private a: AService,
    @Attribute('x') attr: string,
  ) {
    const l = inject(Logger);
  }
  private b = inject(BService, { optional: true });
}
`);
    expect(mod.angular).toHaveLength(1);
    const ng = mod.angular[0]!;
    expect(ng.name).toBe('S');
    expect(ng.decorator).toBe('Injectable');
    expect(ng.providedIn).toBe('root');

    const byToken = Object.fromEntries(ng.deps.map((d) => [d.token, d]));
    expect(Object.keys(byToken).sort()).toEqual(['AService', 'BService', 'Logger', 'Parent', 'TOKEN']);
    expect(byToken['TOKEN']).toMatchObject({ via: 'constructor-param', flags: {} });
    expect(byToken['Parent']).toMatchObject({ via: 'constructor-param', flags: { optional: true, skipSelf: true } });
    expect(byToken['AService']).toMatchObject({ via: 'constructor-param', flags: {} });
    expect(byToken['Logger']).toMatchObject({ via: 'inject-constructor' });
    expect(byToken['BService']).toMatchObject({ via: 'inject-field', flags: { optional: true } });
    // @Attribute() params are not DI deps
    expect(ng.deps.some((d) => d.token === 'string' || d.token === 'attr')).toBe(false);
  });

  it('21b. Component: providers (provide/useClass/deps) and imports with forwardRef', () => {
    const mod = parse(`
import { Component, forwardRef } from '@angular/core';
import { X, Y, Z, W, f, Q, A, B } from './deps';
@Component({
  providers: [X, { provide: Y, useClass: Z }, { provide: W, useFactory: f, deps: [Q] }],
  imports: [A, forwardRef(() => B)],
})
export class C {}
`);
    const ng = mod.angular[0]!;
    expect(ng.decorator).toBe('Component');
    expect(ng.providers).toHaveLength(3);
    expect(ng.providers[0]).toMatchObject({ provide: 'X' });
    expect(ng.providers[1]).toMatchObject({ provide: 'Y', useClass: 'Z' });
    expect(ng.providers[2]).toMatchObject({ provide: 'W', deps: [{ token: 'Q', flags: {} }] });
    expect(ng.imports).toEqual(['A', 'B']);
  });

  it('21c. inject() inside a method or an arrow field is not collected', () => {
    const mod = parse(`
import { Injectable, inject } from '@angular/core';
import { Foo, Bar } from './deps';
@Injectable()
export class S {
  private f = () => inject(Foo);
  m() { return inject(Bar); }
}
`);
    expect(mod.angular).toHaveLength(1);
    expect(mod.angular[0]!.deps).toEqual([]);
  });

  it('21d. an undecorated class is only recorded (as a potential base class) when it injects something', () => {
    const mod = parse(`
import { inject } from '@angular/core';
import { Foo } from './deps';
export class Base { private f = inject(Foo); }
export class Plain { x = 1; }
`);
    expect(mod.angular.map((a) => [a.name, a.decorator])).toEqual([['Base', 'none']]);
    expect(mod.angular[0]!.deps.map((d) => d.token)).toEqual(['Foo']);
  });

  it('21f. provider deps keep resolution flags; nullable parameter types are unwrapped', () => {
    const mod = parse(`
import { Component, Injectable, Optional, SkipSelf } from '@angular/core';
import { Registry, Parent } from './deps';
@Component({ providers: [{ provide: Registry, useFactory: (p: Registry) => p ?? new Registry(), deps: [[new Optional(), new SkipSelf(), Registry]] }] })
export class C {}
@Injectable()
export class S { constructor(@Optional() p: Parent | null) {} }
`);
    const c = mod.angular.find((a) => a.name === 'C')!;
    expect(c.providers[0]!.deps).toEqual([{ token: 'Registry', flags: { optional: true, skipSelf: true } }]);
    const s = mod.angular.find((a) => a.name === 'S')!;
    expect(s.deps.map((d) => [d.token, d.flags.optional])).toEqual([['Parent', true]]);
  });

  it('21e. angular: false disables extraction', () => {
    const mod = parse(
      `
import { Injectable } from '@angular/core';
@Injectable()
export class S {}
`,
      { angular: false },
    );
    expect(mod.angular).toEqual([]);
  });

  // -----------------------------------------------------------------------------------------------
  // 22: localClasses / loc
  // -----------------------------------------------------------------------------------------------

  it('22. localClasses lists top-level class/function/const names; loc is the line count', () => {
    const src = `class A {}
function f() {}
const c = 1;
export class E {}`;
    const mod = parse(src);
    expect(mod.localClasses).toEqual(expect.arrayContaining(['A', 'f', 'c']));
    expect(mod.loc).toBe(src.split('\n').length);
    expect(mod.loc).toBe(4);
    expect(mod.path).toBe('/proj/file.ts');
    expect(mod.relPath).toBe('file.ts');
    expect(mod.parseErrors).toEqual([]);
  });

  // -----------------------------------------------------------------------------------------------
  // 23: dedupe / ordering
  // -----------------------------------------------------------------------------------------------

  it('23a. the same identifier position never produces two usages (metadata + type walk)', () => {
    const mod = parse(
      `
import { Injectable } from '@angular/core';
import { BService } from './b';
@Injectable()
export class S { constructor(private b: BService) {} }
`,
      { emitDecoratorMetadata: true },
    );
    expect(spec(mod, 'BService').usages).toHaveLength(1);
  });

  it('23b. eager-call propagation upgrades in place instead of duplicating', () => {
    const mod = parse(`
import { Foo } from './foo';
function setup() { Foo.init(); Foo.done(); }
setup();
setup();
`);
    const s = spec(mod, 'Foo');
    expect(s.usages).toHaveLength(2);
    const keys = s.usages.map((u) => `${u.line}:${u.column}`);
    expect(new Set(keys).size).toBe(2);
  });

  it('23c. usages are sorted by line then column', () => {
    const mod = parse(`
import { Foo } from './foo';
export class A extends Foo { m() { Foo.a; Foo.b; } static s = Foo.c; }
export const z = Foo.d;
function later() { Foo.e; }
later();
`);
    const s = spec(mod, 'Foo');
    expect(s.usages.length).toBeGreaterThan(3);
    for (let i = 1; i < s.usages.length; i++) {
      const prev = s.usages[i - 1]!;
      const cur = s.usages[i]!;
      expect(prev.line < cur.line || (prev.line === cur.line && prev.column < cur.column)).toBe(true);
    }
  });
});
