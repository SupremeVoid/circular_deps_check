import type { Order } from './order';

export interface Product {
  id: string;
  title: string;
  price: number;
  lastOrder?: Order;
}
