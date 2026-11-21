import { Component } from '@angular/core';
import { ProductGalleryComponent } from './product-gallery.component';
import { PriceComponent } from '../../shared/ui/price.component';
import { RatingComponent } from '../../shared/ui/rating.component';
import { ButtonComponent } from '../../shared/ui/button.component';
import { TabsComponent } from '../../shared/ui/tabs.component';

@Component({
  selector: 'app-product-detail',
  standalone: true,
  imports: [ProductGalleryComponent, PriceComponent, RatingComponent, ButtonComponent, TabsComponent],
  template: `<app-product-gallery /><app-price /><app-rating /><app-button /><app-tabs />`,
})
export class ProductDetailComponent {}
