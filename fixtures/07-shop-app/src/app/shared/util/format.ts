import { currencySymbol } from './currency';

export function formatPrice(value: number, currency = 'EUR'): string {
  return `${value.toFixed(2)} ${currencySymbol(currency)}`;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
