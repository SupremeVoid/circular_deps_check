/**
 * Deterministic generator for `fixtures/05-large-generated` – a large synthetic Angular-like
 * project used by `tests/perf.test.ts`.
 *
 *   bun run scripts/generate-large-fixture.ts [--files N]   (default 3000)
 *
 * The output is fully determined by the seed (mulberry32, seed 42) and N, so every run produces
 * byte-identical files. The bulk of the import graph is a strict DAG
 * (features → shared/core, shared → core, core → core by index); the only cycles are the planted
 * ones described in `planted.json`, which the perf test asserts on.
 *
 * Layering rules that keep the planted cycles precisely classified (do not break them):
 *   - only `shared/models/defaults.ts` imports `status.enum.ts` directly (the latent cycle must
 *     always be entered through defaults.ts, also from spec entries);
 *   - nobody imports `list-item.component.ts` or `tree-node.component.ts` directly, so the
 *     evaluation order always reaches base-list / tree.component first;
 *   - `shared/index.ts` and `shared/utils/index.ts` are only imported from feature files
 *     (they are part of the barrel-induced group); shared files import each other by file;
 *   - widget components use `@shared` bindings only inside methods / instance fields / types;
 *   - planted files never get a `.spec.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CLI + PRNG
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
let targetFiles = 3000;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--files' && argv[i + 1]) targetFiles = Number(argv[++i]);
  else if (a.startsWith('--files=')) targetFiles = Number(a.slice('--files='.length));
}
if (!Number.isFinite(targetFiles) || targetFiles < 200) {
  console.error(`Invalid --files value (minimum 200): ${targetFiles}`);
  process.exit(2);
}

const SEED = 42;
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const rand = mulberry32(SEED);
const int = (n: number): number => Math.floor(rand() * n);
const chance = (p: number): boolean => rand() < p;
const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)]!;
const sample = <T>(arr: readonly T[], k: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < k && copy.length > 0) out.push(copy.splice(int(copy.length), 1)[0]!);
  return out;
};

// ---------------------------------------------------------------------------------------------
// Paths + output
// ---------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..').replace(/\\/g, '/');
const fixtureRoot = `${projectRoot}/fixtures/05-large-generated`;
const srcRoot = `${fixtureRoot}/src`;

const files = new Map<string, string>();
const write = (rel: string, content: string): void => {
  if (files.has(rel)) throw new Error(`duplicate file ${rel}`);
  files.set(rel, content.endsWith('\n') ? content : `${content}\n`);
};

const pascal = (s: string): string =>
  s
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
const camel = (s: string): string => {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
};
const constCase = (s: string): string => s.replace(/-/g, '_').toUpperCase();

const SPEC = (subjectImport: string, name: string): string => `import { ${name} } from '${subjectImport}';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;

describe('${name}', () => {
  it('exists', () => {
    void ${name};
  });
});
`;

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

const FEATURES = [
  'widgets', 'dashboard', 'orders', 'customers', 'invoices', 'products', 'inventory', 'shipping',
  'billing', 'reports', 'settings', 'profile', 'notifications', 'search', 'catalog', 'cart',
  'checkout', 'payments', 'returns', 'reviews', 'support', 'tickets', 'analytics', 'audit',
  'users', 'roles', 'permissions', 'teams', 'projects', 'tasks', 'calendar', 'messages',
  'documents', 'uploads', 'media', 'tags', 'categories', 'vendors', 'contracts', 'warehouse',
];
const EAGER_FEATURES = 20; // app.routes: `component:` references
const LAZY_FEATURES = 10; // app.routes: loadChildren
// remaining features are mounted eagerly via `children: X_ROUTES`

const COMPONENT_NOUNS = [
  'list', 'detail', 'card', 'form', 'table', 'header', 'footer', 'sidebar', 'toolbar', 'filter',
  'summary', 'chart', 'badge', 'panel', 'dialog', 'editor', 'preview', 'status', 'timeline', 'grid',
  'row', 'cell', 'menu', 'tab', 'wizard', 'stepper', 'banner', 'avatar', 'tooltip', 'pager',
  'picker', 'toggle', 'tree', 'stat', 'overview', 'history', 'export', 'import', 'legend', 'note',
];
const SERVICE_NOUNS = ['data', 'api', 'state', 'search', 'audit', 'export', 'import', 'validation', 'mapper', 'facade', 'store', 'query', 'command', 'events', 'config', 'metrics'];
const MODEL_NOUNS = ['item', 'filter', 'summary', 'request', 'response', 'page', 'config', 'event', 'draft', 'audit', 'stats', 'row'];

const CORE_SERVICES = [
  'config', 'logger', 'api', 'auth', 'storage', 'notification', 'theme', 'i18n', 'analytics',
  'feature-flag', 'session', 'profile', 'error-handler', 'clock', 'telemetry', 'permissions',
];
const SESSION_IDX = CORE_SERVICES.indexOf('session');
const PROFILE_IDX = CORE_SERVICES.indexOf('profile');

const SHARED_MODELS = [
  'user', 'page', 'sort', 'address', 'money', 'date-range', 'option', 'column', 'action',
  'permission', 'theme', 'locale', 'chart-point', 'notification', 'file-ref', 'tag', 'comment',
  'audit-entry', 'kpi', 'dimension', 'breadcrumb', 'link', 'icon', 'label', 'tree-node-data',
];
const SHARED_UTILS = [
  'format', 'array', 'string', 'date', 'object', 'validation', 'id', 'math', 'color', 'url',
  'storage', 'debounce', 'compare', 'tree', 'money', 'text',
];
const SHARED_PIPES = [
  'money', 'date', 'truncate', 'capitalize', 'status', 'plural', 'file-size', 'relative-time',
  'initials', 'highlight', 'sort', 'filter', 'join', 'default', 'percent', 'duration',
];
const SHARED_DIRECTIVES = [
  'highlight', 'autofocus', 'click-outside', 'tooltip', 'permission', 'lazy-load', 'resize',
  'drag', 'drop', 'sticky', 'scroll-spy', 'theme',
];
const SHARED_UI = [
  'badge', 'button', 'icon', 'spinner', 'avatar', 'card', 'chip', 'divider', 'alert', 'toast',
  'modal', 'drawer', 'tabs', 'tab', 'accordion', 'breadcrumbs', 'pagination', 'table', 'table-row',
  'table-cell', 'toolbar', 'menu', 'menu-item', 'dropdown', 'select', 'input', 'checkbox', 'radio',
  'switch', 'slider', 'date-picker', 'time-picker', 'progress', 'skeleton', 'empty-state', 'stat',
  'kpi-tile', 'chart', 'legend', 'stepper',
];

// ---------------------------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------------------------

const SPEC_RATE = 0.3;
const TYPE_IMPORT_RATE = 0.3;
const FIXED_ESTIMATE =
  4 + CORE_SERVICES.length + 1 + 5 + SHARED_MODELS.length + 4 + SHARED_UTILS.length + 2 +
  SHARED_PIPES.length + 2 + SHARED_DIRECTIVES.length + 1 + SHARED_UI.length + 1 + 4 + 4 + 3 + 1 + 30;
const perFeatureBudget = Math.max(12, Math.round((targetFiles - FIXED_ESTIMATE) / FEATURES.length));
const MODELS_PER_FEATURE = Math.min(MODEL_NOUNS.length, Math.max(2, Math.round(perFeatureBudget * 0.09)));
const SERVICES_PER_FEATURE = Math.min(SERVICE_NOUNS.length, Math.max(2, Math.round(perFeatureBudget * 0.12)));
const COMPONENTS_PER_FEATURE = Math.max(
  4,
  Math.round((perFeatureBudget - 2 - MODELS_PER_FEATURE - SERVICES_PER_FEATURE * (1 + SPEC_RATE)) / (1 + SPEC_RATE)),
);
const WIDGETS_IN_GROUP = 15;

// ---------------------------------------------------------------------------------------------
// Planted cycle bookkeeping
// ---------------------------------------------------------------------------------------------

const P = {
  baseList: 'src/app/shared/base/base-list.component.ts',
  listItem: 'src/app/shared/list/list-item.component.ts',
  listIndex: 'src/app/shared/list/index.ts',
  tree: 'src/app/shared/tree/tree.component.ts',
  treeNode: 'src/app/shared/tree/tree-node.component.ts',
  session: 'src/app/core/session.service.ts',
  profile: 'src/app/core/profile.service.ts',
  statusEnum: 'src/app/shared/models/status.enum.ts',
  defaults: 'src/app/shared/models/defaults.ts',
  ordersSync: 'src/app/features/orders/orders-sync.service.ts',
  ordersCache: 'src/app/features/orders/orders-cache.service.ts',
  invoiceModel: 'src/app/shared/models/invoice.model.ts',
  customerModel: 'src/app/shared/models/customer.model.ts',
  sharedIndex: 'src/app/shared/index.ts',
  utilsIndex: 'src/app/shared/utils/index.ts',
  registryUtil: 'src/app/shared/utils/registry.util.ts',
  widgetsIndex: 'src/app/features/widgets/index.ts',
};
const groupWidgets: string[] = [];

// ---------------------------------------------------------------------------------------------
// main / app
// ---------------------------------------------------------------------------------------------

write('src/main.ts', `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
`);

write('src/app/app.config.ts', `import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
`);

write('src/app/app.component.ts', `import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionService } from '@core/session.service';
import { ThemeService } from '@core/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class AppComponent {
  private readonly session = inject(SessionService);
  private readonly theme = inject(ThemeService);

  title(): string {
    return this.session.value('title') + this.theme.value('accent');
  }
}
`);

// ---------------------------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------------------------

const serviceClass = (name: string): string => `${pascal(name)}Service`;

for (let i = 0; i < CORE_SERVICES.length; i++) {
  const name = CORE_SERVICES[i]!;
  const cls = serviceClass(name);
  const lines: string[] = [];
  const ctorParams: string[] = [];
  const fields: string[] = [];
  const uses: string[] = [];

  if (i === SESSION_IDX) {
    // planted DI cycle: SessionService -(constructor)-> ProfileService -(inject)-> SessionService
    lines.push(`import { Injectable } from '@angular/core';`);
    lines.push(`import { ConfigService } from './config.service';`);
    lines.push(`import { ProfileService } from './profile.service';`);
    ctorParams.push('private readonly config: ConfigService', 'private readonly profile: ProfileService');
    uses.push('this.profile.value(key)', 'this.config.value(key)');
  } else if (i === PROFILE_IDX) {
    lines.push(`import { Injectable, inject } from '@angular/core';`);
    lines.push(`import { LoggerService } from './logger.service';`);
    lines.push(`import { SessionService } from './session.service';`);
    fields.push('private readonly session = inject(SessionService);', 'private readonly logger = inject(LoggerService);');
    uses.push('this.session.run(key)');
  } else {
    // DAG: only services with a lower index; services before the planted pair never touch it.
    const candidates = CORE_SERVICES.slice(0, i);
    const deps = sample(candidates, Math.min(candidates.length, int(3)));
    const needInject = deps.length > 0 && chance(0.5);
    lines.push(`import { Injectable${needInject ? ', inject' : ''} } from '@angular/core';`);
    for (const d of deps) lines.push(`import { ${serviceClass(d)} } from './${d}.service';`);
    for (const d of deps) {
      const prop = camel(d);
      if (needInject) fields.push(`private readonly ${prop} = inject(${serviceClass(d)});`);
      else ctorParams.push(`private readonly ${prop}: ${serviceClass(d)}`);
      uses.push(`this.${prop}.value(key)`);
    }
  }
  lines.push('');
  lines.push(`@Injectable({ providedIn: 'root' })`);
  lines.push(`export class ${cls} {`);
  lines.push(`  readonly name = '${name}';`);
  for (const f of fields) lines.push(`  ${f}`);
  if (ctorParams.length > 0) lines.push(`\n  constructor(${ctorParams.map((p) => `\n    ${p},`).join('')}\n  ) {}`);
  lines.push('');
  lines.push(`  value(key: string): string {`);
  lines.push(`    return [${['this.name', 'key', ...uses].join(', ')}].join(':');`);
  lines.push(`  }`);
  lines.push('');
  lines.push(`  run(input: string): string {`);
  lines.push(`    return this.value(input);`);
  lines.push(`  }`);
  if (name === 'logger') lines.push(`\n  log(message: string): void {\n    console.log(message);\n  }`);
  lines.push('}');
  write(`src/app/core/${name}.service.ts`, lines.join('\n'));
  if (i !== SESSION_IDX && i !== PROFILE_IDX && chance(SPEC_RATE)) {
    write(`src/app/core/${name}.service.spec.ts`, SPEC(`./${name}.service`, cls));
  }
}
write('src/app/core/index.ts', CORE_SERVICES.map((s) => `export * from './${s}.service';`).join('\n'));

// ---------------------------------------------------------------------------------------------
// shared/models
// ---------------------------------------------------------------------------------------------

const modelClass = (name: string): string => pascal(name);
const FIELD_TYPES = ['string', 'number', 'boolean', 'string[]', 'Date', 'number | null'];
const FIELD_NAMES = ['id', 'name', 'label', 'value', 'count', 'enabled', 'createdAt', 'updatedAt', 'tags', 'order', 'description', 'code', 'weight', 'score', 'owner', 'parentId'];

for (let i = 0; i < SHARED_MODELS.length; i++) {
  const name = SHARED_MODELS[i]!;
  const cls = modelClass(name);
  const imports: string[] = [];
  const fields = ['  id: string;'];
  for (const f of sample(FIELD_NAMES.slice(1), 2 + int(3))) fields.push(`  ${f}: ${pick(FIELD_TYPES)};`);
  if (i > 0 && chance(0.5)) {
    const ref = SHARED_MODELS[int(i)]!;
    imports.push(`import { ${modelClass(ref)} } from './${ref}.model';`);
    fields.push(`  ${camel(ref)}?: ${modelClass(ref)};`);
  }
  if (chance(0.3)) {
    imports.push(`import { Status } from './index';`);
    fields.push(`  status: Status;`);
  }
  write(
    `src/app/shared/models/${name}.model.ts`,
    `${imports.length > 0 ? `${imports.join('\n')}\n\n` : ''}export interface ${cls} {\n${fields.join('\n')}\n}\n\nexport type ${cls}Id = ${cls}['id'];`,
  );
}

// planted latent cycle (defaults.ts must always be evaluated before status.enum.ts)
write(P.statusEnum, `import { DEFAULT_STATUS } from './defaults';

export enum Status {
  Active = 1,
  Inactive = 2,
  Archived = 3,
}

export function isDefaultStatus(s: Status): boolean {
  return s === DEFAULT_STATUS;
}
`);
write(P.defaults, `import { Status } from './status.enum';

// Works only while defaults.ts is always imported before status.enum.ts.
export const DEFAULT_STATUS = Status.Active;
export const DEFAULT_PAGE_SIZE = 25;
`);

// planted type-only cycle
write(P.invoiceModel, `import { Customer } from './customer.model';

export interface Invoice {
  id: string;
  total: number;
  customer: Customer;
}
`);
write(P.customerModel, `import { Invoice } from './invoice.model';

export interface Customer {
  id: string;
  name: string;
  invoices: Invoice[];
}
`);

write(
  'src/app/shared/models/index.ts',
  [
    `export * from './defaults';`,
    `export * from './status.enum';`,
    `export * from './invoice.model';`,
    `export * from './customer.model';`,
    ...SHARED_MODELS.map((m) => `export * from './${m}.model';`),
  ].join('\n'),
);

// ---------------------------------------------------------------------------------------------
// shared/utils
// ---------------------------------------------------------------------------------------------

const utilFn = (name: string): string => `${camel(name)}Value`;

for (const name of SHARED_UTILS) {
  const imports: string[] = [];
  const body: string[] = [];
  const model = pick(SHARED_MODELS);
  imports.push(`import { ${modelClass(model)} } from '../models/${model}.model';`);
  const useStatus = chance(0.4);
  if (useStatus) imports.push(`import { DEFAULT_STATUS, Status } from '../models/index';`);
  body.push(`export function ${utilFn(name)}(input: string): string {`);
  body.push(`  return '${name}:' + input;`);
  body.push(`}`);
  body.push('');
  body.push(`export function ${camel(name)}Of(item: ${modelClass(model)}): string {`);
  body.push(`  return ${utilFn(name)}(item.id);`);
  body.push(`}`);
  if (useStatus) {
    body.push('');
    body.push(`export function ${camel(name)}Status(s?: Status): Status {`);
    body.push(`  return s ?? DEFAULT_STATUS;`);
    body.push(`}`);
  }
  write(`src/app/shared/utils/${name}.util.ts`, `${imports.join('\n')}\n\n${body.join('\n')}`);
}

// planted barrel-induced group: shared util -> feature barrel -> widget components -> @shared
write(P.registryUtil, `import { WidgetsListComponent } from '@features/widgets';
import { Kpi } from '../models/kpi.model';

export function registeredWidgets(): unknown[] {
  return [WidgetsListComponent];
}

export function widgetKpi(id: string): Kpi | null {
  return id ? null : null;
}
`);
write(P.utilsIndex, [...SHARED_UTILS.map((u) => `export * from './${u}.util';`), `export * from './registry.util';`].join('\n'));

// ---------------------------------------------------------------------------------------------
// shared/pipes
// ---------------------------------------------------------------------------------------------

const pipeClass = (name: string): string => `${pascal(name)}Pipe`;

for (const name of SHARED_PIPES) {
  const util = pick(SHARED_UTILS);
  const model = pick(SHARED_MODELS);
  write(`src/app/shared/pipes/${name}.pipe.ts`, `import { Pipe, PipeTransform } from '@angular/core';
import { ${utilFn(util)} } from '../utils/${util}.util';
import { ${modelClass(model)} } from '../models/${model}.model';

@Pipe({ name: 'app${pascal(name)}', standalone: true })
export class ${pipeClass(name)} implements PipeTransform {
  transform(value: ${modelClass(model)} | string | null): string {
    return value === null ? '' : ${utilFn(util)}(typeof value === 'string' ? value : value.id);
  }
}
`);
  if (chance(SPEC_RATE)) write(`src/app/shared/pipes/${name}.pipe.spec.ts`, SPEC(`./${name}.pipe`, pipeClass(name)));
}
write('src/app/shared/pipes/index.ts', SHARED_PIPES.map((p) => `export * from './${p}.pipe';`).join('\n'));

// ---------------------------------------------------------------------------------------------
// shared/directives
// ---------------------------------------------------------------------------------------------

const directiveClass = (name: string): string => `${pascal(name)}Directive`;

for (const name of SHARED_DIRECTIVES) {
  const core = pick(CORE_SERVICES);
  const model = pick(SHARED_MODELS);
  write(`src/app/shared/directives/${name}.directive.ts`, `import { Directive, ElementRef, inject, input } from '@angular/core';
import { ${serviceClass(core)} } from '@core/${core}.service';
import { ${modelClass(model)} } from '../models/${model}.model';

@Directive({ selector: '[app${pascal(name)}]', standalone: true })
export class ${directiveClass(name)} {
  private readonly ${camel(core)} = inject(${serviceClass(core)});
  private readonly el = inject(ElementRef);
  readonly app${pascal(name)} = input<${modelClass(model)} | null>(null);

  apply(): void {
    this.el.nativeElement.dataset['${camel(name)}'] = this.${camel(core)}.value('${name}');
  }
}
`);
  if (chance(SPEC_RATE)) write(`src/app/shared/directives/${name}.directive.spec.ts`, SPEC(`./${name}.directive`, directiveClass(name)));
}
write('src/app/shared/directives/index.ts', SHARED_DIRECTIVES.map((d) => `export * from './${d}.directive';`).join('\n'));

// ---------------------------------------------------------------------------------------------
// shared/ui
// ---------------------------------------------------------------------------------------------

const uiClass = (name: string): string => `${pascal(name)}Component`;

for (let i = 0; i < SHARED_UI.length; i++) {
  const name = SHARED_UI[i]!;
  const imports = [`import { Component, input } from '@angular/core';`];
  const decoImports: string[] = [];
  let template = `<div class="${name}"><ng-content /></div>`;
  const pipes = sample(SHARED_PIPES, int(3));
  for (const p of pipes) {
    imports.push(`import { ${pipeClass(p)} } from '../pipes/${p}.pipe';`);
    decoImports.push(pipeClass(p));
  }
  const dirs = sample(SHARED_DIRECTIVES, int(2));
  for (const d of dirs) {
    imports.push(`import { ${directiveClass(d)} } from '../directives/${d}.directive';`);
    decoImports.push(directiveClass(d));
  }
  if (i > 0 && chance(0.6)) {
    const child = SHARED_UI[int(i)]!;
    imports.push(`import { ${uiClass(child)} } from './${child}.component';`);
    decoImports.push(uiClass(child));
    template = `<div class="${name}"><app-${child} /><ng-content /></div>`;
  }
  const model = pick(SHARED_MODELS);
  imports.push(`import { ${modelClass(model)} } from '../models/${model}.model';`);
  const util = pick(SHARED_UTILS);
  imports.push(`import { ${utilFn(util)} } from '../utils/${util}.util';`);
  write(`src/app/shared/ui/${name}.component.ts`, `${imports.join('\n')}

@Component({
  selector: 'app-${name}',
  standalone: true,
  imports: [${decoImports.join(', ')}],
  template: '${template}',
})
export class ${uiClass(name)} {
  readonly model = input<${modelClass(model)} | null>(null);
  readonly disabled = input<boolean>(false);

  label(): string {
    return ${utilFn(util)}(this.model()?.id ?? '${name}');
  }
}
`);
  if (chance(SPEC_RATE)) write(`src/app/shared/ui/${name}.component.spec.ts`, SPEC(`./${name}.component`, uiClass(name)));
}
write('src/app/shared/ui/index.ts', SHARED_UI.map((u) => `export * from './${u}.component';`).join('\n'));

// ---------------------------------------------------------------------------------------------
// shared/base + shared/list (planted critical extends cycle through a barrel)
// ---------------------------------------------------------------------------------------------

write(P.baseList, `import { Directive, input } from '@angular/core';
import { ListItemComponent } from '../list/index';
import { Page } from '../models/page.model';

@Directive()
export abstract class BaseListComponent {
  readonly page = input<Page | null>(null);
  protected readonly pageSize = 25;

  /** Deferred: only touched when a subclass renders. */
  protected itemType(): typeof ListItemComponent {
    return ListItemComponent;
  }

  protected trackById(_: number, item: { id: string }): string {
    return item.id;
  }
}
`);
write('src/app/shared/base/base-form.component.ts', `import { Directive, input } from '@angular/core';
import { ConfigService } from '@core/config.service';
import { Option } from '../models/option.model';

