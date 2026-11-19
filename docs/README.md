# Documentation

## For businesses using the app

- [User guide](user-guide.md): getting started, the inbox, contacts and consent, templates, campaigns, automation, flows, integrations, AI, billing, reports and privacy.

## For developers integrating with it

- [Public API guide](../infra/public-api.md): keys, sending, webhooks and their signatures, limits.
- API reference: [openapi.json](api/openapi.json) (OpenAPI 3), also served live at `<api>/v1/docs` and `<api>/v1/openapi.json`. A test keeps this file identical to what the code serves.
- [Zapier and Make](../infra/integrations-zapier-make.md).

## For operators running the platform

| Topic                                   | Document                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Install on a server or with Docker      | [README](../README.md#deploying-to-a-server)                             |
| Hosting choices, releases, migrations   | [deployment.md](../infra/deployment.md)                                  |
| Accepting a fresh environment           | [deployment.md, section 9](../infra/deployment.md#9-verify-a-deployment) |
| Load tests and their targets            | [load-testing.md](../infra/load-testing.md)                              |
| Monitoring: metrics, dashboard, alerts  | [observability/](../infra/observability/)                                |
| Runbooks                                | [runbooks/](../infra/runbooks/README.md)                                 |
| Backups and restore                     | [backup-restore.md](../infra/backup-restore.md)                          |
| Rotating secrets                        | [key-rotation.md](../infra/key-rotation.md)                              |
| Security controls and evidence          | [security-checklist.md](../infra/security-checklist.md)                  |
| Meta and WhatsApp setup                 | [whatsapp-setup.md](../infra/whatsapp-setup.md)                          |
| Platform billing (Stripe, Razorpay)     | [billing-setup.md](../infra/billing-setup.md)                            |
| Channels (Instagram, website chat, ...) | [channels.md](../infra/channels.md)                                      |
| Connectors                              | [connectors.md](../infra/connectors.md)                                  |
| Resellers and the platform console      | [reseller.md](../infra/reseller.md)                                      |
| Local development without Docker        | [native-setup.md](../infra/native-setup.md)                              |

## Demo data

For demos and screenshots, in development or staging (never production):

```sh
pnpm db:seed    # the "demo" workspace, owner@demo.test and agent@demo.test
pnpm db:demo    # a bakery's month: contacts, conversations, templates, a campaign with sales, reports
```
