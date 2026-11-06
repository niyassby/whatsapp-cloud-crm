'use client';

import {
  type CampaignDto,
  parseCsvHeader,
  templateDefinitionSchema,
  templateVariables,
} from '@wacrm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, type FormEvent, useMemo, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, apiUpload } from '@/lib/api';
import { useSegments } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { usePhoneNumbers } from '@/lib/queries';
import { useTemplates } from '@/lib/templates';

const NONE = '__none__';
type AudienceKind = 'all' | 'segment' | 'csv';

export default function NewCampaignPage() {
  const router = useRouter();
  const phones = usePhoneNumbers();
  const templates = useTemplates('approved', '');
  const segments = useSegments();

  const [name, setName] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [kind, setKind] = useState<AudienceKind>('all');
  const [segmentId, setSegmentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [phoneColumn, setPhoneColumn] = useState('');
  const [nameColumn, setNameColumn] = useState(NONE);
  const [defaultCountry, setDefaultCountry] = useState('');
  const [variableColumns, setVariableColumns] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const connected = (phones.data ?? []).filter((p) => p.status === 'connected');
  const phone = connected.find((p) => p.id === phoneId);
  // Templates belong to a WhatsApp account, so only that number's account can send them.
  const usable = (templates.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (t) => t.supported && (!phone || t.wabaAccountId === phone.wabaAccountId),
  );
  const template = usable.find((t) => t.id === templateId);
  const variables = useMemo(() => {
    const parsed = templateDefinitionSchema.safeParse(template?.definition);
    return parsed.success ? templateVariables(parsed.data) : [];
  }, [template]);

  const chooseFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0] ?? null;
    setFile(chosen);
    if (!chosen) return setHeaders([]);
    const found = parseCsvHeader(await chosen.slice(0, 64 * 1024).text());
    setHeaders(found);
    setPhoneColumn(found.find((h) => /phone|mobile|whatsapp|number/i.test(h)) ?? '');
    setNameColumn(found.find((h) => /name/i.test(h)) ?? NONE);
    setVariableColumns({});
  };

  const ready =
    name.trim() &&
    phoneId &&
    templateId &&
    (kind === 'all' || (kind === 'segment' ? segmentId : file && phoneColumn));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const draft = await api<CampaignDto>('/campaigns', {
        method: 'POST',
        body: {
          name: name.trim(),
          phoneId,
          templateId,
          audience: kind === 'segment' ? { type: 'segment', segmentId } : { type: 'segment' },
        },
      });
      if (kind === 'csv' && file) {
        const form = new FormData();
        // Options first: the API reads fields that come before the file.
        form.append(
          'options',
          JSON.stringify({
            phoneColumn,
            ...(nameColumn !== NONE ? { nameColumn } : {}),
            ...(defaultCountry.trim()
              ? { defaultCountry: defaultCountry.trim().toUpperCase() }
              : {}),
            variableColumns,
          }),
        );
        form.append('file', file);
        await apiUpload(`/campaigns/${draft.id}/audience-csv`, form);
      }
      router.push(`/campaigns/${draft.id}`);
    } catch (err) {
      handleApiError(err);
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <form onSubmit={(e) => void submit(e)} className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <div>
          <h1 className="text-xl font-semibold">New campaign</h1>
          <p className="text-sm text-muted-foreground">
            This saves a draft. You see who it reaches and what it costs before anything sends.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Message</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <FormField
              label="Campaign name"
              name="name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Diwali offer"
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campaign-phone">WhatsApp number</Label>
              <Select
                value={phoneId}
                onValueChange={(v) => {
                  setPhoneId(v);
                  setTemplateId('');
                }}
              >
                <SelectTrigger id="campaign-phone" className="w-full">
                  <SelectValue placeholder="Choose a number" />
                </SelectTrigger>
                <SelectContent>
                  {connected.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayPhoneNumber ?? p.phoneNumberId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campaign-template">Approved template</Label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={!phoneId}>
                <SelectTrigger id="campaign-template" className="w-full">
                  <SelectValue
                    placeholder={phoneId ? 'Choose a template' : 'Choose a number first'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {phoneId && usable.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No approved templates on this number’s account.{' '}
                  <Link href="/templates/new" className="underline">
                    Create one
                  </Link>
                </p>
              )}
              {template && variables.length > 0 && kind !== 'csv' && (
                <p className="text-sm text-muted-foreground">
                  Variables are filled from the{' '}
                  <Link href={`/templates/${template.id}`} className="underline">
                    template’s mapping
                  </Link>
                  . Anyone with no value is skipped.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audience</CardTitle>
            <CardDescription>
              Opted-out contacts are always skipped. Marketing templates also skip anyone without
              recorded consent.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campaign-audience">Send to</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as AudienceKind)}>
                <SelectTrigger id="campaign-audience" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All contacts</SelectItem>
                  <SelectItem value="segment">A saved segment</SelectItem>
                  <SelectItem value="csv">A CSV file</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {kind === 'segment' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="campaign-segment">Segment</Label>
                <Select value={segmentId} onValueChange={setSegmentId}>
                  <SelectTrigger id="campaign-segment" className="w-full">
                    <SelectValue placeholder="Choose a segment" />
                  </SelectTrigger>
                  <SelectContent>
                    {(segments.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {kind === 'csv' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="campaign-file">CSV file (up to 50 MB)</Label>
                  <input
                    id="campaign-file"
                    type="file"
                    accept=".csv,text/csv"
                    className="text-sm"
                    onChange={(e) => void chooseFile(e)}
                  />
                  <p className="text-sm text-muted-foreground">
                    New numbers become contacts with no consent recorded, so they only receive
                    utility templates.
                  </p>
                </div>
                {headers.length > 0 && (
                  <>
                    <ColumnSelect
                      id="csv-phone"
                      label="Phone column"
                      headers={headers}
                      value={phoneColumn}
                      onChange={setPhoneColumn}
                    />
                    <ColumnSelect
                      id="csv-name"
                      label="Name column (optional)"
                      headers={headers}
                      value={nameColumn}
                      onChange={setNameColumn}
                      optional
                    />
                    <FormField
                      label="Country for numbers with no + (optional)"
                      name="default-country"
                      value={defaultCountry}
                      maxLength={2}
                      placeholder="IN"
                      onChange={(e) => setDefaultCountry(e.target.value)}
                    />
                    {variables.map((v) => (
                      <ColumnSelect
                        key={v.key}
                        id={`csv-var-${v.key}`}
                        label={`Column for ${v.key}`}
                        headers={headers}
                        optional
                        value={variableColumns[v.key] ?? NONE}
                        onChange={(column) =>
                          setVariableColumns((current) => {
                            const next = { ...current };
                            if (column === NONE) delete next[v.key];
                            else next[v.key] = column;
                            return next;
                          })
                        }
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" asChild>
            <Link href="/campaigns">Back</Link>
          </Button>
          <Button type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Save and review'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ColumnSelect({
  id,
  label,
  headers,
  value,
  onChange,
  optional,
}: {
  id: string;
  label: string;
  headers: string[];
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a column" />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value={NONE}>None</SelectItem>}
          {headers
            .filter((h) => h)
            .map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
