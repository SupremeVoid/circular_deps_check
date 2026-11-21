import { Component } from '@angular/core';
import { StatsCardComponent } from './stats-card.component';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [StatsCardComponent],
  template: `<app-stats-card />`,
})
export class AdminDashboardComponent {}
