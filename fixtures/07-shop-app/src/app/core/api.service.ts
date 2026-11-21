import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly logger = inject(LoggerService);

  get<T>(url: string): Promise<T> {
    this.logger.log(`GET ${url}`);
    return fetch(url).then((r) => r.json() as Promise<T>);
  }
}
