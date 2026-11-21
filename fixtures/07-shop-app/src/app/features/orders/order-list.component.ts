import { Component } from '@angular/core';
// Needs one helper – but takes it from the barrel, which loads everything in `shared`.
import { formatDate } from '../../shared';
import { OrderRowComponent } from './order-row.component';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [OrderRowComponent],
  template: `<app-order-row />`,
})
export class OrderListComponent {
  label(d: Date): string {
    return formatDate(d);
  }
}
