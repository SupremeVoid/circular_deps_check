import { Component } from '@angular/core';
import { PriceComponent } from '../../shared/ui/price.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-cart-summary',
  standalone: true,
  imports: [PriceComponent, ButtonComponent],
  template: `<app-price /><app-button />`,
})
export class CartSummaryComponent {}
