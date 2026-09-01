import { UserComponent } from '@features/user/user.component';

export function isUser(x: unknown): x is UserComponent {
  return x instanceof UserComponent;
}
