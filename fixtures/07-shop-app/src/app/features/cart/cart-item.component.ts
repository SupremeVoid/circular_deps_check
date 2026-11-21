import { Component } from '@angular/core';
import { PriceComponent } from '../../shared/ui/price.component';
import { ButtonComponent } from '../../shared/ui/button.component';
import { IconComponent } from '../../shared/ui/icon.component';

@Component({
  selector: 'app-cart-item',
  standalone: true,
  imports: [PriceComponent, ButtonComponent, IconComponent],
  template: `<app-price /><app-button /><app-icon />`,
})
export class CartItemComponent {}
