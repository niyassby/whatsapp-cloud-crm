import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalize to the form WhatsApp calls a wa_id: E.164 digits without the plus. Returns null when
 * it is not a valid number, including spreadsheet damage such as 9.198E+11.
 */
export function normalizePhone(raw: string, defaultCountry?: string): string | null {
  const text = raw.trim();
  if (!/^[+\d(]/.test(text) || /[a-z]/i.test(text)) return null;
  const international = text.replace(/^00/, '+');
  const attempts: string[] = [];
  if (international.startsWith('+')) {
    attempts.push(international);
  } else {
    // National first when a country is given, then the digits may already include a country code.
    if (defaultCountry) attempts.push(international);
    attempts.push(`+${international.replace(/\D/g, '')}`);
  }
  for (const attempt of attempts) {
    const parsed = attempt.startsWith('+')
      ? parsePhoneNumberFromString(attempt)
      : parsePhoneNumberFromString(attempt, defaultCountry as CountryCode);
    if (parsed?.isValid()) return parsed.number.replace(/^\+/, '');
  }
  return null;
}

/** Storage key for an import upload, an export file or an error report. */
export const contactJobKey = (orgId: string, jobId: string, name: 'source' | 'result') =>
  `orgs/${orgId}/contact-jobs/${jobId}/${name}.csv`;
