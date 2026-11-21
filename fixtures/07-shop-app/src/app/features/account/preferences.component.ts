import { Component } from '@angular/core';
import { CheckboxComponent } from '../../shared/ui/checkbox.component';
import { SelectComponent } from '../../shared/ui/select.component';
import { INITIAL_THEME } from './preferences-defaults';

@Component({
  selector: 'app-preferences',
  standalone: true,
  imports: [CheckboxComponent, SelectComponent],
  template: `<app-select /><app-checkbox />`,
})
export class PreferencesComponent {
  static readonly DARK = 'dark';
  theme = INITIAL_THEME;
}
