import { Component } from '@angular/core';
import { TableComponent } from '../../shared/ui/table.component';
import { UserRowComponent } from './user-row.component';
import { PaginationComponent } from '../../shared/ui/pagination.component';

@Component({
  selector: 'app-user-table',
  standalone: true,
  imports: [TableComponent, UserRowComponent, PaginationComponent],
  template: `<app-table /><app-user-row /><app-pagination />`,
})
export class UserTableComponent {}
