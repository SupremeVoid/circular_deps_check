import { Component } from '@angular/core';
import { CardComponent } from '../../shared/ui/card.component';
import { PriceComponent } from '../../shared/ui/price.component';
import { CheckoutSummaryComponent } from './checkout-summary.component';

@Component({
  selector: 'app-order-review',
  standalone: true,
  imports: [CardComponent, PriceComponent],
  template: `<app-card /><app-price />`,
})
export class OrderReviewComponent {
  // every wizard step knows its successor
  static readonly next = CheckoutSummaryComponent;
}
