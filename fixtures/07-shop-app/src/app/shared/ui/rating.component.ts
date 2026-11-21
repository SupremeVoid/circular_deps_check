import { Component } from '@angular/core';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-rating',
  standalone: true,
  imports: [IconComponent],
  template: `<app-icon />`,
})
export class RatingComponent {}
