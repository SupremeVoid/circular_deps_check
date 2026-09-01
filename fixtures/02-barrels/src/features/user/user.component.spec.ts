import { UserComponent } from './user.component';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;

describe('UserComponent', () => {
  it('exists', () => {
    void UserComponent;
  });
});
