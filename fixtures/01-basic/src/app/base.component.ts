import { UserComponent } from './user.component';

export class BaseComponent {
  title = 'base';

  createChild(): UserComponent {
    return new UserComponent();
  }
}
