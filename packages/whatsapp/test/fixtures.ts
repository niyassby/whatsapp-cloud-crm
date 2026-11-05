/**
 * Meta webhook and Graph payloads, written from Meta's documented shapes.
 * NOT yet captured from live traffic: replace with recorded payloads once a real number is
 * connected (copy `webhook_events.payload` rows). IDs are fake.
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
            contacts: [{ profile: { name: 'Asha' }, wa_id: '919800000001' }],
            messages: [
              {
                from: '919800000001',
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
