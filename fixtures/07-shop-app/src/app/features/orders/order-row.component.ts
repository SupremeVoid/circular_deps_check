import { Component } from '@angular/core';
import { ROW_PRESET } from '../../shared';
import { OrderStatusBadgeComponent } from './order-status-badge.component';

@Component({
  selector: 'app-order-row',
  standalone: true,
  imports: [OrderStatusBadgeComponent],
  template: `<app-order-status-badge />`,
})
export class OrderRowComponent {
  static readonly density = 'compact';

  preset(): string {
    return ROW_PRESET;
  }
}
