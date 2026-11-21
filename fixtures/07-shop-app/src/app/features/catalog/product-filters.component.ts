import { Component } from '@angular/core';
import { CheckboxComponent } from '../../shared/ui/checkbox.component';
import { SelectComponent } from '../../shared/ui/select.component';

@Component({
  selector: 'app-product-filters',
  standalone: true,
  imports: [CheckboxComponent, SelectComponent],
  template: `<app-checkbox /><app-select />`,
})
export class ProductFiltersComponent {}
