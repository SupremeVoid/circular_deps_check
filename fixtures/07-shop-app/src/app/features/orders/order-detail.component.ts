import { Component } from '@angular/core';
import { OrderTimelineComponent } from './order-timeline.component';
import { OrderStatusBadgeComponent } from './order-status-badge.component';
import { PriceComponent } from '../../shared/ui/price.component';
import { CardComponent } from '../../shared/ui/card.component';

@Component({
  selector: 'app-order-detail',
  standalone: true,
  imports: [OrderTimelineComponent, OrderStatusBadgeComponent, PriceComponent, CardComponent],
  template: `<app-order-timeline /><app-order-status-badge /><app-price /><app-card />`,
})
export class OrderDetailComponent {}