@Directive()
export abstract class BaseFormComponent {
  readonly options = input<Option[]>([]);

  constructor(protected readonly config: ConfigService) {}

  protected validate(): boolean {
    return this.options().length > 0 && this.config.value('form') !== '';
  }
}
`);
write('src/app/shared/base/base-detail.component.ts', `import { Directive, inject, input } from '@angular/core';
import { LoggerService } from '@core/logger.service';
import { Breadcrumb } from '../models/breadcrumb.model';

@Directive()
export abstract class BaseDetailComponent {
  protected readonly logger = inject(LoggerService);
  readonly breadcrumbs = input<Breadcrumb[]>([]);

  protected log(id: string): void {
    this.logger.log('detail ' + id);
  }
}
`);
write('src/app/shared/base/index.ts', `export * from './base-list.component';\nexport * from './base-form.component';\nexport * from './base-detail.component';`);

write(P.listItem, `import { Component, input } from '@angular/core';
import { BaseListComponent } from '../base/base-list.component';
import { BadgeComponent } from '../ui/badge.component';

@Component({
  selector: 'app-list-item',
  standalone: true,
  imports: [BadgeComponent],
  template: '<li><ng-content /><app-badge /></li>',
})
export class ListItemComponent extends BaseListComponent {
  readonly label = input<string>('');
}
`);
write('src/app/shared/list/list-empty.component.ts', `import { Component, input } from '@angular/core';
import { EmptyStateComponent } from '../ui/empty-state.component';

