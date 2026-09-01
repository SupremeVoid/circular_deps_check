import { UserComponent } from '@features/user/user.component';

// Eager use of UserComponent at module load while user.component.ts is still initialising.
export const AppState = { active: UserComponent };
