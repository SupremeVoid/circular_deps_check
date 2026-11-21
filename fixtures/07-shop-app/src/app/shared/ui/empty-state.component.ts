import { Component } from '@angular/core';
import { IconComponent } from './icon.component';
import { ButtonComponent } from './button.component';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [IconComponent, ButtonComponent],
  template: `<app-icon /><app-button />`,
})
export class EmptyStateComponent {}
