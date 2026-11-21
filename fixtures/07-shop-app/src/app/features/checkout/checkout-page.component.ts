import { Component } from '@angular/core';
import { AddressFormComponent } from './address-form.component';
import { TabsComponent } from '../../shared/ui/tabs.component';
import { SpinnerComponent } from '../../shared/ui/spinner.component';

@Component({
  selector: 'app-checkout-page',
  standalone: true,
  imports: [AddressFormComponent, TabsComponent, SpinnerComponent],
  template: `<app-address-form /><app-tabs /><app-spinner />`,
})
export class CheckoutPageComponent {}
