import { Component } from '@angular/core';
import { OrderListComponent } from './order-list.component';
import { OrderDetailComponent } from './order-detail.component';
import { PaginationComponent } from '../../shared/ui/pagination.component';
import { OrdersService } from './orders.service';

@Component({
  selector: 'app-orders-page',
  standalone: true,
  imports: [OrderListComponent, OrderDetailComponent, PaginationComponent],
  template: `<app-order-list /><app-order-detail /><app-pagination />`,
})
export class OrdersPageComponent {
  constructor(readonly orders: OrdersService) {}
}
