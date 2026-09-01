import { AuthService } from './auth.service';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;

describe('AuthService', () => {
  it('exists', () => {
    void AuthService;
  });
});
