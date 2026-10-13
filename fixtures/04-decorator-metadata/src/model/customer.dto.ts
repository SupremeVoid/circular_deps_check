import { Expose } from 'class-transformer';
import { OrderDto } from './order.dto';

export class CustomerDto {
  @Expose() name = '';
  // design:type OrderDto -> eager read of OrderDto while order.dto.ts is still loading
  @Expose() latestOrder?: OrderDto;
  // arrays emit design:type Array: no reference to OrderDto
  @Expose() orders: OrderDto[] = [];
}
