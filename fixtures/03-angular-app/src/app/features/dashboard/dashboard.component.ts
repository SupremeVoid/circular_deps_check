import { Component } from '@angular/core';
import { AuthService } from '@core';
import { TreeComponent } from '@shared/tree/tree.component';
import { DEFAULT_STATUS } from '@shared/models/defaults';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [TreeComponent],
  template: '<app-tree />',
})
export class DashboardComponent {
  readonly status = DEFAULT_STATUS;

  constructor(private readonly auth: AuthService) {}
}
