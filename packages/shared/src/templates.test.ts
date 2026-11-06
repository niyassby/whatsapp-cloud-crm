import { describe, expect, it } from 'vitest';
import {
  buildSendComponents,
  cleanVariableValue,
  createTemplateSchema,
  fromMetaComponents,
  parameterFormatOf,
  renderTemplate,
  renderedText,
  resolveVariable,
  sameJsonValue,
  type TemplateDefinition,
  templateIssues,
  templateVariables,
  templateWarnings,
  toMetaComponents,
} from './templates';

const def = (over: Partial<TemplateDefinition> = {}): TemplateDefinition => ({
  header: null,
  body: 'Hi there, your order is ready.',
  footer: null,
  buttons: [],
  ...over,
});

const messages = (d: TemplateDefinition, samples: Record<string, string> = {}) =>
  templateIssues(d, samples).map((i) => i.message);

describe('templateIssues', () => {
  it('accepts a plain template', () => {
    expect(messages(def())).toEqual([]);
  });

  it('accepts variables with samples', () => {
    const d = def({ body: 'Hi {{1}}, your order {{2}} shipped.' });
    expect(messages(d, { 'body.1': 'Asha', 'body.2': '42' })).toEqual([]);
  });

  it.each([
    ['{{1}} is ready for you', 'cannot start or end'],
    ['Your order is {{1}}', 'cannot start or end'],
    ['Hi {{1}} {{2}} there', 'text between variables'],
    ['Hi {{2}} there', 'in order'],
    ['Hi {{1}} and {{1}} there', 'only once'],
    ['Hi {{1}} and {{name}} there', 'not both'],
    ['Hi {{ 1 }} there', 'no spaces'],
    ['Hi {{First}} there', 'no spaces'],
    ['Hi {1}} there', 'no spaces'],
  ])('rejects the body %s', (body, expected) => {
    expect(messages(def({ body })).join(' ')).toContain(expected);
  });

  it('needs a sample for every variable', () => {
    expect(messages(def({ body: 'Hi {{first_name}}, welcome.' }))).toEqual([
      'Add a sample for Body {{first_name}}',
    ]);
  });

  it('limits header variables and forbids them in the footer', () => {
    expect(
      messages(def({ header: { format: 'TEXT', text: '{{1}} and {{2}}' } }), {
        'header.1': 'a',
        'header.2': 'b',
      }),
    ).toContain('A header can have only one variable');
    expect(messages(def({ footer: 'Thanks {{1}}' }))).toContain('A footer cannot have variables');
  });

  it('applies button limits and grouping', () => {
    const quick = { type: 'QUICK_REPLY', text: 'Yes' } as const;
    const url = { type: 'URL', text: 'Go', url: 'https://example.com' } as const;
    const call = { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '15550051310' } as const;
    const code = { type: 'COPY_CODE', example: 'SAVE10' } as const;

    expect(messages(def({ buttons: [quick, quick, url, call] }))).toEqual([]);
    expect(messages(def({ buttons: [url, call, quick, quick] }))).toEqual([]);
    expect(messages(def({ buttons: [quick, url, quick] }))).toContain(
      'Keep quick replies next to each other',
    );
    expect(messages(def({ buttons: [url, url, url] }))).toContain('Use at most 2 link buttons');
    expect(messages(def({ buttons: [call, call] }))).toContain('Use at most 1 call button');
    expect(messages(def({ buttons: [code, code] }))).toContain('Use at most 1 copy-code button');
  });

  it('only allows one link variable, at the end', () => {
    const buttons = (u: string) =>
      [{ type: 'URL', text: 'Go', url: u }] as TemplateDefinition['buttons'];
    expect(
      messages(def({ buttons: buttons('https://example.com/o/{{1}}') }), { 'button.0.1': 'x' }),
    ).toEqual([]);
    expect(
      messages(def({ buttons: buttons('https://example.com/{{1}}/track') }), {
        'button.0.1': 'x',
      }).join(' '),
    ).toContain('at the very end');
    expect(messages(def({ buttons: buttons('not a url') })).join(' ')).toContain(
      'full web address',
    );
  });
});

