import { Component } from '@angular/core';
import { CardComponent } from '../../shared/ui/card.component';
import { ButtonComponent } from '../../shared/ui/button.component';

@Component({
  selector: 'app-address-card',
  standalone: true,
  imports: [CardComponent, ButtonComponent],
  template: `<app-card /><app-button />`,
})
export class AddressCardComponent {}
