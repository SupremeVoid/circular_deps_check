import { Component } from '@angular/core';
import { CategoryTreeComponent } from './category-tree.component';

// A node renders its children with the tree again: both components list each other in `imports`.
@Component({
  selector: 'app-category-node',
  standalone: true,
  imports: [CategoryTreeComponent],
  template: `<app-category-tree />`,
})
export class CategoryNodeComponent {}
