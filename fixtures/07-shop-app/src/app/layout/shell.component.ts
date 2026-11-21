import { Component } from '@angular/core';
import { HeaderComponent } from './header.component';
import { SidebarComponent } from './sidebar.component';
import { BreadcrumbComponent } from './breadcrumb.component';
import { FooterComponent } from './footer.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [HeaderComponent, SidebarComponent, BreadcrumbComponent, FooterComponent],
  template: `<app-header /><app-sidebar /><app-breadcrumb /><app-footer />`,
})
export class ShellComponent {}
