import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);

  currentUser(): Promise<{ name: string }> {
    return this.api.get('/api/me');
  }
}
