import { Component, input } from '@angular/core';
import { TreeNodeComponent } from './tree-node.component';

export interface TreeNode {
  label: string;
  children: TreeNode[];
}

@Component({
  selector: 'app-tree',
  standalone: true,
  imports: [TreeNodeComponent],
  template: '@for (n of nodes(); track n.label) { <app-tree-node [node]="n" /> }',
})
export class TreeComponent {
  readonly nodes = input<TreeNode[]>([]);
}
