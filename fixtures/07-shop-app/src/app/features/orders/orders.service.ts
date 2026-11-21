import { Injectable, inject } from '@angular/core';
import { ApiService } from '../../core/api.service';
import type { Order } from '../../shared/models/order';
import { DEFAULT_STATUS, PAGE_SIZE } from '../../shared/models/defaults';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly api = inject(ApiService);

  list(status = DEFAULT_STATUS): Promise<Order[]> {
    return this.api.get(`/api/orders?status=${status}&limit=${PAGE_SIZE}`);
  }
}
