import { Component } from '@angular/core';

@Component({ selector: 'app-button', standalone: true, template: '<button><ng-content /></button>' })
export class ButtonComponent {}
