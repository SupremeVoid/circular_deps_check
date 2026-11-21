import { Component } from '@angular/core';
import { IconComponent } from '../shared/ui/icon.component';
import { BadgeComponent } from '../shared/ui/badge.component';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [IconComponent, BadgeComponent],
  template: `<app-icon /><app-badge />`,
})
export class SidebarComponent {}
