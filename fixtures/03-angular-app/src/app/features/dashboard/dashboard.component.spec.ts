import { DashboardComponent } from './dashboard.component';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;

describe('DashboardComponent', () => {
  it('exists', () => {
    void DashboardComponent;
  });
});
