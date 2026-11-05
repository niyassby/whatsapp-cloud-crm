import { describe, expect, it } from 'vitest';
import { parseSignupMessage } from './facebook';

const FB = 'https://www.facebook.com';
const message = (event: string, data: object = {}) =>
  JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data });

describe('parseSignupMessage', () => {
  it('reads the ids from a finish event', () => {
    expect(
      parseSignupMessage(FB, message('FINISH', { waba_id: '111', phone_number_id: '222' })),
    ).toEqual({ kind: 'finish', wabaId: '111', phoneNumberId: '222' });
  });

  it('accepts other facebook.com subdomains', () => {
    const msg = message('FINISH', { waba_id: '1', phone_number_id: '2' });
    expect(parseSignupMessage('https://web.facebook.com', msg)?.kind).toBe('finish');
  });

  it.each([
    'https://evil.example',
    'https://facebook.com.evil.example',
    'https://notfacebook.com',
    'not a url',
  ])('ignores messages from %s', (origin) => {
    const msg = message('FINISH', { waba_id: '1', phone_number_id: '2' });
    expect(parseSignupMessage(origin, msg)).toBeNull();
  });

  it('reports cancel and error', () => {
    expect(parseSignupMessage(FB, message('CANCEL', { current_step: 'PHONE' }))).toEqual({
      kind: 'cancel',
      step: 'PHONE',
    });
    expect(parseSignupMessage(FB, message('ERROR', { error_message: 'Nope' }))).toEqual({
      kind: 'error',
      message: 'Nope',
    });
  });

  it('treats a finish without a number as an error', () => {
    expect(parseSignupMessage(FB, message('FINISH_ONLY_WABA', { waba_id: '1' }))?.kind).toBe(
      'error',
    );
  });

  it('ignores unrelated traffic', () => {
    expect(parseSignupMessage(FB, 'not json')).toBeNull();
    expect(parseSignupMessage(FB, { type: 'WA_EMBEDDED_SIGNUP' })).toBeNull();
    expect(parseSignupMessage(FB, JSON.stringify({ type: 'OTHER' }))).toBeNull();
  });
});
