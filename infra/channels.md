# Channels and WhatsApp modules

Setup for the Phase 4.2 channels (website chat, Instagram) and WhatsApp modules (QR codes,
catalog, groups, calling, ad attribution). How they are built is in `CLAUDE.md`.

Each needs its plan feature. The defaults from the migration:

| Feature          | Plans                  | Where                              |
| ---------------- | ---------------------- | ---------------------------------- |
| `webchat`        | Starter, Growth, Scale | Settings > Channels                |
| `qr_codes`       | Starter, Growth, Scale | Settings > WhatsApp tools > QR     |
| `instagram`      | Growth, Scale          | Settings > Channels                |
| `catalog`        | Growth, Scale          | WhatsApp tools > Catalog, composer |
| `ad_attribution` | Growth, Scale          | Dashboard > Ad attribution         |
| `groups`         | Scale                  | WhatsApp tools > Groups            |
| `calling`        | Scale                  | WhatsApp tools > Calling, inbox    |

Change them per plan in `/admin` > Plans.

## Website chat

1. Settings > Channels > Add website chat.
2. Copy the embed code into the site, before `</body>`:

   ```html
   <script src="https://<api>/webchat/widget.js" data-key="wc_..." async></script>
   ```

3. Optional: Settings, to set the title, greeting, colour, and the sites allowed to embed it.

The widget is an iframe of `<web>/widget/<key>`, so the host page cannot read the chat. Visitors
are remembered in that origin's storage. There is no reply window: agents can always answer.

## Instagram

Needs an Instagram professional account and a Meta app with the Instagram product
(Instagram API with Instagram Login).

1. In the Meta app: Instagram > API setup with Instagram login. Add the redirect URL
   `<API_PUBLIC_URL>/channels/instagram/callback`, and the webhook URL
   `<API_PUBLIC_URL>/webhooks/instagram` with `META_WEBHOOK_VERIFY_TOKEN`, subscribed to
   `messages`.
2. Set `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` (the Instagram app's, not the Facebook
   app's) for the API and the worker.
3. Settings > Channels > Connect Instagram.

Replies must be within 24 hours of the customer's last message. Text and quick replies only;
lists become quick replies. Tokens are refreshed daily, ten days before they expire.

## QR codes and short links

WhatsApp tools > QR codes. Meta makes the link (`wa.me/message/...`); the app draws the QR code
from it. A chat counts as started from a code when its message is exactly the code's message.

## Catalog

Connect a catalog to the WhatsApp Business Account in Commerce Manager, then WhatsApp tools >
Catalog > Sync. Agents send products from the bag icon in the composer (inside the 24-hour
window). Orders customers place show in the conversation with their total.

## Groups

WhatsApp tools > Groups. Share the invite link; people who ask to join are approved there.
Announcements to a group are sent from the same screen. Group conversations are not in the inbox.

## Calling

1. WhatsApp tools > Calling > Calling on. Meta says it can take up to 7 days to show in every
   WhatsApp app.
2. Customer calls ring in the inbox for everyone; the first to answer takes it. Agents call a
   customer from the phone icon in a conversation, after the customer allows calls ("Ask
   permission to call").
3. Browsers need microphone permission, and the page must be on https (or localhost).

The browser carries the audio over WebRTC, with a public STUN server. Calls have not yet been
tried against Meta; behind strict corporate firewalls a TURN server may be needed.

## Ad attribution

Click-to-WhatsApp and Instagram ads need no setup: Meta adds the ad to the first message, and
Dashboard > Ad attribution groups them by ad.
