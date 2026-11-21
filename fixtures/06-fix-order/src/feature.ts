// Needs one helper – but takes it from the barrel, which loads everything in `shared`.
import { helper } from './shared';

export class Feature {
  run(): number {
    return helper();
  }
}
