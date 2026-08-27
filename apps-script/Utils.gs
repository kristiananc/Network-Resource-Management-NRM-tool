/**
 * UUID and deterministic UTC date helpers for NRM's Apps Script runtime.
 */

function generateUuid() {
  return Utilities.getUuid();
}

function normalizeDate(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new Error('Invalid date value.');
    }
    return value.toISOString().slice(0, 10);
  }

  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error('Invalid date format; expected YYYY-MM-DD.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('Invalid calendar date.');
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTime(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (isNaN(parsed.getTime())) {
    throw new Error('Invalid datetime value.');
  }
  return parsed.toISOString();
}

function currentDateTimeUtc() {
  return new Date().toISOString();
}
