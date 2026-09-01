import { BService } from './b.service';

export class AService {
  useB(): string {
    return new BService().name;
  }
}
