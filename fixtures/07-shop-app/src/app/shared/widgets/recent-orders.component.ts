import { Component } from '@angular/core';
import { OrderListComponent } from '../../features/orders/order-list.component';

// A shared widget that embeds a feature component – and is re-exported by the shared barrel.
@Component({
  selector: 'app-recent-orders',
  standalone: true,
  imports: [OrderListComponent],
  template: `<app-order-list />`,
})
export class RecentOrdersComponent {}
