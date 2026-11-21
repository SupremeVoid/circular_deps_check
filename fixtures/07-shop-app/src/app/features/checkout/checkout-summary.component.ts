import { Component } from '@angular/core';
import { PriceComponent } from '../../shared/ui/price.component';
import { CHECKOUT_STEPS } from './checkout-steps';

@Component({
  selector: 'app-checkout-summary',
  standalone: true,
  imports: [PriceComponent],
  template: `<app-price />`,
})
export class CheckoutSummaryComponent {
  static readonly stepCount = CHECKOUT_STEPS.length;
}
