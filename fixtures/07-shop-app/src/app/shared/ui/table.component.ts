import { Component } from '@angular/core';
import { TableRowComponent } from './table-row.component';
import { SpinnerComponent } from './spinner.component';

@Component({
  selector: 'app-table',
  standalone: true,
  imports: [TableRowComponent, SpinnerComponent],
  template: `<app-table-row /><app-spinner />`,
})
export class TableComponent {}
