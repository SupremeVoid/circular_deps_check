import { Component } from '@angular/core';
import { ADMIN_ROUTES } from './admin.routes';

@Component({ selector: 'app-admin', standalone: true, template: 'admin' })
export class AdminComponent {
  // Static field evaluated at class definition time -> breaks inside the lazy chunk.
  static readonly routeCount = ADMIN_ROUTES.length;
}
