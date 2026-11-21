import { Component } from '@angular/core';
import { CategoryNodeComponent } from './category-node.component';

@Component({
  selector: 'app-category-tree',
  standalone: true,
  imports: [CategoryNodeComponent],
  template: `<app-category-node />`,
})
export class CategoryTreeComponent {}
