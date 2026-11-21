import { Component } from '@angular/core';
import { ButtonComponent } from './button.component';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [ButtonComponent, IconComponent],
  template: `<app-button /><app-icon />`,
})
export class ModalComponent {}
