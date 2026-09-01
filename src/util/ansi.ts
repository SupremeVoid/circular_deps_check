const ESC = '\x1b';

const enabled = (): boolean => {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return Boolean(process.stdout.isTTY);
};

let useColor = enabled();

export const setColor = (on: boolean): void => {
  useColor = on;
};

const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    useColor ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgYellow: wrap(43, 49),
};

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
