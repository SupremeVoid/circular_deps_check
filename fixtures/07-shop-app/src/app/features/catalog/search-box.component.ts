import { Component } from '@angular/core';
import { InputComponent } from '../../shared/ui/input.component';
import { IconComponent } from '../../shared/ui/icon.component';

@Component({
  selector: 'app-search-box',
  standalone: true,
  imports: [InputComponent, IconComponent],
  template: `<app-input /><app-icon />`,
})
export class SearchBoxComponent {}
