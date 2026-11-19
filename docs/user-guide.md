# User guide

For businesses using WhatsApp Cloud CRM: owners, admins and agents. Operators who run the platform should read the [deployment guide](../infra/deployment.md) instead.

- [Getting started](#getting-started)
- [Team and roles](#team-and-roles)
- [The inbox](#the-inbox)
- [Contacts and consent](#contacts-and-consent)
- [Templates](#templates)
- [Campaigns and drips](#campaigns-and-drips)
- [Automation: auto-replies, assignment and SLAs](#automation)
- [Flows](#flows)
- [Integrations](#integrations)
- [AI assistant](#ai-assistant)
- [Other channels and WhatsApp tools](#other-channels-and-whatsapp-tools)
- [Wallet, plans and invoices](#wallet-plans-and-invoices)
- [Reports](#reports)
- [Privacy and data](#privacy-and-data)
- [Developers: API keys and webhooks](#developers)
- [Partners (resellers)](#partners)
- [Common questions](#common-questions)

## Getting started

1. **Sign up** with your name, work email, a password and your business name. You start on a 14-day trial of the Growth plan. Confirm your email from the link we send.
2. **Connect your WhatsApp number** in Settings > WhatsApp > Connect with Facebook. Meta's window asks you to choose or create a WhatsApp Business Account and a phone number, and to verify it. When it closes, the number shows as Connected. A number can be live in one workspace at a time.
3. **Add money to your wallet** (Wallet > Add funds) if you will send templates. Replies inside the 24-hour window are free.
4. **Invite your team** in Settings > Team.
5. Messages sent to your number now appear in the **Inbox**.

Turn on two-factor authentication for every owner and admin in Settings > Security.

## Team and roles

| Role  | Can                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------- |
| Owner | Everything, including billing, deleting the workspace and privacy requests                        |
| Admin | Everything except billing and deleting the workspace; manages agents and other admins, not owners |
| Agent | The inbox, contacts (single records), templates to read, calls                                    |

Invitations expire after 7 days. A workspace always keeps at least one owner. Removing someone ends their sessions at once. Settings > Audit log records who changed what.

## The inbox

- Conversations are listed by latest message. Filter by **Mine**, **Unassigned**, open or closed, and by label.
- **The 24-hour window**: WhatsApp lets you send free-form messages only within 24 hours of the customer's last message. After that, the composer offers approved templates only. The timer is shown in the conversation.
- **Assign** a conversation to yourself or (admins) to someone else. **Close** it when done; a new message from the customer reopens it.
- **Internal notes** are seen by your team only, never by the customer.
- **Canned replies**: type `/` in the composer. Admins manage them in Settings > Inbox, with labels.
- **Attachments**: images, video, audio and documents, within WhatsApp's size limits.
- **Ticks**: one tick sent, two delivered, blue read. A red mark means it failed; hover for the reason.
- Everyone sees new messages live. **Live** in the header means you are connected; if it says otherwise, check your internet.

## Contacts and consent

- Contacts are created when someone writes in, or added by hand, by import (CSV up to 50 MB) or by the API.
- **Tags** describe people (VIP, Wholesale); **labels** describe conversations (Order, Complaint).
- **Custom fields** (Settings > Contacts) hold anything else: a city, a customer id, a birthday.
- **Segments** are saved filters, used for campaigns.
- **Marketing consent**: WhatsApp requires that people agree before you send them marketing. A contact's consent is shown on their page. Record opt-in with where it came from and your proof. Imports can record consent for a whole file you have proof for.
- **Opt-out**: when a customer sends STOP (or another keyword you set in Settings > Contacts), they are opted out at once and receive no broadcasts. You can still reply to them.
- **Merge** duplicates from the contacts list; an opt-out on either contact wins.

## Templates

Templates are messages Meta approves in advance; they are the only way to start a conversation or write after 24 hours.

1. Templates > New template. Choose **Marketing** (offers, news) or **Utility** (order updates, reminders).
2. Write the body with variables like `{{1}}`, add a header, footer and buttons if you like, and give a sample for each variable. The preview shows what customers will see.
3. **Submit**. Meta usually decides within minutes; the status updates on its own.
4. **Variable sources** fill variables automatically, for example `{{1}}` from the contact's first name.

Rejected templates show Meta's reason; edit and submit again. Templates made in Meta's own tools appear here too after a sync.

## Campaigns and drips

**A campaign** sends one template to many people:

1. Campaigns > New campaign: name, number, approved template, and the audience (a segment, everyone, or a CSV file).
2. **Review** shows who will receive it, who is skipped and why (opted out, no consent for marketing, a missing variable), and the cost. Nothing is sent yet.
3. **Start** now or schedule it. The money for it is set aside from your wallet when it starts.
4. Watch it live: sent, delivered, read, replied, failed, cost and sales.

Campaigns respect your number's daily limit from Meta, and pause on their own if quality drops, too many sends fail, the template is paused, or the wallet runs out. Resume them from the campaign page. Threads a broadcast starts stay out of your inbox until the customer replies.

**Drips** (Campaigns > Drips) send a sequence of templates with delays, for example a welcome series. People leave a drip when they reply, get a tag, or opt out.

## Automation

Settings > Automation (owners and admins):

- **Welcome message** for a customer's first message, and an **away message** outside your **business hours**.
- **Keyword auto-replies**: exact, contains, or a pattern; the first matching rule by priority answers.
- **Assignment**: rules by tag, number or keyword, and a default of round robin or least busy among available agents. Agents set themselves available or away in the account menu.
- **SLA**: if a customer waits longer than your target for a first reply, the assignee is notified, then owners and admins, and the conversation can be reassigned.

No automatic message goes to someone who opted out, and at most three automatic replies per conversation per hour.

## Flows

Flows (Starter plan and up) are chatbots you draw.

1. Flows > New flow. Choose a **trigger**: a keyword, a new contact, a template button, an ad, a tag, a store or payment event, or started by hand.
2. Add **steps**: messages, buttons and lists, questions (saved into variables), conditions, delays, tags, assign or hand over to a person, HTTP requests, integration actions, AI answers.
3. Connect each step's exits from the side panel ("Then") or by dragging.
4. **Test** runs the flow in the panel with you as the customer. Nothing is sent.
5. **Publish**. Edits after that are drafts until you publish again; running conversations keep the version they started on.

The Runs tab shows each conversation's path and variables, and lets you stop a run.

## Integrations

Integrations (Growth plan and up) connect stores and tools. Each sends events that start flows, and offers actions flows can use.

| App                    | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Shopify, WooCommerce   | Order created, paid, fulfilled, cancelled; abandoned checkouts; consent at checkout |
| Custom store           | Your own site sends signed JSON events                                              |
| Razorpay, Stripe       | Payment links in chat; paid, failed and expired events                              |
| Google Sheets, HubSpot | Add rows, look up rows; create or update contacts, add notes                        |
| Zapier, Make           | Through the public API ("Developers" below)                                         |

The connection page shows health, a log of every event with Try again, and asks you to reconnect when a provider revokes access.

## AI assistant

Settings > AI assistant (Growth and up):

- Add **knowledge**: text, or .txt, .md, .csv and .json files. Test what it finds with the search box.
- In the inbox, the sparkles menu **suggests a reply** from your knowledge, **summarises** a conversation, or **rewrites** your draft in another tone. Nothing is sent without you.
- In flows, an **AI answer** step replies only when automatic replies are switched on, the answer is confident enough, and the 24-hour window is open; otherwise it hands over to a person with the draft as a note.

AI usage is charged from the wallet by the amount of text processed. The activity log lists every call.

## Other channels and WhatsApp tools

- **Instagram** messages and **website chat** (a widget you paste into your site) share the same inbox (Settings > Channels).
- WhatsApp tools (Settings > WhatsApp tools): **QR codes** that open a chat with a ready message and count scans; your **catalog** for sending products; **groups**; **calling**, answered in the browser.
- **Ad attribution** (Dashboard > Ad attribution) shows which click-to-WhatsApp ads brought conversations and sales.

## Wallet, plans and invoices

- The **wallet** pays for template messages (at Meta's rates for the recipient's country, as listed on the wallet page), and for AI. Replies inside 24 hours are free and keep working at zero balance.
- **Add funds** by card or UPI; tax is added on top. You get an alert when the balance falls below your threshold.
- **Plans** (Settings > Billing) set limits on seats, numbers and contacts, and which features you have. Upgrade, switch or cancel there; a cancelled plan runs to the end of its period. Nothing is deleted if you move to a smaller plan; you just cannot add more.
- **Invoices** for every payment are in Settings > Billing, as PDF.
- If a partner manages your workspace, they handle your plan and wallet.

## Reports

Reports (Starter and up) cover conversations, your team, campaigns (with ROI), templates and ads, for any dates up to a year. Download CSV or PDF, or schedule a daily, weekly or monthly email to owners and admins. Figures can be up to five minutes behind.

The **Dashboard** gives the last 7 or 30 days at a glance.

## Privacy and data

- **A customer asks for their data**: their contact page > Privacy > Export. You get a file to send them.
- **A customer asks to be forgotten**: Privacy > Erase. Their messages, files, notes and details are removed. Their number is kept only as a code so a future import cannot add them back, and they stay opted out. This cannot be undone.
- **Message retention** (Settings > Privacy, owners): remove message text and files older than a number of days you choose.
- **Export the workspace**: everything, as files, from Settings > Privacy.
- **Delete the workspace**: owners, from Settings > Privacy. It is deleted after 14 days, and you can cancel until then.

## Developers

- **API keys** (Settings > API keys): choose the permissions each key has. The key is shown once.
- **Webhooks** (Settings > Webhooks): we POST events (message received, message status, contact created, and more) to your HTTPS address, signed with a secret. Every delivery and retry is logged, and can be replayed.
- Reference and examples: [public API guide](../infra/public-api.md), the live reference at `<api>/v1/docs`, and the OpenAPI file [docs/api/openapi.json](api/openapi.json).
- Zapier and Make: [integrations-zapier-make.md](../infra/integrations-zapier-make.md).

## Partners

Partners manage client workspaces from the Partner console: create clients, set their plan and caps, add wallet credit, set a markup on message prices, and see monthly statements. A partner can open a client's workspace for 30 minutes at a time, with a reason the client sees in its audit log. More: [reseller.md](../infra/reseller.md).

## Common questions

**I can't type a message.** The 24-hour window has closed. Send an approved template; when the customer replies, the window opens again.

**A campaign skipped people.** The review lists why: opted out, no recorded consent (marketing only), or a missing variable value.

**A campaign paused on its own.** The campaign page says why: the wallet, the number's quality, failures, or the template. Fix it and Resume.

**Messages show a red mark.** Hover for Meta's reason. Common ones: the number is not on WhatsApp, the window closed, or Meta is limiting a new number.

**Someone left the company.** Remove them in Settings > Team. Their sessions end at once and their conversations become unassigned.
