/**
 * Returns the current date and time.
 */
export function getDateTime(): Date {
  return new Date();
}

/**
 * Returns the current date and time as an ISO 8601 string.
 */
export function getDateTimeString(): string {
  return new Date().toISOString();
}
