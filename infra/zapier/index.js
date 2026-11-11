/* global module */
/**
 * Sample Zapier app (Zapier Platform CLI, zapier-platform-core 15+) for the WhatsApp CRM public API.
 * A starting point for publishing: copy this folder out, `npm i zapier-platform-core`, set
 * BASE_URL, `zapier push`. Not part of the build. Guide: infra/integrations-zapier-make.md.
 *
 * Auth: an API key with the scopes the app uses (hooks:manage for triggers, plus messages:send,
 * contacts:write, tags:write for actions). Triggers are REST hooks: turning a Zap on subscribes
 * through POST /v1/hooks, turning it off unsubscribes; samples come from /v1/hooks/samples.
 */
const BASE_URL = 'https://api.example.com';

const EVENTS = {
  message_received: { event: 'message.received', label: 'New Incoming Message' },
  message_status: { event: 'message.status', label: 'Message Status Changed' },
  contact_created: { event: 'contact.created', label: 'New Contact' },
  contact_opted_out: { event: 'contact.opted_out', label: 'Contact Opted Out' },
  campaign_completed: { event: 'campaign.completed', label: 'Campaign Completed' },
  template_status_changed: { event: 'template.status_changed', label: 'Template Status Changed' },
};

const authentication = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API key',
      required: true,
      type: 'password',
      helpText: 'Settings > API keys. Give it "Subscribe to events" and the actions you use.',
    },
  ],
  // Any call the key may make proves it works; listing subscriptions is cheap.
  test: { url: `${BASE_URL}/v1/hooks` },
  connectionLabel: 'WhatsApp CRM',
};

const addAuth = (request, _z, bundle) => {
  request.headers = { ...request.headers, Authorization: `Bearer ${bundle.authData.apiKey}` };
  return request;
};

/** One REST-hook trigger per event. The body Zapier receives is { id, type, createdAt, data }. */
function hookTrigger(key, { event, label }) {
  return {
    key,
    noun: 'Event',
    display: { label, description: `Triggers when: ${event}.` },
    operation: {
      type: 'hook',
      performSubscribe: async (z, bundle) => {
        const res = await z.request({
          method: 'POST',
          url: `${BASE_URL}/v1/hooks`,
          body: { url: bundle.targetUrl, event },
        });
        return res.data;
      },
      performUnsubscribe: async (z, bundle) => {
        await z.request({
          method: 'DELETE',
          url: `${BASE_URL}/v1/hooks/${bundle.subscribeData.id}`,
        });
        return {};
      },
      // Flatten the envelope so fields map directly; the event id is the dedupe key.
      perform: (z, bundle) => [{ ...bundle.cleanedRequest.data, id: bundle.cleanedRequest.id }],
      performList: async (z) => {
        const res = await z.request({ url: `${BASE_URL}/v1/hooks/samples/${event}` });
        return res.data.map((e) => ({ ...e.data, id: e.id }));
      },
    },
  };
}

const triggers = Object.fromEntries(
  Object.entries(EVENTS).map(([key, spec]) => [key, hookTrigger(key, spec)]),
);

const sendTemplate = {
  key: 'send_template',
  noun: 'Message',
  display: {
    label: 'Send Template Message',
    description: 'Sends an approved template to a phone number. Works outside the 24-hour window.',
  },
  operation: {
    inputFields: [
      { key: 'to', label: 'Phone number', required: true, helpText: 'With country code' },
      { key: 'templateId', label: 'Template id', required: true },
      {
        key: 'variables',
        label: 'Variables',
        dict: true,
        helpText: 'Keys such as body.1, header.1, button.0.1',
      },
      {
        key: 'idempotencyKey',
        label: 'Idempotency key',
        helpText: 'Optional. The same key never sends twice.',
      },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/messages`,
        body: {
          to: bundle.inputData.to,
          type: 'template',
          templateId: bundle.inputData.templateId,
          variables: bundle.inputData.variables || {},
          ...(bundle.inputData.idempotencyKey
            ? { idempotencyKey: bundle.inputData.idempotencyKey }
            : {}),
        },
      });
      return res.data;
    },
    sample: { id: '0193b3c2-0000-7000-8000-000000000001', status: 'queued', type: 'template' },
  },
};

const sendText = {
  key: 'send_text',
  noun: 'Message',
  display: {
    label: 'Send Text Message',
    description: 'Free-form text. Only within 24 hours of the customer’s last message.',
  },
  operation: {
    inputFields: [
      { key: 'to', label: 'Phone number', required: true },
      { key: 'text', label: 'Text', required: true, type: 'text' },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/messages`,
        body: { to: bundle.inputData.to, type: 'text', body: bundle.inputData.text },
      });
      return res.data;
    },
    sample: { id: '0193b3c2-0000-7000-8000-000000000002', status: 'queued', type: 'text' },
  },
};

const createContact = {
  key: 'create_contact',
  noun: 'Contact',
  display: { label: 'Create Contact', description: 'Adds a contact. Consent is not recorded.' },
  operation: {
    inputFields: [
      { key: 'phone', label: 'Phone number', required: true },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        method: 'POST',
        url: `${BASE_URL}/v1/contacts`,
        body: {
          phone: bundle.inputData.phone,
          ...(bundle.inputData.name ? { name: bundle.inputData.name } : {}),
          ...(bundle.inputData.email ? { email: bundle.inputData.email } : {}),
        },
      });
      return res.data;
    },
    sample: { id: '0193b3c2-0000-7000-8000-000000000003', waId: '919800000000', name: 'Asha' },
  },
};

module.exports = {
  version: '0.1.0',
  platformVersion: '15.0.0',
  authentication,
  beforeRequest: [addAuth],
  triggers,
  creates: {
    [sendTemplate.key]: sendTemplate,
    [sendText.key]: sendText,
    [createContact.key]: createContact,
  },
};