describe('sameJsonValue', () => {
  it('ignores key order, as Postgres reorders stored keys', () => {
    expect(
      sameJsonValue(
        { a: 1, b: { c: [1, { d: 2, e: 3 }] } },
        { b: { c: [1, { e: 3, d: 2 }] }, a: 1 },
      ),
    ).toBe(true);
  });
  it('treats a missing value and null alike', () => {
    expect(sameJsonValue({ a: null }, { a: undefined })).toBe(true);
  });
  it('sees real differences, including array order', () => {
    expect(sameJsonValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
  });
});

describe('createTemplateSchema', () => {
  const base = {
    name: 'order_ready',
    language: 'en_US',
    category: 'UTILITY',
    definition: { body: 'Hi there, your order is ready.' },
  };

  it('fills defaults', () => {
    expect(createTemplateSchema.parse(base).definition).toEqual({
      header: null,
      body: 'Hi there, your order is ready.',
      footer: null,
      buttons: [],
    });
  });

  it.each(['Order Ready', 'order-ready', 'ORDER', ''])('rejects the name %j', (name) => {
    expect(createTemplateSchema.safeParse({ ...base, name }).success).toBe(false);
  });

  it('does not offer the authentication category', () => {
    expect(createTemplateSchema.safeParse({ ...base, category: 'AUTHENTICATION' }).success).toBe(
      false,
    );
  });

  it('points an issue at the field', () => {
    const res = createTemplateSchema.safeParse({
      ...base,
      definition: { body: 'Hi {{1}} there' },
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['samples', 'body.1']);
  });
});

describe('templateWarnings', () => {
  it('warns about many variables in little text', () => {
    expect(templateWarnings(def({ body: 'Hi {{1}}, order {{2}} due {{3}} ok' }))).toHaveLength(1);
    expect(templateWarnings(def())).toEqual([]);
  });
});

describe('variables', () => {
  const full = def({
    header: { format: 'TEXT', text: 'Order {{1}} update' },
    body: 'Hi {{1}}, thanks for your order.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Stop' },
      { type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}' },
      { type: 'COPY_CODE', example: 'SAVE10' },
    ],
  });

  it('lists every variable, with the button position Meta expects', () => {
    expect(templateVariables(full).map((v) => [v.key, v.buttonIndex, v.subType])).toEqual([
      ['header.1', undefined, undefined],
      ['body.1', undefined, undefined],
      ['button.1.1', 1, 'url'],
      ['button.2.code', 2, 'copy_code'],
    ]);
  });

  it('detects the parameter format from the header and body', () => {
    expect(parameterFormatOf(full)).toBe('positional');
    expect(parameterFormatOf(def({ body: 'Hi {{first_name}}, welcome.' }))).toBe('named');
  });

  it('renders the text the customer sees, leaving gaps visible', () => {
    const rendered = renderTemplate(full, { 'header.1': '42' });
    expect(rendered).toEqual({
      header: 'Order 42 update',
      body: 'Hi {{1}}, thanks for your order.',
      footer: null,
    });
    expect(renderedText({ header: 'H', body: 'B', footer: 'F' })).toBe('H\n\nB\n\nF');
  });

  it('builds send components, encoding link values', () => {
    expect(
      buildSendComponents(full, {
        'header.1': '42',
        'body.1': 'Asha',
        'button.1.1': 'a b/c',
        'button.2.code': 'SAVE10',
      }),
    ).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: '42' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
      {
        type: 'button',
        subType: 'url',
        index: 1,
        parameters: [{ type: 'text', text: 'a%20b%2Fc' }],
      },
      {
        type: 'button',
        subType: 'copy_code',
        index: 2,
        parameters: [{ type: 'coupon_code', extra: { coupon_code: 'SAVE10' } }],
      },
    ]);
  });

  it('names parameters for named templates', () => {
    expect(
      buildSendComponents(def({ body: 'Hi {{first_name}}, welcome.' }), {
        'body.first_name': 'Asha',
      }),
    ).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha', parameterName: 'first_name' }] },
    ]);
  });

  it('removes the characters Meta refuses in parameters', () => {
    expect(cleanVariableValue(' a\n\nb\t   c ')).toBe('a b c');
  });
});

