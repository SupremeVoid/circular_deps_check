import { Component } from '@angular/core';
import { AddressCardComponent } from './address-card.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';

@Component({
  selector: 'app-address-book',
  standalone: true,
  imports: [AddressCardComponent, EmptyStateComponent],
  template: `<app-address-card /><app-empty-state />`,
})
export class AddressBookComponent {}
