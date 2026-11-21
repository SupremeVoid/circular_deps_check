import { Component } from '@angular/core';
import { ButtonComponent } from './button.component';

@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [ButtonComponent],
  template: `<app-button />`,
})
export class TabsComponent {}
