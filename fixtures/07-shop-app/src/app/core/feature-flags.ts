import { APP_SETTINGS } from './app-settings';

const FLAGS = APP_SETTINGS.flags;

export function featureEnabled(name: string): boolean {
  return FLAGS.includes(name);
}
