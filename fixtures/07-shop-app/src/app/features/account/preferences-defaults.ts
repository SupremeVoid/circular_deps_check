import { PreferencesComponent } from './preferences.component';

const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

// only read when the user prefers a dark theme – while preferences.component.ts is still loading
export const INITIAL_THEME = prefersDark ? PreferencesComponent.DARK : 'light';
