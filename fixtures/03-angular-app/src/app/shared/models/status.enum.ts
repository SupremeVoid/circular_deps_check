import { DEFAULT_STATUS } from './defaults';

export enum Status {
  Active = 1,
  Inactive = 2,
}

export function isDefault(s: Status): boolean {
  return s === DEFAULT_STATUS;
}
