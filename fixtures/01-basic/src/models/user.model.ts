import { Order } from './order.model';

export interface User {
  id: string;
  orders: Order[];
}
