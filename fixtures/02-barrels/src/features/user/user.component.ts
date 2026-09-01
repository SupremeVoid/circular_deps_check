import { Component } from '@angular/core';
import { BaseComponent, ButtonComponent } from '@shared';

@Component({
  selector: 'app-user',
  standalone: true,
  imports: [ButtonComponent],
  template: '<app-button>{{ title }}</app-button>',
})
export class UserComponent extends BaseComponent {}
