import { PREFIX } from './constants';

export function formatTitle(s: string): string {
  return `${PREFIX}${s}]`;
}