@Component({
  selector: 'app-list-empty',
  standalone: true,
  imports: [EmptyStateComponent],
  template: '<app-empty-state>{{ message() }}</app-empty-state>',
})
export class ListEmptyComponent {
  readonly message = input<string>('Nothing here');
}
`);
write('src/app/shared/list/list.component.ts', `import { Component, input } from '@angular/core';
import { ListItemComponent } from './list-item.component';
import { ListEmptyComponent } from './list-empty.component';
import { Page } from '../models/page.model';

@Component({
  selector: 'app-list',
  standalone: true,
  imports: [ListItemComponent, ListEmptyComponent],
  template: '@if (items().length) { @for (i of items(); track i.id) { <app-list-item [label]="i.id" /> } } @else { <app-list-empty /> }',
})
export class ListComponent {
  readonly items = input<{ id: string }[]>([]);
  readonly page = input<Page | null>(null);
}
`);
write(P.listIndex, `export * from './list-item.component';\nexport * from './list.component';\nexport * from './list-empty.component';`);

// ---------------------------------------------------------------------------------------------
// shared/tree (planted critical decorator cycle)
// ---------------------------------------------------------------------------------------------

write(P.tree, `import { Component, input } from '@angular/core';
import { TreeNodeComponent } from './tree-node.component';

