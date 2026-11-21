import { AdminDashboardComponent } from './admin-dashboard.component';
import { AuditLogComponent } from './audit-log.component';

// a registry of widget hosts – read while admin-dashboard.component.ts is still loading
export const ADMIN_WIDGETS = [
  { id: 'dashboard', host: AdminDashboardComponent },
  { id: 'audit', host: AuditLogComponent },
];
