import { Component } from '@angular/core';
import { SearchBoxComponent } from './search-box.component';
import { ProductFiltersComponent } from './product-filters.component';
import { CategoryTreeComponent } from './category-tree.component';
import { ProductListComponent } from './product-list.component';

@Component({
  selector: 'app-catalog-page',
  standalone: true,
  imports: [SearchBoxComponent, ProductFiltersComponent, CategoryTreeComponent, ProductListComponent],
  template: `<app-search-box /><app-product-filters /><app-category-tree /><app-product-list />`,
})
export class CatalogPageComponent {}
