import { CheckoutService } from './checkout.service';

export const CHECKOUT_STEPS = ['address', 'shipping', 'payment', 'review'];
export const FIRST_STEP = CheckoutService.firstStep;
