import { Expose } from 'class-transformer';
import { CustomerDto } from './customer.dto';

// A non-Angular property decorator: with emitDecoratorMetadata TypeScript emits
// __metadata('design:type', CustomerDto) when this class is defined -> eager read.
export class OrderDto {
  @Expose() customer!: CustomerDto;
  @Expose() total = 0;
}
