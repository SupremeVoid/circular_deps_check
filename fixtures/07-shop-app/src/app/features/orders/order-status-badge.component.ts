import { Component } from '@angular/core';
import { BadgeComponent } from '../../shared/ui/badge.component';

@Component({
  selector: 'app-order-status-badge',
  standalone: true,
  imports: [BadgeComponent],
  template: `<app-badge />`,
})
export class OrderStatusBadgeComponent {}
