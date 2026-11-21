import { Component } from '@angular/core';
import { TableCellComponent } from './table-cell.component';

@Component({
  selector: 'app-table-row',
  standalone: true,
  imports: [TableCellComponent],
  template: `<app-table-cell />`,
})
export class TableRowComponent {}
