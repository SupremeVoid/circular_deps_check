import { AService } from './a.service';

export class BService {
  name = 'b';

  useA(): AService {
    return new AService();
  }
}
