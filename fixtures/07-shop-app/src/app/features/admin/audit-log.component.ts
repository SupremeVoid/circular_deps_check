import { Component } from '@angular/core';
import { TableComponent } from '../../shared/ui/table.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [TableComponent, EmptyStateComponent],
  template: `<app-table /><app-empty-state />`,
})
export class AuditLogComponent {}
