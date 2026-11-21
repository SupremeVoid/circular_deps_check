import { formatPrice } from './format';

export function currencySymbol(code: string): string {
  return code === 'EUR' ? '€' : code;
}

export function priceRange(min: number, max: number): string {
  return `${formatPrice(min)} – ${formatPrice(max)}`;
}
