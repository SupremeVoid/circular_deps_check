import { Component } from '@angular/core';
import { CardComponent } from '../../shared/ui/card.component';
import { CHART_COLORS } from './chart-theme';

@Component({
  selector: 'app-stats-card',
  standalone: true,
  imports: [CardComponent],
  template: `<app-card />`,
})
export class StatsCardComponent {
  static readonly colors = CHART_COLORS;
}
