import { Component } from '@angular/core';
import { IconComponent } from '../../shared/ui/icon.component';

@Component({
  selector: 'app-product-gallery',
  standalone: true,
  imports: [IconComponent],
  template: `<app-icon />`,
})
export class ProductGalleryComponent {}
