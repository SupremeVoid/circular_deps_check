import { Component } from '@angular/core';
import { FormFieldComponent } from '../../shared/ui/form-field.component';
import { AvatarComponent } from '../../shared/ui/avatar.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-profile-form',
  standalone: true,
  imports: [FormFieldComponent, AvatarComponent, ButtonComponent],
  template: `<app-form-field /><app-avatar /><app-button />`,
})
export class ProfileFormComponent {}
