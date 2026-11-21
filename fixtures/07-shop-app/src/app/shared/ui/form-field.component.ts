import { Component } from '@angular/core';
import { InputComponent } from './input.component';

@Component({
  selector: 'app-form-field',
  standalone: true,
  imports: [InputComponent],
  template: `<app-input />`,
})
export class FormFieldComponent {}
