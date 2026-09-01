import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class UserService {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  load(name: string): void {
    void this.http.get(`/users/${name}`);
    void this.auth;
  }
}
