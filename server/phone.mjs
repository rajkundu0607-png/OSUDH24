import { HttpError } from './errors.mjs';

export function normalizeMobile(value) {
  if (typeof value !== 'string') throw new HttpError(422, 'Enter a valid Indian mobile number.');
  const match = /^(?:\+?91)?([6-9]\d{9})$/.exec(value.trim().replace(/[\s()-]/g, ''));
  if (!match) throw new HttpError(422, 'Enter a valid Indian mobile number.');
  return `91${match[1]}`;
}
