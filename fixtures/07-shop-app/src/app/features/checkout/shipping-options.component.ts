import { Component } from '@angular/core';
import { CheckboxComponent } from '../../shared/ui/checkbox.component';
import { PriceComponent } from '../../shared/ui/price.component';
import { PaymentFormComponent } from './payment-form.component';

@Component({
  selector: 'app-shipping-options',
  standalone: true,
  imports: [CheckboxComponent, PriceComponent],
  template: `<app-checkbox /><app-price />`,
})
export class ShippingOptionsComponent {
  // every wizard step knows its successor
  static readonly next = PaymentFormComponent;
}
