import type { ConnectorDto, ConnectorFieldDto } from '@wacrm/shared';
import type { ConnectorDefinition, ConnectorField } from './types';

const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const ITEM_KEY = /^[a-z][a-z0-9_.]{0,63}$/;

/** Why a definition cannot be registered, or null. Checked once, at start-up. */
export function connectorProblem(def: ConnectorDefinition): string | null {
  if (!KEY.test(def.key))
    return `Connector key "${def.key}" must be lower-case letters, numbers, _`;
  const unique = (what: string, keys: string[]) => {
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    return dup ? `${def.key}: two ${what} are called "${dup}"` : null;
  };
  const triggers = (def.triggers ?? []).map((t) => t.key);
  const actions = (def.actions ?? []).map((a) => a.key);
  for (const k of [...triggers, ...actions]) {
    if (!ITEM_KEY.test(k)) return `${def.key}: "${k}" is not a valid trigger or action key`;
  }
  const credentialKeys = def.auth.type === 'api_key' ? def.auth.fields.map((f) => f.key) : [];
  return (
    unique('triggers', triggers) ??
    unique('actions', actions) ??
    unique('credential fields', credentialKeys) ??
    unique(
      'settings',
      (def.settings ?? []).map((f) => f.key),
    ) ??
    ((def.triggers?.length ?? 0) > 0 && !def.webhook && !def.sync
      ? `${def.key}: triggers need a webhook or a sync to arrive through`
      : null)
  );
}

const fieldDto = (f: ConnectorField): ConnectorFieldDto => ({
  key: f.key,
  label: f.label,
  type: f.type ?? 'text',
  required: f.required ?? true,
  help: f.help ?? null,
  placeholder: f.placeholder ?? null,
});

/** The connectors this server knows. The API and the worker build the same one at start-up. */
export class ConnectorRegistry {
  private readonly byKey = new Map<string, ConnectorDefinition>();

  constructor(
    defs: ConnectorDefinition[] = [],
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const def of defs) this.register(def);
  }

  register(def: ConnectorDefinition): this {
    const problem = connectorProblem(def);
    if (problem) throw new Error(problem);
    if (this.byKey.has(def.key)) throw new Error(`Connector ${def.key} is registered twice`);
    this.byKey.set(def.key, def);
    return this;
  }

  get(key: string): ConnectorDefinition | undefined {
    return this.byKey.get(key);
  }

  list(): ConnectorDefinition[] {
    return [...this.byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** OAuth connectors need the app's client id and secret before anyone can connect. */
  available(def: ConnectorDefinition): boolean {
    if (def.auth.type !== 'oauth2') return true;
    return Boolean(this.env[def.auth.clientIdEnv] && this.env[def.auth.clientSecretEnv]);
  }

  toDto(def: ConnectorDefinition): ConnectorDto {
    return {
      key: def.key,
      name: def.name,
      description: def.description,
      category: def.category,
      website: def.website ?? null,
      authType: def.auth.type,
      credentials: def.auth.type === 'api_key' ? def.auth.fields.map(fieldDto) : [],
      settings: (def.settings ?? []).map(fieldDto),
      triggers: (def.triggers ?? []).map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        sample: t.sample ?? {},
      })),
      actions: (def.actions ?? []).map((a) => ({
        key: a.key,
        name: a.name,
        description: a.description,
        input: (a.input ?? []).map(fieldDto),
        output: a.output ?? [],
      })),
      receivesWebhooks: Boolean(def.webhook),
      syncs: Boolean(def.sync),
      available: this.available(def),
    };
  }
}

/** The credential key that holds a connector's webhook signing secret. */
export const webhookSecretField = (def: ConnectorDefinition) =>
  def.webhook?.secretField ?? 'webhookSecret';

/** Fill {settings.x} in a URL from the connection's settings, encoded. */
export function fillSettings(template: string, settings: Record<string, string>): string {
  return template.replace(/\{settings\.([a-zA-Z0-9_]+)\}/g, (_, k: string) =>
    encodeURIComponent(settings[k] ?? ''),
  );
}
