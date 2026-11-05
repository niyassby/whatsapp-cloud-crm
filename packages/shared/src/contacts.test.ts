import { describe, expect, it } from 'vitest';
import {
  canReceiveMarketing,
  coerceFieldValue,
  csvCell,
  isOptOutMessage,
  parseCsvHeader,
} from './contacts';

const keywords = ['stop', 'stop promotions', 'unsubscribe'];

describe('isOptOutMessage', () => {
  it.each(['STOP', ' stop ', 'Stop!', 'stop.', 'STOP  PROMOTIONS', 'Unsubscribe'])(
    'treats %j as an opt-out',
    (text) => expect(isOptOutMessage(text, keywords)).toBe(true),
  );

  it.each(['stop by the shop', "please don't stop", 'unstoppable', '', '!!!', null, undefined])(
    'keeps consent for %j',
    (text) => expect(isOptOutMessage(text, keywords)).toBe(false),
  );

  it('uses the default list when a workspace has none', () => {
    expect(isOptOutMessage('stop', [])).toBe(true);
    expect(isOptOutMessage('halt', [])).toBe(false);
  });

  it('honours a custom list only', () => {
    expect(isOptOutMessage('band karo', ['band karo'])).toBe(true);
    expect(isOptOutMessage('stop', ['band karo'])).toBe(false);
  });
});

describe('canReceiveMarketing', () => {
  it('allows only recorded consent', () => {
    expect(canReceiveMarketing('opted_in')).toBe(true);
    expect(canReceiveMarketing('unknown')).toBe(false);
    expect(canReceiveMarketing('opted_out')).toBe(false);
  });
});

describe('coerceFieldValue', () => {
  const field = (
    type: 'text' | 'number' | 'date' | 'boolean' | 'select',
    options: string[] = [],
  ) => ({
    type,
    options,
    label: 'F',
  });

  it('converts CSV text to the field type', () => {
    expect(coerceFieldValue(field('number'), ' 42.5 ')).toEqual({ ok: true, value: 42.5 });
    expect(coerceFieldValue(field('boolean'), 'Yes')).toEqual({ ok: true, value: true });
    expect(coerceFieldValue(field('boolean'), '0')).toEqual({ ok: true, value: false });
    expect(coerceFieldValue(field('date'), '2026-02-28')).toEqual({
      ok: true,
      value: '2026-02-28',
    });
    expect(coerceFieldValue(field('select', ['a', 'b']), 'b')).toEqual({ ok: true, value: 'b' });
  });

  it.each([
    ['number', 'abc'],
    ['number', ''],
    ['date', '2026-02-31'],
    ['date', '31/01/2026'],
    ['boolean', 'maybe'],
  ] as const)('rejects %s %j', (type, raw) => {
    expect(coerceFieldValue(field(type), raw).ok).toBe(false);
  });

  it('rejects a value outside the options', () => {
    expect(coerceFieldValue(field('select', ['a']), 'z')).toMatchObject({ ok: false });
  });
});

describe('parseCsvHeader', () => {
  it('handles a BOM, quotes and escaped quotes, and stops at the first line', () => {
    expect(parseCsvHeader('﻿Phone,"Full, name","Say ""hi"""\r\n1,2,3')).toEqual([
      'Phone',
      'Full, name',
      'Say "hi"',
    ]);
  });
});

describe('csvCell', () => {
  it('quotes separators and doubles quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it.each(['=SUM(A1)', '+1+1', '-2', '@cmd'])('neutralises the formula %s', (text) => {
    expect(csvCell(text).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves numbers and empties alone', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});
