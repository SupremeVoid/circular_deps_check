import { Component } from '@angular/core';

@Component({
  selector: 'app-card',
  standalone: true,
  template: `<ng-content />`,
})
export class CardComponent {}
