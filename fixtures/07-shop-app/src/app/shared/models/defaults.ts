import { OrderStatus } from './order-status.enum';

// read at load time: needs order-status.enum.ts to be finished
export const DEFAULT_STATUS = OrderStatus.Open;
export const PAGE_SIZE = 20;
