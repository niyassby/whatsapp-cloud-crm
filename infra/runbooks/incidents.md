# Running an incident

## Severity

| Level | Meaning                                                                        | Response                         |
| ----- | ------------------------------------------------------------------------------ | -------------------------------- |
| SEV1  | Messages not sent or received for many workspaces; data exposed across tenants | Page, all hands, status page now |
| SEV2  | One feature down for many (campaigns, billing, a channel), or one big customer | Page in working hours            |
| SEV3  | Degraded, workaround exists                                                    | Ticket                           |

Any suspected cross-tenant data exposure is SEV1, whatever its size.

## Roles

One person leads and decides; one person fixes; one person talks to customers. On a small team the lead also writes the notes.

## During

1. Open a note with a timeline (UTC times): what was seen, what was done, by whom.
2. Post on the status page within 15 minutes for SEV1 and SEV2, and every 30 minutes after.
3. Prefer actions that can be undone: restart, roll back code, scale out. Avoid touching data by hand.
4. Keep evidence: logs, failed job ids, webhook event ids. Logs never contain tokens or message text from customers by design; do not paste message contents into the incident channel.

## Security incidents

- Rotate what may have leaked first (`infra/key-rotation.md`): JWT secrets end every session, `ENCRYPTION_KEY` needs re-encryption, Meta and provider secrets in their dashboards.
- Every action by staff in a workspace is in its audit log, and impersonation sessions in `impersonation_sessions` with their reasons. `GET /admin/audit` has the platform's own log.
- Personal data breach: India's DPDP Act and the GDPR require notifying the authority and the affected people without delay (GDPR: within 72 hours of becoming aware). Involve whoever owns legal before notifying.

## After

Write a short review within a week: what happened, impact (workspaces, messages, money), why, what changed so it does not repeat. Blame the system, not people. Add or fix the alert or runbook that would have caught it earlier.
