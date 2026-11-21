import { Component } from '@angular/core';
import { NavMenuComponent } from './nav-menu.component';
import { UserMenuComponent } from './user-menu.component';

// A layout constant kept next to the component – other files import it from here.
export const HEADER_HEIGHT = 64;

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [NavMenuComponent, UserMenuComponent],
  template: `<app-nav-menu /><app-user-menu />`,
})
export class HeaderComponent {}
