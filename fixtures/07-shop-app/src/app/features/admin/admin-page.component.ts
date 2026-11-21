import { Component } from '@angular/core';
import { AdminDashboardComponent } from './admin-dashboard.component';
import { UserTableComponent } from './user-table.component';
import { TabsComponent } from '../../shared/ui/tabs.component';

@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [AdminDashboardComponent, UserTableComponent, TabsComponent],
  template: `<app-admin-dashboard /><app-user-table /><app-tabs />`,
})
export class AdminPageComponent {}
