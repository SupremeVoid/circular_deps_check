import { DEFAULT_STATUS } from './defaults';

export enum OrderStatus {
  Open = 'open',
  Paid = 'paid',
  Shipped = 'shipped',
}

export const isDefaultStatus = (s: OrderStatus): boolean => s === DEFAULT_STATUS;
