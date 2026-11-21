import { Injectable } from '@angular/core';
import { CartService } from './cart.service';

@Injectable({ providedIn: 'root' })
export class CouponService {
  // needs the cart while the cart is being constructed with this service: NG0200
  constructor(private readonly cart: CartService) {}

  apply(total: number): number {
    return this.cart.items.length > 3 ? total * 0.9 : total;
  }
}