export interface TreeNode {
  label: string;
  children: TreeNode[];
}

@Component({
  selector: 'app-tree',
  standalone: true,
  imports: [TreeNodeComponent],
  template: '@for (n of nodes(); track n.label) { <app-tree-node [node]="n" /> }',
})
export class TreeComponent {
  readonly nodes = input<TreeNode[]>([]);
}
`);
write(P.treeNode, `import { Component, input } from '@angular/core';
import { TreeComponent, type TreeNode } from './tree.component';

@Component({
  selector: 'app-tree-node',
  standalone: true,
  imports: [TreeComponent],
  template: '{{ node().label }} <app-tree [nodes]="node().children" />',
})
export class TreeNodeComponent {
  readonly node = input.required<TreeNode>();
}
`);
write('src/app/shared/tree/index.ts', `export * from './tree.component';\nexport * from './tree-node.component';`);

// ---------------------------------------------------------------------------------------------
// shared barrel (base before list so base-list is always reached first)
// ---------------------------------------------------------------------------------------------

write(
  P.sharedIndex,
  [
    `export * from './base/index';`,
    `export * from './list/index';`,
    `export * from './models/index';`,
    `export * from './tree/index';`,
    `export * from './ui/index';`,
    `export * from './pipes/index';`,
    `export * from './directives/index';`,
    `export * from './utils/index';`,
  ].join('\n'),
);

// ---------------------------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------------------------

interface FeatureInfo {
  name: string;
  components: string[]; // file base names without extension
  componentClasses: string[];
  routesConst: string;
}
const featureInfos: FeatureInfo[] = [];

const nounAt = (nouns: readonly string[], i: number): string =>
  i < nouns.length ? nouns[i]! : `${nouns[i % nouns.length]}-${Math.floor(i / nouns.length) + 1}`;

for (let fi = 0; fi < FEATURES.length; fi++) {
  const feature = FEATURES[fi]!;
  const F = pascal(feature);
  const dir = `src/app/features/${feature}`;
  const isWidgets = feature === 'widgets';
  const isOrders = feature === 'orders';
  const nComponents = isWidgets ? Math.max(COMPONENTS_PER_FEATURE, WIDGETS_IN_GROUP + 1) : COMPONENTS_PER_FEATURE;

  // models -----------------------------------------------------------------------------------
  const models: string[] = [];
  const modelClassOf = (noun: string): string => `${F}${pascal(noun)}`;
  for (let mi = 0; mi < MODELS_PER_FEATURE; mi++) {
    const noun = nounAt(MODEL_NOUNS, mi);
    const cls = modelClassOf(noun);
    const imports: string[] = [];
    const fields = ['  id: string;'];
    for (const f of sample(FIELD_NAMES.slice(1), 2 + int(3))) fields.push(`  ${f}: ${pick(FIELD_TYPES)};`);
    if (chance(0.6)) {
      const shared = pick(SHARED_MODELS);
      imports.push(`import { ${modelClass(shared)} } from '@shared/models/${shared}.model';`);
      fields.push(`  ${camel(shared)}: ${modelClass(shared)};`);
    }
    if (chance(0.4)) {
      imports.push(`import { Status } from '@shared/models/index';`);
      fields.push(`  status: Status;`);
    }
    if (mi > 0 && chance(0.4)) {
      const prev = models[int(mi)]!;
      imports.push(`import { ${modelClassOf(prev)} } from './${prev}.model';`);
      fields.push(`  ${camel(prev)}?: ${modelClassOf(prev)};`);
    }
    models.push(noun);
    write(`${dir}/models/${noun}.model.ts`, `${imports.length > 0 ? `${imports.join('\n')}\n\n` : ''}export interface ${cls} {\n${fields.join('\n')}\n}`);
  }

  // services ---------------------------------------------------------------------------------
  const services: string[] = [];
  const serviceClassOf = (noun: string): string => `${F}${pascal(noun)}Service`;
  for (let si = 0; si < SERVICES_PER_FEATURE; si++) {
    const noun = nounAt(SERVICE_NOUNS, si);
    const file = `${feature}-${noun}.service`;
    const cls = serviceClassOf(noun);
    const model = pick(models);
    const imports: string[] = [];
    const fields: string[] = [];
    const ctor: string[] = [];
    const uses: string[] = [];
    const coreDeps = sample(CORE_SERVICES, 1 + int(2));
    const sibling = si > 0 && chance(0.5) ? services[int(si)]! : null;
    const useInject = chance(0.5);
    imports.push(`import { Injectable${useInject ? ', inject' : ''} } from '@angular/core';`);
    const hasRx = chance(0.5);
    if (hasRx) imports.push(`import { Observable, of } from 'rxjs';`);
    for (const c of coreDeps) imports.push(`import { ${serviceClass(c)} } from '@core/${c}.service';`);
    if (sibling) imports.push(`import { ${serviceClassOf(sibling)} } from './${feature}-${sibling}.service';`);
    imports.push(`import { ${modelClassOf(model)} } from './models/${model}.model';`);
    const useStatus = chance(0.3);
    if (useStatus) imports.push(`import { Status, DEFAULT_STATUS } from '@shared/models/index';`);
    for (const c of coreDeps) {
      if (useInject) fields.push(`private readonly ${camel(c)} = inject(${serviceClass(c)});`);
      else ctor.push(`private readonly ${camel(c)}: ${serviceClass(c)}`);
      uses.push(`this.${camel(c)}.value('${feature}')`);
    }
    if (sibling) {
      if (useInject) fields.push(`private readonly ${camel(sibling)} = inject(${serviceClassOf(sibling)});`);
      else ctor.push(`private readonly ${camel(sibling)}: ${serviceClassOf(sibling)}`);
      uses.push(`this.${camel(sibling)}.run('${noun}')`);
    }
    services.push(noun);
    const ctorText = ctor.length > 0 ? `\n  constructor(${ctor.map((p) => `\n    ${p},`).join('')}\n  ) {}\n` : '';
    write(`${dir}/${file}.ts`, `${imports.join('\n')}

