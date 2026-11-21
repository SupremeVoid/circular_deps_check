import { Component } from '@angular/core';
import { CardComponent } from '../../shared/ui/card.component';
import { PriceComponent } from '../../shared/ui/price.component';
import { RatingComponent } from '../../shared/ui/rating.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-product-card',
  standalone: true,
  imports: [CardComponent, PriceComponent, RatingComponent, ButtonComponent],
  template: `<app-card /><app-price /><app-rating /><app-button />`,
})
export class ProductCardComponent {}
