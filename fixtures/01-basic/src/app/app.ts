import { UserComponent } from './user.component';
import { DEFAULT_ROUTE } from './config';
import { formatTitle } from '../utils/format';

export const routes = [{ path: 'user', component: UserComponent }];

export function bootstrap(): void {
  console.log(formatTitle('app'), DEFAULT_ROUTE, routes.length);
}
