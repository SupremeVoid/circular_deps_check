import { Injectable, inject } from '@angular/core';
import { CouponService } from './coupon.service';

@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly coupons = inject(CouponService);
  readonly items: { price: number }[] = [];

  total(): number {
    return this.coupons.apply(this.items.reduce((sum, i) => sum + i.price, 0));
  }
}
