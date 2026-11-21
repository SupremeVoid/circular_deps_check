import { Component } from '@angular/core';
import { FormFieldComponent } from '../../shared/ui/form-field.component';
import { ButtonComponent } from '../../shared/ui/button.component';
import { ShippingOptionsComponent } from './shipping-options.component';

@Component({
  selector: 'app-address-form',
  standalone: true,
  imports: [FormFieldComponent, ButtonComponent],
  template: `<app-form-field /><app-button />`,
})
export class AddressFormComponent {
  // every wizard step knows its successor
  static readonly next = ShippingOptionsComponent;
}
