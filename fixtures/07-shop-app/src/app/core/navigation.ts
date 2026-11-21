import { featureEnabled } from './feature-flags';

export interface NavItem {
  label: string;
  path: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Catalog', path: '/catalog' },
  { label: 'Orders', path: '/orders' },
  ...(featureEnabled('admin') ? [{ label: 'Admin', path: '/admin' }] : []),
];
