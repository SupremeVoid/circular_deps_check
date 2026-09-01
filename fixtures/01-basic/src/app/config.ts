import { routes } from './app';

// Eager read of `routes` while app.ts is still initialising -> TDZ ReferenceError.
export const DEFAULT_ROUTE = routes[0];
