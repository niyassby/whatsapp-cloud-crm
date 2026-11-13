import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_FEATURE,
  webchatConfigSchema,
  webchatMessageSchema,
} from './channels';
import { createQrCodeSchema, orderTotal, sendProductsSchema } from './wa-modules';

describe('channel capabilities', () => {
  it('keeps templates, files, products and calls to WhatsApp', () => {
    expect(CHANNEL_CAPABILITIES.whatsapp).toMatchObject({
      templates: true,
      media: true,
      products: true,
      calls: true,
    });
    for (const kind of ['instagram', 'webchat'] as const) {
      expect(CHANNEL_CAPABILITIES[kind]).toMatchObject({
        templates: false,
        products: false,
        calls: false,
      });
    }
  });

  it('gives website chat no reply window, and Instagram 24 hours', () => {
    expect(CHANNEL_CAPABILITIES.webchat.replyWindowHours).toBeNull();
    expect(CHANNEL_CAPABILITIES.instagram.replyWindowHours).toBe(24);
  });

  it('names the plan feature of each non-WhatsApp channel', () => {
    expect(CHANNEL_FEATURE).toEqual({ whatsapp: null, instagram: 'instagram', webchat: 'webchat' });
  });
});

describe('website chat input', () => {
  it('takes site addresses only, without a trailing slash', () => {
    expect(
      webchatConfigSchema.parse({ allowedOrigins: ['https://shop.example/'] }).allowedOrigins,
    ).toEqual(['https://shop.example']);
    expect(
      webchatConfigSchema.safeParse({ allowedOrigins: ['https://shop.example/page'] }).success,
    ).toBe(false);
    expect(webchatConfigSchema.safeParse({ allowedOrigins: ['javascript:alert(1)'] }).success).toBe(
      false,
    );
  });

  it('fills defaults for a new widget', () => {
    expect(webchatConfigSchema.parse({})).toMatchObject({
      title: 'Chat with us',
      askDetails: false,
      allowedOrigins: [],
    });
  });

  it('refuses an empty message and needs a client id', () => {
    const base = { token: 'abcdefghij.k', clientMessageId: crypto.randomUUID() };
    expect(webchatMessageSchema.safeParse({ ...base, body: '   ' }).success).toBe(false);
    expect(webchatMessageSchema.safeParse({ token: base.token, body: 'hi' }).success).toBe(false);
    expect(webchatMessageSchema.safeParse({ ...base, body: 'hi' }).success).toBe(true);
  });
});

describe('WhatsApp modules input', () => {
  it('limits a QR code message to Meta’s 140 characters', () => {
    const base = { phoneId: crypto.randomUUID(), name: 'Counter' };
    expect(
      createQrCodeSchema.safeParse({ ...base, prefilledMessage: 'x'.repeat(140) }).success,
    ).toBe(true);
    expect(
      createQrCodeSchema.safeParse({ ...base, prefilledMessage: 'x'.repeat(141) }).success,
    ).toBe(false);
  });

  it('allows at most 30 products across sections', () => {
    const list = (n: number) => ({
      kind: 'product_list' as const,
      clientMessageId: crypto.randomUUID(),
      header: 'H',
      body: 'B',
      sections: [
        { title: 'A', retailerIds: Array.from({ length: n }, (_, i) => `a${i}`) },
        { title: 'B', retailerIds: ['b1'] },
      ],
    });
    expect(sendProductsSchema.safeParse(list(29)).success).toBe(true);
    expect(sendProductsSchema.safeParse(list(30)).success).toBe(false);
  });

  it('adds up an order without float drift', () => {
    expect(
      orderTotal({
        product_items: [
          { product_retailer_id: 'a', quantity: 3, item_price: 0.1, currency: 'INR' },
          { product_retailer_id: 'b', quantity: 1, item_price: 0.2, currency: 'INR' },
        ],
      }),
    ).toEqual({ total: 0.5, currency: 'INR' });
    expect(orderTotal({})).toEqual({ total: 0, currency: null });
  });
});
