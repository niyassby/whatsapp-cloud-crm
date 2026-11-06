'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  EDITABLE_AT_META,
  HEADER_MEDIA_RULES,
  type MediaHeaderFormat,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  type TemplateButton,
  type TemplateDefinition,
  type TemplateDto,
  templateIssues,
  templateVariables,
  templateWarnings,
  type VariableSource,
} from '@wacrm/shared';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FormField } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { api, apiUpload } from '@/lib/api';
import { useContactFields } from '@/lib/contacts';
import { handleApiError } from '@/lib/forms';
import { templateKeys, useTemplateAccounts, useTemplateMediaUrl } from '@/lib/templates';
import { TemplatePreview } from './template-preview';
import { rejectionText, TemplateStatusBadge } from './template-status';

type HeaderChoice = 'NONE' | 'TEXT' | MediaHeaderFormat;

const HEADER_LABELS: Record<HeaderChoice, string> = {
  NONE: 'No header',
  TEXT: 'Text',
  IMAGE: 'Image',
  VIDEO: 'Video',
  DOCUMENT: 'PDF document',
};

const BUTTON_LABELS: Record<TemplateButton['type'], string> = {
  QUICK_REPLY: 'Quick reply',
  URL: 'Link',
  PHONE_NUMBER: 'Call',
  COPY_CODE: 'Copy code',
};

const NEW_BUTTON: Record<TemplateButton['type'], TemplateButton> = {
  QUICK_REPLY: { type: 'QUICK_REPLY', text: '' },
  URL: { type: 'URL', text: '', url: 'https://' },
  PHONE_NUMBER: { type: 'PHONE_NUMBER', text: '', phoneNumber: '' },
  COPY_CODE: { type: 'COPY_CODE', example: '' },
};

/** Select values for a variable's source. */
const STATIC = 'static';
const sourceValue = (s: VariableSource | undefined) => {
  if (!s || s.source === 'static') return STATIC;
  return s.source === 'custom' ? `custom:${s.key}` : `contact:${s.field}`;
};

function parseSource(value: string, staticValue: string): VariableSource {
  if (value.startsWith('custom:')) return { source: 'custom', key: value.slice('custom:'.length) };
  if (value.startsWith('contact:')) {
    return {
      source: 'contact',
      field: value.slice('contact:'.length) as 'first_name' | 'name' | 'phone' | 'email',
    };
  }
  return { source: 'static', value: staticValue };
}

function toName(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 512);
}

