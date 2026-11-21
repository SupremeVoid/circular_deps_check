import { Component } from '@angular/core';
import { AvatarComponent } from '../../shared/ui/avatar.component';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-user-row',
  standalone: true,
  imports: [AvatarComponent, BadgeComponent, ButtonComponent],
  template: `<app-avatar /><app-badge /><app-button />`,
})
export class UserRowComponent {}
