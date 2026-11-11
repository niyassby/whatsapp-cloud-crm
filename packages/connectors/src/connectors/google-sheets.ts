/**
 * Google Sheets: add a row, or find one, from a flow. OAuth with the platform's Google app
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), offline access so the refresh token lasts. Values are
 * written RAW, so a customer's message starting with "=" is stored as text, never run as a formula.
 */
import { ConnectorError, type ConnectorContext, type ConnectorDefinition } from '../types';

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Rows read when looking one up. */
const LOOKUP_ROWS = 5000;

/** A spreadsheet id, from the id itself or a link to the sheet. */
export function spreadsheetId(value: string): string | null {
  const v = value.trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(v);
  if (fromUrl) return fromUrl[1] ?? null;
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null;
}

/** 'Leads' -> "'Leads'", quoting a tab name for an A1 range. */
const tab = (name: string) => `'${(name.trim() || 'Sheet1').replace(/'/g, "''")}'`;

/** Values are separated by "|", one per column; "\|" keeps a bar inside a value. */
export function splitValues(input: string): string[] {
  return input.split(/(?<!\\)\|/).map((v) => v.replace(/\\\|/g, '|').trim());
}

async function call(ctx: ConnectorContext, method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await ctx.http({
    method,
    url,
    headers: { authorization: `Bearer ${ctx.credentials.accessToken ?? ''}` },
    body,
  });
  if (res.status === 401) {
    throw new ConnectorError('Google needs you to sign in again', { reconnect: true });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ConnectorError(`Google answered ${res.status}`, { retryable: true });
  }
  if (!res.ok) {
    const msg = (res.json as { error?: { message?: string } } | null)?.error?.message;
    if (res.status === 404) throw new ConnectorError('That spreadsheet or tab was not found');
    if (res.status === 403) {
      throw new ConnectorError('The signed-in Google account cannot open that spreadsheet');
    }
    throw new ConnectorError(msg ?? `Google answered ${res.status}`);
  }
  return res;
}

function sheetFrom(input: Record<string, string>) {
  const id = spreadsheetId(input.spreadsheet ?? '');
  if (!id) throw new ConnectorError('Paste the spreadsheet link or id');
  return { id, tab: tab(input.sheet ?? '') };
}

export const googleSheets: ConnectorDefinition = {
  key: 'google_sheets',
  name: 'Google Sheets',
  description: 'Add rows to a spreadsheet from a flow, or look a row up.',
  category: 'other',
  website: 'https://workspace.google.com/products/sheets/',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    scopeSeparator: ' ',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    // A refresh token, every time, so the connection keeps working.
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  actions: [
    {
      key: 'append_row',
      name: 'Add a row',
      description: 'Adds a row under the last one in a tab',
      input: [
        { key: 'spreadsheet', label: 'Spreadsheet link or id' },
        { key: 'sheet', label: 'Tab', required: false, placeholder: 'Sheet1' },
        {
          key: 'values',
          label: 'Values',
          placeholder: '{{contact.name}} | {{contact.phone}} | {{vars.answer}}',
          help: 'One value per column, separated by |',
        },
      ],
      output: ['updatedRange', 'rowNumber'],
      async run(ctx, input) {
        const sheet = sheetFrom(input);
        const values = splitValues(input.values ?? '');
        const range = encodeURIComponent(`${sheet.tab}!A1`);
        const res = await call(
          ctx,
          'POST',
          `${SHEETS_API}/${sheet.id}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
          { values: [values] },
        );
        const updated = (res.json as { updates?: { updatedRange?: string } } | null)?.updates
          ?.updatedRange;
        const row = updated ? /![A-Z]+(\d+)/.exec(updated)?.[1] : undefined;
        return { updatedRange: updated ?? null, rowNumber: row ? Number(row) : null };
      },
    },
    {
      key: 'lookup_row',
      name: 'Find a row',
      description: 'The first row whose column matches a value; columns are named by row 1',
      input: [
        { key: 'spreadsheet', label: 'Spreadsheet link or id' },
        { key: 'sheet', label: 'Tab', required: false, placeholder: 'Sheet1' },
        { key: 'column', label: 'Column heading', placeholder: 'Phone' },
        { key: 'value', label: 'Value', placeholder: '{{contact.phone}}' },
      ],
      output: ['found', 'rowNumber', 'row'],
      async run(ctx, input) {
        const sheet = sheetFrom(input);
        const range = encodeURIComponent(`${sheet.tab}!A1:ZZ${LOOKUP_ROWS}`);
        const res = await call(ctx, 'GET', `${SHEETS_API}/${sheet.id}/values/${range}`);
        const rows = ((res.json as { values?: unknown[][] } | null)?.values ?? []).map((r) =>
          r.map((c) => String(c ?? '')),
        );
        const headers = rows[0] ?? [];
        const wanted = (input.column ?? '').trim().toLowerCase();
        const col = headers.findIndex((h) => h.trim().toLowerCase() === wanted);
        if (col < 0) throw new ConnectorError(`No column called "${input.column ?? ''}" in row 1`);
        const value = (input.value ?? '').trim().toLowerCase();
        const at = rows.findIndex((r, i) => i > 0 && (r[col] ?? '').trim().toLowerCase() === value);
        if (at < 0) return { found: false, rowNumber: null, row: {} };
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          if (h.trim()) row[h.trim()] = rows[at]?.[i] ?? '';
        });
        return { found: true, rowNumber: at + 1, row };
      },
    },
  ],
};
