'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  type ContactImportOptionsInput,
  type ContactJobDto,
  MAX_CONTACT_IMPORT_BYTES,
  parseCsvHeader,
} from '@wacrm/shared';
import { type ChangeEvent, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiUpload } from '@/lib/api';
import { contactKeys, useContactFields } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';

const NONE = '__none__';

const guess = (headers: string[], pattern: RegExp) => headers.find((h) => pattern.test(h));

function ColumnSelect({
  id,
  label,
  headers,
  value,
  optional,
  onChange,
}: {
  id: string;
  label: string;
  headers: string[];
  value: string | undefined;
  optional?: boolean;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? undefined : v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a column" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{optional ? 'Do not import' : 'Choose a column'}</SelectItem>
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ImportDialog() {
  const queryClient = useQueryClient();
  const fields = useContactFields();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [phone, setPhone] = useState<string>();
  const [name, setName] = useState<string>();
  const [email, setEmail] = useState<string>();
  const [tags, setTags] = useState<string>();
  const [mapped, setMapped] = useState<Record<string, string | undefined>>({});
  const [country, setCountry] = useState('');
  const [attest, setAttest] = useState(false);
  const [source, setSource] = useState('');
  const [proof, setProof] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setHeaders([]);
    setPhone(undefined);
    setName(undefined);
    setEmail(undefined);
    setTags(undefined);
    setMapped({});
    setCountry('');
    setAttest(false);
    setSource('');
    setProof('');
  };

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    if (!chosen) return;
    if (chosen.size > MAX_CONTACT_IMPORT_BYTES) {
      toast.error('This file is over the 50 MB limit');
      return;
    }
    const found = parseCsvHeader(await chosen.slice(0, 64 * 1024).text());
    if (found.length === 0) {
      toast.error('This file has no header row');
      return;
    }
    setFile(chosen);
    setHeaders(found);
    setPhone(guess(found, /phone|mobile|whats ?app|number|^wa/i));
    setName(guess(found, /name/i));
    setEmail(guess(found, /e-?mail/i));
    setTags(guess(found, /tags?$/i));
    setMapped({});
  };

  const submit = async () => {
    if (!file || !phone) return;
    setBusy(true);
    try {
      const options: ContactImportOptionsInput = {
        columns: {
          phone,
          name,
          email,
          tags,
          fields: Object.fromEntries(
            Object.entries(mapped).filter((e): e is [string, string] => Boolean(e[1])),
          ),
        },
        defaultCountry: country.trim() || undefined,
        consent: attest ? { source, proof } : undefined,
      };
      const form = new FormData();
      // Before the file: the API reads fields that come ahead of it.
      form.append('options', JSON.stringify(options));
      form.append('file', file);
      await apiUpload<ContactJobDto>('/contact-jobs/import', form);
      await queryClient.invalidateQueries({ queryKey: contactKeys.jobs });
      toast.success('Import started. You can keep working while it runs.');
      setOpen(false);
      reset();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const consentReady = !attest || (source.trim() && proof.trim().length >= 3);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import contacts</DialogTitle>
          <DialogDescription>
            Upload a CSV with a header row. Existing numbers are updated, not duplicated.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="import-file">CSV file</Label>
            <Input id="import-file" type="file" accept=".csv" onChange={(e) => void pick(e)} />
          </div>

          {file && (
            <>
              <ColumnSelect
                id="import-phone"
                label="Phone column"
                headers={headers}
                value={phone}
                onChange={setPhone}
              />
              <FormField
                label="Default country"
                name="import-country"
                value={country}
                maxLength={2}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="IN"
                hint="For numbers written without a country code. Two letters."
              />
              <ColumnSelect
                id="import-name"
                label="Name column"
                headers={headers}
                value={name}
                optional
                onChange={setName}
              />
              <ColumnSelect
                id="import-email"
                label="Email column"
                headers={headers}
                value={email}
                optional
                onChange={setEmail}
              />
              <ColumnSelect
                id="import-tags"
                label="Tags column"
                headers={headers}
                value={tags}
                optional
                onChange={setTags}
              />
              {fields.data?.map((f) => (
                <ColumnSelect
                  key={f.id}
                  id={`import-field-${f.key}`}
                  label={f.label}
                  headers={headers}
                  value={mapped[f.key]}
                  optional
                  onChange={(v) => setMapped((m) => ({ ...m, [f.key]: v }))}
                />
              ))}

              <div className="grid gap-3 rounded-md border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={attest}
                    onChange={(e) => setAttest(e.target.checked)}
                  />
                  Everyone in this file agreed to receive marketing messages from us
                </label>
                {attest && (
                  <>
                    <FormField
                      label="Where consent came from"
                      name="import-source"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      placeholder="Website signup form"
                    />
                    <FormField
                      label="Proof of consent"
                      name="import-proof"
                      value={proof}
                      onChange={(e) => setProof(e.target.value)}
                      placeholder="Checkbox on example.com/join, kept in our CRM"
                    />
                  </>
                )}
                <p className="text-xs text-muted-foreground">
                  {attest
                    ? 'Saved on each contact. Anyone who already opted out stays opted out.'
                    : 'Without this, new contacts cannot receive marketing templates.'}
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button disabled={!file || !phone || !consentReady || busy} onClick={() => void submit()}>
            {busy ? 'Uploading…' : 'Start import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
