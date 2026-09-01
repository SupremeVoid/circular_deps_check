import { Component, input } from '@angular/core';
import { TreeComponent, type TreeNode } from './tree.component';

@Component({
  selector: 'app-tree-node',
  standalone: true,
  imports: [TreeComponent],
  template: '{{ node().label }} <app-tree [nodes]="node().children" />',
})
export class TreeNodeComponent {
  readonly node = input.required<TreeNode>();
}
