/**
 * Meta webhook payloads. All ids, numbers, names and text are fake.
 *
 * Structure captured from live traffic on 2026-11-05 (Graph v25.0): `inboundText`, `statusRead`,
 * `statusSentTemplate`, `accountWebhookConfig`.
 * Still written from Meta's docs, because no live event of the kind has arrived yet: everything
 * else in this file. Replace those from `webhook_events.payload` when they do, masking personal data.
 */
export const WABA_ID = '100000000000001';
export const PHONE_ID = '200000000000001';

export const inboundText = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
            contacts: [
              { profile: { name: 'Asha' }, wa_id: '919800000001', user_id: 'IN.0000000000000001' },
            ],
            messages: [
              {
                from: '919800000001',
                from_user_id: 'IN.0000000000000001',
                id: 'wamid.INBOUND1',
                timestamp: '1793800000',
                type: 'text',
                text: { body: 'Hello there' },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** A free-form reply inside the service window; carries the callback data we set when sending. */
export const statusRead = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
            contacts: [{ wa_id: '919800000001', user_id: 'IN.0000000000000001' }],
            statuses: [
              {
                id: 'wamid.OUT2',
                status: 'read',
                timestamp: '1793800003',
                recipient_id: '919800000001',
                recipient_user_id: 'IN.0000000000000001',
                biz_opaque_callback_data: 'msg-456',
                pricing: {
                  billable: false,
                  pricing_model: 'PMP',
                  category: 'service',
                  type: 'free_customer_service',
                  subtype: 'free_tier',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** A message sent outside this app (Meta's API test page): no callback data, billed as utility. */
export const statusSentTemplate = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
            contacts: [{ wa_id: '919800000001', user_id: 'IN.0000000000000001' }],
            statuses: [
              {
                id: 'wamid.OUT3',
                status: 'sent',
                timestamp: '1793800004',
                recipient_id: '919800000001',
                recipient_user_id: 'IN.0000000000000001',
                pricing: {
                  billable: true,
                  pricing_model: 'PMP',
                  category: 'utility',
                  type: 'regular',
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

/** Sent when the app's webhook subscription changes. Has no phone number metadata. */
export const accountWebhookConfig = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      time: 1793800005,
      changes: [
        {
          field: 'account_update',
          value: {
            event: 'WEBHOOK_CONFIG_UPDATED',
            event_time: '2026-11-05T09:00:48+0000',
            actor: { business_id: '300000000000001' },
            details: { change_action: 'subscribe' },
          },
        },
      ],
    },
  ],
};

export const inboundImage = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
            contacts: [{ profile: { name: 'Asha' }, wa_id: '919800000001' }],
            messages: [
              {
                from: '919800000001',
                id: 'wamid.INBOUND2',
                timestamp: '1793800001',
                type: 'image',
                image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'Pic' },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const statusFailed = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_ID },
            statuses: [
              {
                id: 'wamid.OUT1',
                status: 'failed',
                timestamp: '1793800002',
                recipient_id: '919800000001',
                biz_opaque_callback_data: 'msg-123',
                errors: [{ code: 131047, title: 'Re-engagement message' }],
              },
            ],
          },
        },
      ],
    },
  ],
};

export const templateStatus = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'message_template_status_update',
          value: {
            event: 'APPROVED',
            message_template_id: 555,
            message_template_name: 'welcome',
            message_template_language: 'en_US',
            reason: 'NONE',
          },
        },
      ],
    },
  ],
};

export const qualityUpdate = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'phone_number_quality_update',
          value: {
            display_phone_number: '15550001111',
            event: 'UPGRADE',
            current_limit: 'TIER_2K',
          },
        },
      ],
    },
  ],
};

/** A batched delivery across two WABAs (two tenants), three changes in total. */
export const multiTenantDelivery = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field: 'messages',
          value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ id: 'wamid.A1' }] },
        },
        {
          field: 'messages',
          value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ id: 'wamid.A2' }] },
        },
      ],
    },
    {
      id: '100000000000002',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '200000000000002' },
            messages: [{ id: 'wamid.B1' }],
          },
        },
      ],
    },
  ],
};

export const graphError = (code: number, status = 400, message = 'Graph error') => ({
  status,
  body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'trace-1' } },
});
