/**
 * HubSpot: keep contacts in step and log conversations as notes, from flows. OAuth with the
 * platform's HubSpot app (HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET). Contacts are matched by email,
 * then phone, so running the same step twice updates rather than duplicates.
 */
import { ConnectorError, type ConnectorContext, type ConnectorDefinition } from '../types';

export const HUBSPOT_API = 'https://api.hubapi.com';
/** HubSpot's built-in association type: note to contact. */
const NOTE_TO_CONTACT = 202;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

async function call(
  ctx: ConnectorContext,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) {
  const res = await ctx.http({
    method,
    url: `${HUBSPOT_API}${path}`,
    headers: { authorization: `Bearer ${ctx.credentials.accessToken ?? ''}` },
    body,
  });
  if (res.status === 401) {
    throw new ConnectorError('HubSpot needs you to sign in again', { reconnect: true });
  }
  if (res.status === 403) {
    throw new ConnectorError('The HubSpot app is missing a permission; reconnect it', {
      reconnect: true,
    });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ConnectorError(`HubSpot answered ${res.status}`, { retryable: true });
  }
  return res;
}

const failure = (json: unknown, status: number) =>
  new ConnectorError(String(obj(json).message ?? `HubSpot answered ${status}`));

/** HubSpot stores phones as typed; send ours with a plus so they read as international. */
const asPhone = (v: string | undefined) => {
  const digits = (v ?? '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
};

/** The contact with this email, else this phone (either written as we write it). */
async function findContact(
  ctx: ConnectorContext,
  email: string,
  phone: string,
): Promise<string | null> {
  const tries: { propertyName: string; operator: 'EQ'; value: string }[][] = [];
  if (email) tries.push([{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }]);
  if (phone) {
    tries.push([{ propertyName: 'phone', operator: 'EQ', value: phone }]);
    tries.push([{ propertyName: 'mobilephone', operator: 'EQ', value: phone }]);
  }
  for (const filters of tries) {
    const res = await call(ctx, 'POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters }],
      properties: ['email'],
      limit: 1,
    });
    if (!res.ok) throw failure(res.json, res.status);
    const first = obj(((obj(res.json).results as unknown[]) ?? [])[0]);
    if (first.id) return String(first.id);
  }
  return null;
}

export const hubspot: ConnectorDefinition = {
  key: 'hubspot',
  name: 'HubSpot',
  description: 'Create and update HubSpot contacts and log notes from WhatsApp conversations.',
  category: 'crm',
  website: 'https://www.hubspot.com',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    scopeSeparator: ' ',
    clientIdEnv: 'HUBSPOT_CLIENT_ID',
    clientSecretEnv: 'HUBSPOT_CLIENT_SECRET',
  },
  actions: [
    {
      key: 'upsert_contact',
      name: 'Create or update a contact',
      description: 'Finds the contact by email, then phone; updates it or creates it',
      input: [
        { key: 'phone', label: 'Phone', required: false, placeholder: '{{contact.phone}}' },
        { key: 'email', label: 'Email', required: false },
        { key: 'firstName', label: 'First name', required: false, placeholder: '{{contact.name}}' },
        { key: 'lastName', label: 'Last name', required: false },
        {
          key: 'properties',
          label: 'Other properties',
          required: false,
          placeholder: 'company=Chai House | lifecyclestage=lead',
          help: 'HubSpot property names, as name=value separated by |',
        },
      ],
      output: ['contactId', 'created'],
      async run(ctx, input) {
        const email = (input.email ?? '').trim();
        const phone = asPhone(input.phone);
        if (!email && !phone) throw new ConnectorError('Give an email or a phone to match on');
        const properties: Record<string, string> = {};
        if (email) properties.email = email.toLowerCase();
        if (phone) properties.phone = phone;
        if (input.firstName?.trim()) properties.firstname = input.firstName.trim();
        if (input.lastName?.trim()) properties.lastname = input.lastName.trim();
        for (const pair of (input.properties ?? '').split('|')) {
          const at = pair.indexOf('=');
          const name = pair.slice(0, at).trim();
          if (at > 0 && /^[a-z0-9_]+$/i.test(name)) properties[name] = pair.slice(at + 1).trim();
        }
        const existing = await findContact(ctx, email, phone);
        const res = existing
          ? await call(ctx, 'PATCH', `/crm/v3/objects/contacts/${existing}`, { properties })
          : await call(ctx, 'POST', '/crm/v3/objects/contacts', { properties });
        if (!res.ok) throw failure(res.json, res.status);
        return { contactId: String(obj(res.json).id ?? existing), created: !existing };
      },
    },
    {
      key: 'add_note',
      name: 'Add a note to a contact',
      description: 'Logs a note on the contact, found by id, email or phone',
      input: [
        {
          key: 'contactId',
          label: 'HubSpot contact id',
          required: false,
          placeholder: '{{vars.hubspot_id}}',
        },
        { key: 'email', label: 'Or email', required: false },
        { key: 'phone', label: 'Or phone', required: false, placeholder: '{{contact.phone}}' },
        { key: 'note', label: 'Note', placeholder: 'Asked about order {{vars.order}} on WhatsApp' },
      ],
      output: ['noteId', 'contactId'],
      async run(ctx, input) {
        const contactId =
          (input.contactId ?? '').trim() ||
          (await findContact(ctx, (input.email ?? '').trim(), asPhone(input.phone)));
        if (!contactId) throw new ConnectorError('No HubSpot contact matches');
        const res = await call(ctx, 'POST', '/crm/v3/objects/notes', {
          properties: {
            hs_timestamp: new Date().toISOString(),
            hs_note_body: (input.note ?? '').slice(0, 65_000),
          },
          associations: [
            {
              to: { id: contactId },
              types: [
                { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT },
              ],
            },
          ],
        });
        if (!res.ok) throw failure(res.json, res.status);
        return { noteId: String(obj(res.json).id ?? ''), contactId };
      },
    },
  ],
  async healthCheck(ctx) {
    const res = await call(ctx, 'GET', '/crm/v3/objects/contacts?limit=1');
    if (!res.ok) throw failure(res.json, res.status);
  },
};
