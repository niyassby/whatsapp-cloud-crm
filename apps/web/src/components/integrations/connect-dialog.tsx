'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { ConnectorDto, ConnectorFieldDto, CreatedConnectionDto } from '@wacrm/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { FormField } from '@/components/form-field';
import { ShownOnce } from '@/components/settings/shown-once';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { handleApiError } from '@/lib/forms';
import { integrationKeys } from '@/lib/integrations';

export function ConnectorFields({
  fields,
  values,
  onChange,
  prefix,
}: {
  fields: ConnectorFieldDto[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  prefix: string;
}) {
  return (
    <>
      {fields.map((f) => (
        <FormField
          key={f.key}
          label={f.required ? f.label : `${f.label} (optional)`}
          name={`${prefix}-${f.key}`}
          type={f.type === 'secret' ? 'password' : f.type === 'url' ? 'url' : 'text'}
          autoComplete="off"
          placeholder={f.placeholder ?? undefined}
          hint={f.help ?? undefined}
          value={values[f.key] ?? ''}
          onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
        />
      ))}
    </>
  );
}

/** Connect an app: API key fields, or off to the provider to sign in. */
export function ConnectDialog({
  connector,
  onClose,
}: {
  connector: ConnectorDto | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedConnectionDto | null>(null);

  if (!connector) return null;
  const close = () => {
    setName('');
    setCredentials({});
    setSettings({});
    setCreated(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = { connectorKey: connector.key, name: name.trim() || connector.name, settings };
    try {
      if (connector.authType === 'oauth2') {
        const { url } = await api<{ url: string }>('/integrations/oauth/start', {
          method: 'POST',
          body,
        });
        window.location.assign(url);
        return;
      }
      const conn = await api<CreatedConnectionDto>('/integrations/connections', {
        method: 'POST',
        body: { ...body, credentials },
      });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.connections });
      if (conn.webhookSecret) setCreated(conn);
      else router.push(`/integrations/${conn.id}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{connector.name} is connected</DialogTitle>
              <DialogDescription>
                In {connector.name}, add a webhook with this address and signing secret, so its
                events reach your flows.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Webhook address</span>
              <code className="rounded bg-muted p-2 text-xs break-all" data-testid="webhook-url">
                {created.webhookUrl}
              </code>
            </div>
            <ShownOnce
              title="Signing secret"
              value={created.webhookSecret!}
              onDone={() => {
                const id = created.id;
                close();
                router.push(`/integrations/${id}`);
              }}
            />
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Connect {connector.name}</DialogTitle>
              <DialogDescription>{connector.description}</DialogDescription>
            </DialogHeader>
            <FormField
              label="Name"
              name="connection-name"
              placeholder={connector.name}
              hint="To tell several connections apart, such as two stores."
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            <ConnectorFields
              fields={connector.settings}
              values={settings}
              onChange={setSettings}
              prefix="setting"
            />
            {connector.authType === 'api_key' && (
              <ConnectorFields
                fields={connector.credentials}
                values={credentials}
                onChange={setCredentials}
                prefix="credential"
              />
            )}
            {connector.authType === 'oauth2' && (
              <p className="text-sm text-muted-foreground">
                You will sign in to {connector.name} to allow access, then come back here.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {connector.authType === 'oauth2' ? `Continue to ${connector.name}` : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
