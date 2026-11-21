import type { Product } from './product';
import { OrderStatus } from './order-status.enum';

export interface Order {
  id: string;
  items: Product[];
  status: OrderStatus;
}
