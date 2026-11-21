import { Component } from '@angular/core';
import { CartItemComponent } from './cart-item.component';
import { CouponFormComponent } from './coupon-form.component';
import { CartSummaryComponent } from './cart-summary.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { CartService } from './cart.service';

@Component({
  selector: 'app-cart-page',
  standalone: true,
  imports: [CartItemComponent, CouponFormComponent, CartSummaryComponent, EmptyStateComponent],
  template: `<app-cart-item /><app-coupon-form /><app-cart-summary /><app-empty-state />`,
})
export class CartPageComponent {
  constructor(readonly cart: CartService) {}
}
