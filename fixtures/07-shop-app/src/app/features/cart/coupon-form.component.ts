import { Component } from '@angular/core';
import { FormFieldComponent } from '../../shared/ui/form-field.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-coupon-form',
  standalone: true,
  imports: [FormFieldComponent, ButtonComponent],
  template: `<app-form-field /><app-button />`,
})
export class CouponFormComponent {}
