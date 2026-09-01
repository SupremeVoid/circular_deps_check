import type { User } from './user.model';

export interface Order {
  id: string;
  owner: User;
}
