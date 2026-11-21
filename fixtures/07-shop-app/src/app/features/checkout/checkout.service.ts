import { Injectable } from '@angular/core';
import { CheckoutPageComponent } from './checkout-page.component';

@Injectable({ providedIn: 'root' })
export class CheckoutService {
  static readonly firstStep = 'address';

  // only used when called – not while the files load
  entryComponent(): unknown {
    return CheckoutPageComponent;
  }
}
