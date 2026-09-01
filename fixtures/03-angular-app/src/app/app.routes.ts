import { Routes } from '@angular/router';
import { DashboardComponent } from '@features/dashboard/dashboard.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'admin', loadChildren: () => import('@features/admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
];
