import { Injectable } from '@angular/core';
import { AService } from './a.service';

@Injectable()
export class BService {
  constructor(private readonly a: AService) {}
}
