import { CatalogPageComponent } from './catalog-page.component';
import { ProductDetailComponent } from './product-detail.component';

export const CATALOG_ROUTES = [
  { path: '', component: CatalogPageComponent },
  { path: ':id', component: ProductDetailComponent },
];
