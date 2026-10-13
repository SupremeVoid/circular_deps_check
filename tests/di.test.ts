import { describe, expect, it } from 'bun:test';
import { analyzeProject } from './tmp-project.js';

const NG = `import { Injectable, Inject, Optional, SkipSelf, inject, Component, forwardRef, Injector } from '@angular/core';\n`;

describe('Angular DI cycles', () => {
  it('detects constructor <-> inject() cycles and reports both injection sites', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { BService } from './b.service';\n@Injectable({ providedIn: 'root' })\nexport class AService { constructor(private readonly b: BService) {} }\n`,
      'src/b.service.ts': `${NG}import { AService } from './a.service';\n@Injectable({ providedIn: 'root' })\nexport class BService { private readonly a = inject(AService); }\n`,
    });
    const di = r.findings.filter((f) => f.kind === 'di-cycle');
    expect(di).toHaveLength(1);
    expect(di[0]!.severity).toBe('high');
    expect(di[0]!.diCycle!.certain).toBe(true);
    expect(di[0]!.diCycle!.edges.map((e) => `${e.dep.token}@${e.dep.line}:${e.dep.via}`).sort()).toEqual(['AService@4:inject-field', 'BService@4:constructor-param']);
    // the import cycle itself is harmless (type + deferred) -> no runtime-break
    expect(r.findings.some((f) => f.kind === 'runtime-break')).toBe(false);
  });

  it('follows provider configuration (useExisting, useClass, factory deps) inside one component injector', async () => {
    const common = {
      'src/main.ts': `import './app.component';\n`,
      'src/tokens.ts': `import { InjectionToken } from '@angular/core';\nexport const CONFIG = new InjectionToken<string>('config');\n`,
      'src/config.service.ts': `${NG}@Injectable()\nexport class ConfigService { get() { return ''; } }\n`,
      'src/store.service.ts': `${NG}import { CONFIG } from './tokens';\nimport { ConfigService } from './config.service';\n@Injectable({ providedIn: 'root' })\nexport class StoreService { constructor(@Inject(CONFIG) private readonly cfg: string, private readonly config: ConfigService) {} get() { return this.cfg; } }\n`,
    };
    const providers = `{ provide: CONFIG, useFactory: (s: StoreService) => s.get(), deps: [StoreService] }, { provide: ConfigService, useExisting: StoreService }`;
    const component = (extra: string) =>
      `${NG}import { CONFIG } from './tokens';\nimport { ConfigService } from './config.service';\nimport { StoreService } from './store.service';\n@Component({ selector: 'app', standalone: true, template: '', providers: [${extra}${providers}] })\nexport class AppComponent {}\n`;

    // StoreService is root-provided: it can never see the component's CONFIG/ConfigService -> no cycle.
    const scoped = await analyzeProject({ ...common, 'src/app.component.ts': component('') });
    expect(scoped.diCycles).toHaveLength(0);

    // Providing StoreService in the same component closes both cycles inside that injector.
    const local = await analyzeProject({ ...common, 'src/app.component.ts': component('StoreService, ') });
    const names = local.diCycles.map((c) => c.nodes.map((n) => n.name).sort().join('+')).sort();
    expect(names).toEqual(['CONFIG+StoreService', 'ConfigService+StoreService']);
    expect(local.diCycles.every((c) => c.nodes.every((n) => n.scope === 'AppComponent'))).toBe(true);
  });

  it('lowers confidence for SkipSelf/Host edges', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { BService } from './b.service';\n@Injectable()\nexport class AService { constructor(@SkipSelf() private readonly b: BService) {} }\n`,
      'src/b.service.ts': `${NG}import { AService } from './a.service';\n@Injectable()\nexport class BService { constructor(private readonly a: AService) {} }\n`,
    });
    const di = r.findings.find((f) => f.kind === 'di-cycle')!;
    expect(di.severity).toBe('medium');
    expect(di.diCycle!.certain).toBe(false);
    expect(di.summary).toContain('@SkipSelf');
  });

  it('resolves tokens through barrels and namespace imports', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './features/feature.service';\n`,
      'src/core/index.ts': `export * from './auth.service';\nexport { UserService as Users } from './user.service';\n`,
      'src/core/auth.service.ts': `${NG}import { FeatureService } from '../features/feature.service';\n@Injectable({ providedIn: 'root' })\nexport class AuthService { private readonly f = inject(FeatureService); }\n`,
      'src/core/user.service.ts': `${NG}@Injectable({ providedIn: 'root' })\nexport class UserService {}\n`,
      'src/features/feature.service.ts': `${NG}import * as core from '../core';\nimport { Users } from '../core';\n@Injectable({ providedIn: 'root' })\nexport class FeatureService { constructor(private readonly auth: core.AuthService, private readonly users: Users) {} }\n`,
    });
    const di = r.findings.filter((f) => f.kind === 'di-cycle');
    expect(di).toHaveLength(1);
    expect(di[0]!.diCycle!.nodes.map((n) => n.name).sort()).toEqual(['AuthService', 'FeatureService']);
    expect(di[0]!.diCycle!.nodes.every((n) => n.path && !n.path.endsWith('index.ts'))).toBe(true);
  });

  it('ignores external tokens, lazy injector access and inject() inside methods', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { HttpClient } from '@angular/common/http';\nimport { BService } from './b.service';\n@Injectable({ providedIn: 'root' })\nexport class AService {\n  private readonly http = inject(HttpClient);\n  private readonly injector = inject(Injector);\n  b() { return this.injector.get(BService); }\n  later() { return inject(BService); }\n}\n`,
      'src/b.service.ts': `${NG}import { AService } from './a.service';\n@Injectable({ providedIn: 'root' })\nexport class BService { constructor(private readonly a: AService) {} }\n`,
    });
    expect(r.findings.filter((f) => f.kind === 'di-cycle')).toHaveLength(0);
    expect(r.diCycles).toHaveLength(0);
  });

  it('reports self-injection (Angular throws NG0200 for it too)', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}@Injectable({ providedIn: 'root' })\nexport class AService { private readonly self = inject(AService); }\n`,
    });
    expect(r.diCycles).toHaveLength(1);
    expect(r.diCycles[0]!.nodes.map((n) => n.name)).toEqual(['AService']);
  });

  it('does not report the parent-or-new provider pattern ([new Optional(), new SkipSelf(), X])', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './panel.component';\n`,
      'src/registry.ts': `export class Registry { constructor(readonly parent: Registry | null) {} }\n`,
      'src/panel.component.ts': `${NG}import { Registry } from './registry';\n@Component({ selector: 'p', template: '', providers: [{ provide: Registry, useFactory: (p: Registry | null) => new Registry(p), deps: [[new Optional(), new SkipSelf(), Registry]] }] })\nexport class PanelComponent {}\n`,
    });
    expect(r.diCycles).toHaveLength(0);
  });

  it('includes inherited dependencies of base classes', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './list.component';\n`,
      'src/base.ts': `${NG}import { DataService } from './data.service';\nexport abstract class BaseList { protected readonly data = inject(DataService); }\n`,
      'src/list.component.ts': `${NG}import { BaseList } from './base';\n@Injectable({ providedIn: 'root' })\nexport class ListService extends BaseList {}\n`,
      'src/data.service.ts': `${NG}import { ListService } from './list.component';\n@Injectable({ providedIn: 'root' })\nexport class DataService { private readonly list = inject(ListService); }\n`,
    });
    expect(r.diCycles).toHaveLength(1);
    expect(r.diCycles[0]!.nodes.map((n) => n.name).sort()).toEqual(['DataService', 'ListService']);
  });

  it('follows @Injectable({ useClass }) and inject() in constructor parameter defaults', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './api';\n`,
      'src/api.ts': `${NG}import { HttpApi } from './http-api';\n@Injectable({ providedIn: 'root', useClass: HttpApi })\nexport abstract class Api {}\n`,
      'src/http-api.ts': `${NG}import { Session } from './session';\n@Injectable({ providedIn: 'root' })\nexport class HttpApi { constructor(private readonly s = inject(Session)) {} }\n`,
      'src/session.ts': `${NG}import { Api } from './api';\n@Injectable({ providedIn: 'root' })\nexport class Session { private readonly api = inject(Api); }\n`,
    });
    expect(r.diCycles).toHaveLength(1);
    expect(r.diCycles[0]!.nodes.map((n) => n.name).sort()).toEqual(['Api', 'HttpApi', 'Session']);
  });

  it('understands forwardRef in @Inject and provider arrays', async () => {
    const r = await analyzeProject({
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { BService } from './b.service';\n@Injectable({ providedIn: 'root' })\nexport class AService { constructor(@Inject(forwardRef(() => BService)) private readonly b: BService) {} }\n`,
      'src/b.service.ts': `${NG}import { AService } from './a.service';\n@Injectable({ providedIn: 'root' })\nexport class BService { constructor(@Inject(forwardRef(() => AService)) private readonly a: AService) {} }\n`,
    });
    const di = r.findings.filter((f) => f.kind === 'di-cycle');
    expect(di).toHaveLength(1);
    expect(di[0]!.suggestions[0]!.text).toContain('forwardRef');
  });

  it('can be disabled with angular: false', async () => {
    const files = {
      'src/main.ts': `import './a.service';\n`,
      'src/a.service.ts': `${NG}import { BService } from './b.service';\n@Injectable()\nexport class AService { constructor(private readonly b: BService) {} }\n`,
      'src/b.service.ts': `${NG}import { AService } from './a.service';\n@Injectable()\nexport class BService { private readonly a = inject(AService); }\n`,
    };
    expect((await analyzeProject(files)).diCycles).toHaveLength(1);
    expect((await analyzeProject(files, { angular: false })).diCycles).toHaveLength(0);
  });
});
