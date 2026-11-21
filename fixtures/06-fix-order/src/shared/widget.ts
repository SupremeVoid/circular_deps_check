import { Feature } from '../feature';
import { THEME } from './theme';

export class Widget {
  // read while feature.ts is still loading: crashes on app start
  static owner = Feature.name;
  static theme = THEME;
}
