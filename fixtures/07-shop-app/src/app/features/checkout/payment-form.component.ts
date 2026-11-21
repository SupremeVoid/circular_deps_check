import { Component } from '@angular/core';
import { FormFieldComponent } from '../../shared/ui/form-field.component';
import { SelectComponent } from '../../shared/ui/select.component';
import { OrderReviewComponent } from './order-review.component';

@Component({
  selector: 'app-payment-form',
  standalone: true,
  imports: [FormFieldComponent, SelectComponent],
  template: `<app-form-field /><app-select />`,
})
export class PaymentFormComponent {
  // every wizard step knows its successor
  static readonly next = OrderReviewComponent;
}
