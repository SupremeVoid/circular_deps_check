import { Component } from '@angular/core';
import { AvatarComponent } from '../shared/ui/avatar.component';
import { ButtonComponent } from '../shared/ui/button.component';

@Component({
  selector: 'app-user-menu',
  standalone: true,
  imports: [AvatarComponent, ButtonComponent],
  template: `<app-avatar /><app-button />`,
})
export class UserMenuComponent {}
