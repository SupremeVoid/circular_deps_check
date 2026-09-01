import { Injectable } from '@angular/core';
import { UserService } from './user.service';
import { LoggerService } from './logger.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(
    private readonly users: UserService,
    private readonly logger: LoggerService,
  ) {}

  login(name: string): void {
    this.logger.log(`login ${name}`);
    this.users.load(name);
  }
}