export function TemplateForm({ template }: { template?: TemplateDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const accounts = useTemplateAccounts();
  const fields = useContactFields();
  const def = template?.definition;

  const [name, setName] = useState(template?.name ?? '');
  const [language, setLanguage] = useState(template?.language ?? 'en_US');
  const [category, setCategory] = useState(template?.category ?? 'UTILITY');
  const [wabaAccountId, setWabaAccountId] = useState<string>();
  const [headerChoice, setHeaderChoice] = useState<HeaderChoice>(def?.header?.format ?? 'NONE');
  const [headerText, setHeaderText] = useState(
    def?.header?.format === 'TEXT' ? def.header.text : '',
  );
  const [body, setBody] = useState(def?.body ?? '');
  const [footer, setFooter] = useState(def?.footer ?? '');
  const [buttons, setButtons] = useState<TemplateButton[]>(def?.buttons ?? []);
  const [samples, setSamples] = useState<Record<string, string>>(template?.samples ?? {});
  const [mapping, setMapping] = useState<Record<string, VariableSource>>(
    template?.variableMapping ?? {},
  );
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEdit, setConfirmEdit] = useState(false);

  const isDraft = !template?.metaTemplateId;
  const unsupported = template && !template.supported;
  const canEditContent =
    !unsupported && (isDraft || EDITABLE_AT_META.includes(template?.status ?? ''));

  const storedMedia = useTemplateMediaUrl(template?.id ?? '', Boolean(template?.headerMedia));
  useEffect(() => {
    if (!file) {
      setFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const definition = useMemo<TemplateDefinition>(
    () => ({
      header:
        headerChoice === 'NONE'
          ? null
          : headerChoice === 'TEXT'
            ? { format: 'TEXT', text: headerText.trim() }
            : { format: headerChoice },
      body: body.trim(),
      footer: footer.trim() || null,
      buttons,
    }),
    [headerChoice, headerText, body, footer, buttons],
  );
  const variables = useMemo(() => templateVariables(definition), [definition]);
  const issues = useMemo(
    () => (body.trim() ? templateIssues(definition, samples) : []),
    [definition, samples, body],
  );
  const warnings = useMemo(() => templateWarnings(definition), [definition]);
  const mediaHeader = headerChoice !== 'NONE' && headerChoice !== 'TEXT' ? headerChoice : null;
  const hasMedia = Boolean(file ?? template?.headerMedia);
  const nameOk = /^[a-z0-9_]+$/.test(name);
  const buttonsOk = buttons.every((b) =>
    b.type === 'COPY_CODE'
      ? Boolean(b.example.trim())
      : b.text.trim() && (b.type !== 'PHONE_NUMBER' || /^\+?\d{5,20}$/.test(b.phoneNumber.trim())),
  );
  const contentReady =
    nameOk &&
    Boolean(body.trim()) &&
    issues.length === 0 &&
    buttonsOk &&
    (headerChoice !== 'TEXT' || Boolean(headerText.trim()));

  const payload = () => ({
    name,
    language,
    category,
    definition,
    samples,
    variableMapping: mapping,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: templateKeys.all });

  const uploadFile = async (id: string) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    await apiUpload<TemplateDto>(`/templates/${id}/header-media`, form);
    setFile(null);
  };

  /** A new draft is created first, because its file is stored against its id. */
  const saveDraft = async (): Promise<string> => {
    if (template) {
      if (file) await uploadFile(template.id);
      await api<TemplateDto>(`/templates/${template.id}`, { method: 'PATCH', body: payload() });
      return template.id;
    }
    const created = await api<TemplateDto>('/templates', {
      method: 'POST',
      body: { ...payload(), wabaAccountId },
    });
    await uploadFile(created.id);
    return created.id;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const id = await saveDraft();
      await refresh();
      toast.success('Saved');
      if (!template) router.replace(`/templates/${id}`);
    });

  const submit = () =>
    run(async () => {
      const id = await saveDraft();
      await api<TemplateDto>(`/templates/${id}/submit`, { method: 'POST' });
      await refresh();
      toast.success('Sent to Meta for review');
      if (!template) router.replace(`/templates/${id}`);
    });

  const saveToMeta = () =>
    run(async () => {
      setConfirmEdit(false);
      await saveDraft();
      await refresh();
      toast.success('Saved');
    });

  const setButton = (index: number, next: TemplateButton) =>
    setButtons((all) => all.map((b, i) => (i === index ? next : b)));

  const previewValues = useMemo(
    () =>
      Object.fromEntries(
        variables.map((v) => {
          const source = mapping[v.key];
          return [v.key, (source?.source === 'static' && source.value) || samples[v.key] || ''];
        }),
      ),
    [variables, mapping, samples],
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid gap-4">
        {template?.status === 'rejected' && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>Meta rejected this template</AlertTitle>
            <AlertDescription>
              <p>{rejectionText(template.rejectedReason)}</p>
              {template.statusDetail && <p>{template.statusDetail}</p>}
              <p>Change it below and save to send it for review again.</p>
            </AlertDescription>
          </Alert>
        )}
        {template?.status !== 'rejected' && template?.statusDetail && (
          <Alert>
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>A note from Meta</AlertTitle>
            <AlertDescription>{template.statusDetail}</AlertDescription>
          </Alert>
        )}
        {unsupported && (
          <Alert>
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>Made outside this app</AlertTitle>
            <AlertDescription>
              This template uses parts this app cannot edit or send yet. Change it in WhatsApp
              Manager.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Basics {template && <TemplateStatusBadge status={template.status} />}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {!template && (accounts.data?.length ?? 0) > 1 && (
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="template-account">WhatsApp account</Label>
                <Select
                  value={wabaAccountId ?? accounts.data?.[0]?.id ?? ''}
                  onValueChange={setWabaAccountId}
                >
                  <SelectTrigger id="template-account" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.data?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name ?? a.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="sm:col-span-2">
              <FormField
                label="Name"
                name="template-name"
                value={name}
                disabled={!isDraft}
                onChange={(e) => setName(toName(e.target.value))}
                placeholder="order_ready"
                hint="Lowercase letters, numbers and underscores. It cannot change once submitted."
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="template-language">Language</Label>
              <Select value={language} onValueChange={setLanguage} disabled={!isDraft}>
                <SelectTrigger id="template-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_LANGUAGES.some((l) => l.code === language) ? null : (
                    <SelectItem value={language}>{language}</SelectItem>
                  )}
                  {TEMPLATE_LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="template-category">Category</Label>
              <Select
                value={category}
                onValueChange={setCategory}
                disabled={!canEditContent || template?.status === 'approved'}
              >
                <SelectTrigger id="template-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c === 'MARKETING' ? 'Marketing' : 'Utility'}
                    </SelectItem>
                  ))}
                  {(TEMPLATE_CATEGORIES as readonly string[]).includes(category) ? null : (
                    <SelectItem value={category}>{category}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {category === 'MARKETING'
                  ? 'Only opted-in contacts can receive this.'
                  : 'For updates about something the customer already did or asked for.'}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Message</CardTitle>
            <CardDescription>
              Add variables by writing {'{{1}}'}, {'{{2}}'} or a name like {'{{first_name}}'}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset disabled={!canEditContent} className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="template-header">Header</Label>
                <Select
                  value={headerChoice}
                  disabled={!canEditContent}
                  onValueChange={(v) => setHeaderChoice(v as HeaderChoice)}
                >
                  <SelectTrigger id="template-header" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(HEADER_LABELS) as HeaderChoice[]).map((h) => (
                      <SelectItem key={h} value={h}>
                        {HEADER_LABELS[h]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {headerChoice === 'TEXT' && (
                <FormField
                  label="Header text"
                  name="template-header-text"
                  value={headerText}
                  maxLength={60}
                  onChange={(e) => setHeaderText(e.target.value)}
                />
              )}
              {mediaHeader && (
                <div className="grid gap-1.5">
                  <Label htmlFor="template-header-file">Header file</Label>
                  <Input
                    id="template-header-file"
                    type="file"
                    accept={HEADER_MEDIA_RULES[mediaHeader].types.join(',')}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Meta reviews this file, and customers receive it.
                    {template?.headerMedia?.filename
                      ? ` Current file: ${template.headerMedia.filename}.`
                      : ''}
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="template-body">Body</Label>
                <textarea
                  id="template-body"
                  value={body}
                  maxLength={1024}
                  rows={5}
                  onChange={(e) => setBody(e.target.value)}
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
                />
                <p className="text-right text-xs text-muted-foreground">{body.length} / 1024</p>
              </div>
              <FormField
                label="Footer (optional)"
                name="template-footer"
                value={footer}
                maxLength={60}
                onChange={(e) => setFooter(e.target.value)}
              />

              <div className="grid gap-2">
                <Label>Buttons (optional)</Label>
                {buttons.map((b, i) => (
                  <div
                    key={i}
                    className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <p className="text-sm font-medium sm:col-span-3">{BUTTON_LABELS[b.type]}</p>
                    {b.type !== 'COPY_CODE' && (
                      <Input
                        aria-label={`Button ${i + 1} text`}
                        placeholder="Button text"
                        maxLength={25}
                        value={b.text}
                        onChange={(e) => setButton(i, { ...b, text: e.target.value })}
                      />
                    )}
                    {b.type === 'URL' && (
                      <Input
                        aria-label={`Button ${i + 1} link`}
                        placeholder="https://example.com/order/{{1}}"
                        value={b.url}
                        onChange={(e) => setButton(i, { ...b, url: e.target.value })}
                      />
                    )}
                    {b.type === 'PHONE_NUMBER' && (
                      <Input
                        aria-label={`Button ${i + 1} phone number`}
                        placeholder="+919876543210"
                        value={b.phoneNumber}
                        onChange={(e) => setButton(i, { ...b, phoneNumber: e.target.value })}
                      />
                    )}
                    {b.type === 'COPY_CODE' && (
                      <Input
                        aria-label={`Button ${i + 1} sample code`}
                        placeholder="Sample code, like SAVE10"
                        maxLength={20}
                        value={b.example}
                        onChange={(e) => setButton(i, { ...b, example: e.target.value })}
                      />
                    )}
                    {b.type === 'QUICK_REPLY' && <span />}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove button ${i + 1}`}
                      onClick={() => setButtons((all) => all.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(BUTTON_LABELS) as TemplateButton['type'][]).map((type) => (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={buttons.length >= 10 || !canEditContent}
                      onClick={() => setButtons((all) => [...all, { ...NEW_BUTTON[type] }])}
                    >
                      <Plus className="size-3.5" aria-hidden /> {BUTTON_LABELS[type]}
                    </Button>
                  ))}
                </div>
              </div>
            </fieldset>
          </CardContent>
        </Card>

        {variables.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
              <CardDescription>
                Meta reviews the samples. When sending, each value comes from where you choose here,
                and can still be changed.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {variables.map((v) => {
                const source = mapping[v.key];
                const isSample = v.subType !== 'copy_code';
                return (
                  <div key={v.key} className="grid gap-2 sm:grid-cols-2">
                    <p className="text-sm font-medium sm:col-span-2">{v.label}</p>
                    {isSample && (
                      <FormField
                        label="Sample for review"
                        name={`sample-${v.key}`}
                        value={samples[v.key] ?? ''}
                        disabled={!canEditContent}
                        onChange={(e) => setSamples((s) => ({ ...s, [v.key]: e.target.value }))}
                      />
                    )}
                    <div className="grid content-start gap-1.5">
                      <Label htmlFor={`source-${v.key}`}>Value when sending</Label>
                      <Select
                        value={sourceValue(source)}
                        onValueChange={(value) =>
                          setMapping((m) => ({ ...m, [v.key]: parseSource(value, '') }))
                        }
                      >
                        <SelectTrigger id={`source-${v.key}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={STATIC}>Fixed text or typed each time</SelectItem>
                          <SelectItem value="contact:first_name">Contact first name</SelectItem>
                          <SelectItem value="contact:name">Contact full name</SelectItem>
                          <SelectItem value="contact:phone">Contact phone</SelectItem>
                          <SelectItem value="contact:email">Contact email</SelectItem>
                          {fields.data?.map((f) => (
                            <SelectItem key={f.key} value={`custom:${f.key}`}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {sourceValue(source) === STATIC && (
                      <FormField
                        label="Fixed text (optional)"
                        name={`static-${v.key}`}
                        value={source?.source === 'static' ? source.value : ''}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [v.key]: { source: 'static', value: e.target.value },
                          }))
                        }
                      />
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {(issues.length > 0 || warnings.length > 0) && (
          <ul className="grid gap-1 text-sm" aria-label="Things to fix">
            {issues.map((issue, i) => (
              <li key={i} className="text-destructive">
                {issue.message}
              </li>
            ))}
            {warnings.map((w, i) => (
              <li key={i} className="text-muted-foreground">
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {isDraft ? (
            <>
              <Button
                variant="outline"
                disabled={busy || !contentReady}
                onClick={() => void save()}
              >
                Save draft
              </Button>
              <Button
                disabled={busy || !contentReady || (Boolean(mediaHeader) && !hasMedia)}
                onClick={() => void submit()}
              >
                {busy ? 'Working…' : 'Submit to Meta'}
              </Button>
            </>
          ) : canEditContent ? (
            <Button
              disabled={busy || !contentReady}
              onClick={() =>
                template?.status === 'approved' ? setConfirmEdit(true) : void saveToMeta()
              }
            >
              {busy ? 'Working…' : 'Save'}
            </Button>
          ) : (
            !unsupported &&
            template?.definition && (
              <Button variant="outline" disabled={busy} onClick={() => void saveToMeta()}>
                Save variable sources
              </Button>
            )
          )}
          {mediaHeader && !hasMedia && (
            <p className="self-center text-sm text-muted-foreground">
              Choose a header file before submitting.
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-2 lg:sticky lg:top-0">
        <h2 className="text-sm font-medium">Preview</h2>
        <TemplatePreview
          definition={{ ...definition, body: definition.body || 'Your message appears here.' }}
          values={previewValues}
          mediaUrl={filePreview ?? storedMedia.data?.url}
          mediaName={file?.name ?? template?.headerMedia?.filename}
        />
      </div>

      <Dialog open={confirmEdit} onOpenChange={setConfirmEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send changes to Meta?</DialogTitle>
            <DialogDescription>
              If you changed the message, Meta reviews it again and this template cannot be sent
              until it is approved. Meta also limits how often approved templates can be edited.
              Changing only where variable values come from needs no review.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEdit(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void saveToMeta()}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