@Injectable({ providedIn: 'root' })
export class ${cls} {
${fields.map((f) => `  ${f}`).join('\n')}
${ctorText}
  list(): ${hasRx ? `Observable<${modelClassOf(model)}[]>` : `${modelClassOf(model)}[]`} {
    return ${hasRx ? 'of([])' : '[]'};
  }

  run(input: string): string {
    return [${['input', ...uses].join(', ')}].join('/');
  }
${useStatus ? `
  status(s?: Status): Status {
    return s ?? DEFAULT_STATUS;
  }
` : ''}}
`);
    if (chance(SPEC_RATE)) write(`${dir}/${file}.spec.ts`, SPEC(`./${file}`, cls));
  }

  if (isOrders) {
    // planted deferred cycle: two services calling each other only inside methods
    services.push('sync', 'cache');
    write(P.ordersSync, `import { Injectable } from '@angular/core';
import { OrdersCacheService } from './orders-cache.service';

@Injectable({ providedIn: 'root' })
export class OrdersSyncService {
  static readonly prefix = 'orders';

  run(input: string): string {
    return OrdersCacheService.key(input);
  }

  sync(ids: string[]): string[] {
    return ids.map((id) => OrdersCacheService.key(id));
  }
}
`);
    write(P.ordersCache, `import { Injectable } from '@angular/core';
