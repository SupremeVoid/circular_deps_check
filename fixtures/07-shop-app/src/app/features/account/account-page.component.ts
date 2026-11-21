import { Component } from '@angular/core';
import { ProfileFormComponent } from './profile-form.component';
import { AddressBookComponent } from './address-book.component';
import { PreferencesComponent } from './preferences.component';
import { TabsComponent } from '../../shared/ui/tabs.component';

@Component({
  selector: 'app-account-page',
  standalone: true,
  imports: [ProfileFormComponent, AddressBookComponent, PreferencesComponent, TabsComponent],
  template: `<app-profile-form /><app-address-book /><app-preferences /><app-tabs />`,
})
export class AccountPageComponent {}
