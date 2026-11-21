import { Component } from '@angular/core';
import { IconComponent } from '../shared/ui/icon.component';

@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [IconComponent],
  template: `<app-icon />`,
})
export class FooterComponent {}