import { OrdersSyncService } from './orders-sync.service';

@Injectable({ providedIn: 'root' })
export class OrdersCacheService {
  private readonly entries = new Map<string, string>();

  static key(input: string): string {
    return OrdersSyncService.prefix + ':' + input;
  }

  run(input: string): string {
    const k = OrdersCacheService.key(input);
    this.entries.set(k, input);
    return k;
  }
}
`);
  }

  // components -------------------------------------------------------------------------------
  const components: string[] = [];
  const componentClasses: string[] = [];
  const compClassOf = (noun: string): string => `${F}${pascal(noun)}Component`;
  for (let ci = 0; ci < nComponents; ci++) {
    const noun = nounAt(COMPONENT_NOUNS, ci);
    const file = `${feature}-${noun}.component`;
    const cls = compClassOf(noun);
    const inGroup = isWidgets && ci < WIDGETS_IN_GROUP;
    if (inGroup) groupWidgets.push(`${dir}/${file}.ts`);

    const angularImports = new Set(['Component', 'input']);
    const projectImports: string[] = [];
    const decoImports: string[] = ['CommonModule'];
    const fields: string[] = [];
    const ctor: string[] = [];
    const methods: string[] = [];
    let extendsClause = '';
    let needSuper = false;

    // Base class (the very first eager route component must reach base-list first).
    const wantsBase =
      (isWidgets && ci === 0) || (noun === 'list' && chance(0.5)) || (noun === 'form' && chance(0.5)) || (noun === 'detail' && chance(0.5));
    if (wantsBase) {
      if (noun === 'list') {
        projectImports.push(`import { BaseListComponent } from '@shared/base/base-list.component';`);
        extendsClause = ' extends BaseListComponent';
        needSuper = true;
      } else if (noun === 'form') {
        projectImports.push(`import { BaseFormComponent } from '@shared/base/base-form.component';`);
        projectImports.push(`import { ConfigService } from '@core/config.service';`);
        extendsClause = ' extends BaseFormComponent';
        ctor.push('config: ConfigService');
        needSuper = true;
        methods.push(`  submit(): boolean {\n    return this.validate();\n  }`);
      } else {
        projectImports.push(`import { BaseDetailComponent } from '@shared/base/base-detail.component';`);
        extendsClause = ' extends BaseDetailComponent';
        needSuper = true;
      }
    }

    // Shared UI / pipes / directives (eager decorator usage, direct file imports)
    for (const ui of sample(SHARED_UI, 1 + int(3))) {
      projectImports.push(`import { ${uiClass(ui)} } from '@shared/ui/${ui}.component';`);
      decoImports.push(uiClass(ui));
    }
    for (const p of sample(SHARED_PIPES, int(2))) {
      projectImports.push(`import { ${pipeClass(p)} } from '@shared/pipes/${p}.pipe';`);
      decoImports.push(pipeClass(p));
    }
    if (chance(0.3)) {
      const d = pick(SHARED_DIRECTIVES);
      projectImports.push(`import { ${directiveClass(d)} } from '@shared/directives/${d}.directive';`);
      decoImports.push(directiveClass(d));
    }
    if (chance(0.15)) {
      projectImports.push(`import { ListComponent } from '@shared/list/list.component';`);
      decoImports.push('ListComponent');
    }
    if (chance(0.1)) {
      projectImports.push(`import { TreeComponent } from '@shared/tree/tree.component';`);
      decoImports.push('TreeComponent');
    }
    // Sibling component with a lower index (DAG inside the feature)
    if (ci > 0 && chance(0.4)) {
      const sibIdx = int(ci);
      projectImports.push(`import { ${componentClasses[sibIdx]} } from './${components[sibIdx]}';`);
      decoImports.push(componentClasses[sibIdx]!);
    }
    if (chance(0.3)) {
      projectImports.push(`import { RouterLink } from '@angular/router';`);
      decoImports.push('RouterLink');
    }

    // Services: feature service via inject(), core service via constructor param or inject()
    const svc = pick(services);
    angularImports.add('inject');
    projectImports.push(`import { ${serviceClassOf(svc)} } from './${feature}-${svc}.service';`);
    fields.push(`private readonly ${camel(svc)} = inject(${serviceClassOf(svc)});`);
    const core = pick(CORE_SERVICES);
    projectImports.push(`import { ${serviceClass(core)} } from '@core/${core}.service';`);
    if (chance(0.5)) ctor.push(`private readonly ${camel(core)}: ${serviceClass(core)}`);
    else fields.push(`private readonly ${camel(core)} = inject(${serviceClass(core)});`);

    // Model types (type-only usage of a value-style import → erased)
    const model = pick(models);
    projectImports.push(`import { ${modelClassOf(model)} } from './models/${model}.model';`);
    fields.push(`readonly items = input<${modelClassOf(model)}[]>([]);`);
    if (chance(TYPE_IMPORT_RATE)) {
      const sm = pick(SHARED_MODELS);
      projectImports.push(`import { ${modelClass(sm)} } from '@shared/models/${sm}.model';`);
      fields.push(`readonly ${camel(sm)} = input<${modelClass(sm)} | null>(null);`);
    }
    if (chance(0.3)) {
      projectImports.push(`import { Status } from '@shared/models/index';`);
      fields.push(`status = Status.Active;`);
    }

    // `@shared` barrel usage: widgets (in the planted group) use it only in deferred positions;
    // other features may also use it – they are not reachable from the barrel, so no cycle.
    if (inGroup || chance(0.2)) {
      const util = pick(SHARED_UTILS);
      const sm = pick(SHARED_MODELS);
      projectImports.push(`import { ${utilFn(util)}, DEFAULT_STATUS, type ${modelClass(sm)} } from '@shared';`);
      fields.push(`readonly defaultStatus = DEFAULT_STATUS;`);
      fields.push(`selected: ${modelClass(sm)} | null = null;`);
      methods.push(`  describe(): string {\n    return ${utilFn(util)}('${noun}');\n  }`);
    }

    if (chance(0.4)) projectImports.push(`import { Observable, of } from 'rxjs';`);
    const hasRx = projectImports.some((l) => l.includes('rxjs'));
    if (hasRx) methods.push(`  load(): Observable<${modelClassOf(model)}[]> {\n    return of(this.items());\n  }`);
    methods.push(`  title(): string {\n    return this.${camel(svc)}.run('${noun}') + this.${camel(core)}.value('${feature}');\n  }`);

    const superArgs = extendsClause.includes('BaseForm') ? 'config' : '';
    const ctorText =
      ctor.length > 0 || needSuper
        ? `\n  constructor(${ctor.map((p) => `\n    ${p},`).join('')}${ctor.length > 0 ? '\n  ' : ''}) {${needSuper ? `\n    super(${superArgs});\n  ` : ''}}\n`
        : '';

    components.push(file);
    componentClasses.push(cls);
    write(`${dir}/${file}.ts`, `import { ${[...angularImports].sort().join(', ')} } from '@angular/core';