describe('resolveVariable', () => {
  const contact = {
    name: 'Asha Rao',
    waId: '919876543210',
    email: null,
    customFields: { plan: 'gold', age: 41 },
  };

  it('maps contact and custom fields', () => {
    expect(resolveVariable({ source: 'contact', field: 'first_name' }, contact)).toBe('Asha');
    expect(resolveVariable({ source: 'contact', field: 'name' }, contact)).toBe('Asha Rao');
    expect(resolveVariable({ source: 'contact', field: 'phone' }, contact)).toBe('+919876543210');
    expect(resolveVariable({ source: 'custom', key: 'age' }, contact)).toBe('41');
    expect(resolveVariable({ source: 'static', value: 'Hello' }, contact)).toBe('Hello');
  });

  it('leaves missing values empty, for a person to fill in', () => {
    expect(resolveVariable({ source: 'contact', field: 'email' }, contact)).toBe('');
    expect(resolveVariable({ source: 'custom', key: 'nope' }, contact)).toBe('');
    expect(resolveVariable(undefined, contact)).toBe('');
    expect(
      resolveVariable({ source: 'contact', field: 'first_name' }, { ...contact, name: null }),
    ).toBe('');
  });
});

describe("Meta's format", () => {
  const full = def({
    header: { format: 'TEXT', text: 'Order {{1}} update' },
    body: 'Hi {{1}}, your order {{2}} shipped.',
    footer: 'Thanks',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Stop' },
      { type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}' },
      { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '15550051310' },
      { type: 'COPY_CODE', example: 'SAVE10' },
    ],
  });
  const samples = {
    'header.1': '42',
    'body.1': 'Asha',
    'body.2': '860',
    'button.1.1': 'abc',
  };

  it('writes positional components the way Meta documents them', () => {
    expect(toMetaComponents(full, samples, null)).toEqual([
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Order {{1}} update',
        example: { header_text: ['42'] },
      },
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order {{2}} shipped.',
        example: { body_text: [['Asha', '860']] },
      },
      { type: 'FOOTER', text: 'Thanks' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Stop' },
          { type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}', example: ['abc'] },
          { type: 'PHONE_NUMBER', text: 'Call', phone_number: '15550051310' },
          { type: 'COPY_CODE', example: 'SAVE10' },
        ],
      },
    ]);
  });

  it('writes named examples and media handles', () => {
    expect(
      toMetaComponents(
        def({ header: { format: 'IMAGE' }, body: 'Hi {{first_name}}, welcome.' }),
        { 'body.first_name': 'Asha' },
        '4::handle',
      ),
    ).toEqual([
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::handle'] } },
      {
        type: 'BODY',
        text: 'Hi {{first_name}}, welcome.',
        example: { body_text_named_params: [{ param_name: 'first_name', example: 'Asha' }] },
      },
    ]);
  });

  it('reads back what it writes', () => {
    const parsed = fromMetaComponents(toMetaComponents(full, samples, null), 'UTILITY');
    expect(parsed).toEqual({ definition: full, samples, supported: true });
  });

  it('reads named samples', () => {
    const parsed = fromMetaComponents(
      [
        {
          type: 'BODY',
          text: 'Hi {{first_name}}, welcome.',
          example: { body_text_named_params: [{ param_name: 'first_name', example: 'Asha' }] },
        },
      ],
      'MARKETING',
    );
    expect(parsed.samples).toEqual({ 'body.first_name': 'Asha' });
  });

  it.each([
    ['an authentication template', [{ type: 'BODY', text: 'Code' }], 'AUTHENTICATION'],
    [
      'a location header',
      [
        { type: 'HEADER', format: 'LOCATION' },
        { type: 'BODY', text: 'Hi' },
      ],
      'UTILITY',
    ],
    ['a carousel', [{ type: 'BODY', text: 'Hi' }, { type: 'CAROUSEL' }], 'MARKETING'],
    [
      'an unknown button',
      [
        { type: 'BODY', text: 'Hi' },
        { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Open' }] },
      ],
      'MARKETING',
    ],
    ['no body at all', [{ type: 'HEADER', format: 'TEXT', text: 'Hi' }], 'UTILITY'],
    ['nothing usable', 'garbage', 'UTILITY'],
  ])('marks %s as unsupported', (_, raw, category) => {
    expect(fromMetaComponents(raw, category).supported).toBe(false);
  });
});
