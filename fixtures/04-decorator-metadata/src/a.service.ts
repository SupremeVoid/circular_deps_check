import { Injectable } from '@angular/core';
import { BService } from './b.service';
import { Config } from './config';

@Injectable()
export class AService {
  constructor(
    private readonly b: BService,
    private readonly cfg: Config,
  ) {}
}
