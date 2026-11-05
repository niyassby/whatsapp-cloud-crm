/**
 * A local stand-in for Meta: accepts sends and answers the way the Graph API does, then delivers
 * signed status webhooks back to the API, so ticks and failures run the real pipeline.
 */
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { API_URL, APP_SECRET, FAILING_RECIPIENT, FAILURE_TEXT, PORTS } from './config.mjs';

/** Any id ending in 777 is a known WABA; ending in 888 a known number. */
const isWaba = (id) => id?.endsWith('777');
const isPhone = (id) => id?.endsWith('888');

const phoneInfo = (id) => ({
  id,
  display_phone_number: '+1 555 010 0888',
  verified_name: 'E2E Bakery',
  quality_rating: 'GREEN',
  messaging_limit_tier: 'TIER_1K',
  code_verification_status: 'VERIFIED',
  name_status: 'APPROVED',
  platform_type: 'CLOUD_API',
  status: 'CONNECTED',
});

const TEMPLATES = [
  {
    id: '1',
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Hi {{1}}, your order is ready.' }],
  },
];

async function postStatus(wabaId, phoneId, status) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100888', phone_number_id: phoneId },
              statuses: [{ timestamp: String(Math.floor(Date.now() / 1000)), ...status }],
            },
          },
        ],
      },
    ],
  });
  const signature = createHmac('sha256', APP_SECRET).update(body).digest('hex');
  await fetch(`${API_URL}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  }).catch((err) => console.error('status webhook failed', err));
}

function afterSend(phoneId, wamid, to, callback) {
  const common = { id: wamid, recipient_id: to, biz_opaque_callback_data: callback };
  const later = (ms, status) =>
    setTimeout(() => void postStatus('100000000000777', phoneId, { ...common, ...status }), ms);
  if (to === FAILING_RECIPIENT) {
    later(200, { status: 'failed', errors: [{ code: 131026, title: FAILURE_TEXT }] });
    return;
  }
  later(150, { status: 'delivered' });
  later(400, { status: 'read' });
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const [, , id, sub] = url.pathname.split('/');
    const raw = await readBody(req);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (isWaba(id)) {
      if (sub === 'phone_numbers') return send({ data: [phoneInfo('200000000000888')] });
      if (sub === 'subscribed_apps') return send({ success: true });
      if (sub === 'message_templates') return send({ data: TEMPLATES });
      return send({ id, name: 'E2E WABA', currency: 'INR', timezone_id: '53' });
    }
    if (isPhone(id)) {
      if (sub === 'messages') {
        const message = JSON.parse(raw.toString('utf8'));
        const wamid = `wamid.E2E.${randomUUID()}`;
        afterSend(id, wamid, message.to, message.biz_opaque_callback_data);
        return send({
          messaging_product: 'whatsapp',
          contacts: [{ input: message.to, wa_id: message.to }],
          messages: [{ id: wamid }],
        });
      }
      if (sub === 'media') return send({ id: `media-${randomUUID()}` });
      if (sub === 'register') return send({ success: true });
      return send(phoneInfo(id));
    }
    // Inbound media: metadata, then bytes. A 1x1 PNG.
    if (id?.startsWith('inbound-media')) {
      return send({
        id,
        url: `http://127.0.0.1:${PORTS.graph}/v25.0/file-${id}`,
        mime_type: 'image/png',
        sha256: 'x',
        file_size: 68,
        messaging_product: 'whatsapp',
      });
    }
    if (id?.startsWith('file-')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
    }
    send({ error: { message: 'Unknown object', code: 100 } }, 400);
  })
  .listen(PORTS.graph, '127.0.0.1', () => console.log(`fake graph on ${PORTS.graph}`));
