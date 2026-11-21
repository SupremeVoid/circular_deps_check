import { Component } from '@angular/core';
import { NAV_ITEMS } from '../core/navigation';

@Component({
  selector: 'app-nav-menu',
  standalone: true,
  template: `<nav></nav>`,
})
export class NavMenuComponent {
  static readonly items = NAV_ITEMS;
}
