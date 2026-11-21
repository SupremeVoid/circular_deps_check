export const routes = [
  { path: 'catalog', loadChildren: () => import('./features/catalog/catalog.routes').then((m) => m.CATALOG_ROUTES) },
  { path: 'cart', loadChildren: () => import('./features/cart/cart.routes').then((m) => m.CART_ROUTES) },
  { path: 'checkout', loadChildren: () => import('./features/checkout/checkout.routes').then((m) => m.CHECKOUT_ROUTES) },
  { path: 'orders', loadChildren: () => import('./features/orders/orders.routes').then((m) => m.ORDERS_ROUTES) },
  { path: 'account', loadChildren: () => import('./features/account/account.routes').then((m) => m.ACCOUNT_ROUTES) },
  { path: 'admin', loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
];