import { CommonModule } from '@angular/common';
${projectImports.join('\n')}

@Component({
  selector: 'app-${feature}-${noun}',
  standalone: true,
  imports: [${decoImports.join(', ')}],
  template: '<section class="${feature}-${noun}">{{ title() }}</section>',
})
export class ${cls}${extendsClause} {
${fields.map((f) => `  ${f}`).join('\n')}
${ctorText}
${methods.join('\n\n')}
}
`);
    if (chance(SPEC_RATE)) write(`${dir}/${file}.spec.ts`, SPEC(`./${file}`, cls));
  }

  // routes -------------------------------------------------------------------------------------
  const routesConst = `${constCase(feature)}_ROUTES`;
  const routed = components.slice(0, Math.min(3, components.length));
  write(`${dir}/${feature}.routes.ts`, `import { Routes } from '@angular/router';
${routed.map((c, i) => `import { ${componentClasses[i]} } from './${c}';`).join('\n')}

export const ${routesConst}: Routes = [
${routed.map((_, i) => `  { path: '${i === 0 ? '' : i === 1 ? ':id' : COMPONENT_NOUNS[i]}', component: ${componentClasses[i]} },`).join('\n')}
];
`);

  // barrel (components, services, models – not routes) ------------------------------------------
  write(
    `${dir}/index.ts`,
    [
      ...components.map((c) => `export * from './${c}';`),
      ...services.map((s) => `export * from './${feature}-${s}.service';`),
      ...models.map((m) => `export * from './models/${m}.model';`),
    ].join('\n'),
  );

  featureInfos.push({ name: feature, components, componentClasses, routesConst });
}

// ---------------------------------------------------------------------------------------------
// app.routes.ts – widgets-list first so base-list is reached before list-item
// ---------------------------------------------------------------------------------------------

{
  const lines: string[] = [`import { Routes } from '@angular/router';`];
  const routes: string[] = [];
  featureInfos.forEach((f, i) => {
    if (i < EAGER_FEATURES) {
      lines.push(`import { ${f.componentClasses[0]} } from '@features/${f.name}/${f.components[0]}';`);
      routes.push(`  { path: '${i === 0 ? '' : f.name}', component: ${f.componentClasses[0]} },`);
    } else if (i < EAGER_FEATURES + LAZY_FEATURES) {
      routes.push(`  { path: '${f.name}', loadChildren: () => import('./features/${f.name}/${f.name}.routes').then((m) => m.${f.routesConst}) },`);
    } else {
      lines.push(`import { ${f.routesConst} } from '@features/${f.name}/${f.name}.routes';`);
      routes.push(`  { path: '${f.name}', children: ${f.routesConst} },`);
    }
  });
  write('src/app/app.routes.ts', `${lines.join('\n')}\n\nexport const routes: Routes = [\n${routes.join('\n')}\n];\n`);
}

// ---------------------------------------------------------------------------------------------
// tsconfig + planted.json + write out
// ---------------------------------------------------------------------------------------------

const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'bundler',
    strict: true,
    isolatedModules: true,
    experimentalDecorators: true,
    baseUrl: '.',
    paths: {
      '@core/*': ['src/app/core/*'],
      '@shared': ['src/app/shared/index.ts'],
      '@shared/*': ['src/app/shared/*'],
      '@features/*': ['src/app/features/*'],
    },
  },
  include: ['src/**/*.ts'],
};

const planted = {
  seed: SEED,
  filesArg: targetFiles,
  fileCount: files.size,
  generator: 'scripts/generate-large-fixture.ts',
  cycles: {
    'critical-extends': {
      kind: 'runtime-break',
      severity: 'critical',
      from: P.listItem,
      to: P.baseList,
      symbol: 'BaseListComponent',
      files: [P.listItem, P.baseList, P.listIndex],
    },
    'critical-decorator': {
      kind: 'runtime-break',
      severity: 'critical',
      from: P.treeNode,
      to: P.tree,
      symbol: 'TreeComponent',
      files: [P.tree, P.treeNode],
    },
    'di-cycle': {
      kind: 'di-cycle',
      severity: 'high',
      files: [P.session, P.profile],
      services: ['SessionService', 'ProfileService'],
    },
    latent: {
      kind: 'latent-cycle',
      severity: 'medium',
      from: P.defaults,
      to: P.statusEnum,
      symbol: 'Status',
      files: [P.defaults, P.statusEnum],
    },
    deferred: {
      kind: 'deferred-cycle',
      severity: 'low',
      files: [P.ordersSync, P.ordersCache],
    },
    'type-only': {
      kind: 'type-only-cycle',
      severity: 'info',
      files: [P.invoiceModel, P.customerModel],
    },
    'barrel-group': {
      kind: 'deferred-cycle',
      severity: 'low',
      minNodes: 10,
      members: [P.sharedIndex, P.utilsIndex, P.registryUtil, P.widgetsIndex, ...groupWidgets],
    },
  },
};

fs.rmSync(srcRoot, { recursive: true, force: true });
fs.mkdirSync(srcRoot, { recursive: true });
const dirs = new Set<string>();
for (const [rel, content] of files) {
  const abs = `${fixtureRoot}/${rel}`;
  const dir = path.posix.dirname(abs);
  if (!dirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    dirs.add(dir);
  }
  fs.writeFileSync(abs, content, 'utf8');
}
fs.writeFileSync(`${fixtureRoot}/tsconfig.json`, `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8');
fs.writeFileSync(`${fixtureRoot}/planted.json`, `${JSON.stringify(planted, null, 2)}\n`, 'utf8');

const specs = [...files.keys()].filter((f) => f.endsWith('.spec.ts')).length;
console.log(
  `generated ${files.size} files (${specs} specs) under ${path.relative(projectRoot, srcRoot).replace(/\\/g, '/')} ` +
    `[features=${FEATURES.length}, components/feature=${COMPONENTS_PER_FEATURE}, services/feature=${SERVICES_PER_FEATURE}, models/feature=${MODELS_PER_FEATURE}]`,
);
