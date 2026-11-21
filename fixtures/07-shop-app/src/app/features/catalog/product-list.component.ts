import { Component } from '@angular/core';
import { ProductCardComponent } from './product-card.component';
import { PaginationComponent } from '../../shared/ui/pagination.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';

@Component({
  selector: 'app-product-list',
  standalone: true,
  imports: [ProductCardComponent, PaginationComponent, EmptyStateComponent],
  template: `<app-product-card /><app-pagination /><app-empty-state />`,
})
export class ProductListComponent {}
