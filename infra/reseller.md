# Resellers and the platform console

How to run the reseller side of the product. For how it is built, see "Resellers and the platform
console" in `CLAUDE.md`.

## Who is who

| Role           | Sees                                                   | Where      |
| -------------- | ------------------------------------------------------ | ---------- |
| Platform admin | Every partner and workspace, plans, prices, the system | `/admin`   |
| Partner staff  | Their partner's client workspaces, ledger, statements  | `/partner` |
| Client members | Their own workspace only                               | the app    |

Partner staff and platform admins are not members of client workspaces. They look inside one by
"View workspace", which asks for a reason, lasts 30 minutes, shows a banner, and is recorded in
that workspace's audit log.

## First-time setup

1. Sign up as usual with the account that will run the platform.
2. Make it a platform admin. This is the only way, on purpose:

   ```
   pnpm admin:grant you@example.com
   pnpm admin:grant you@example.com --revoke    # to take it away
   ```

   It needs `DIRECT_URL` to be a login that can read every user (the owner as a superuser, as in
   development). Reload the app: "Platform admin" appears in the account menu.

3. In `/admin` > Plans, set a **wholesale price** for each plan you sell to partners, in each
   partner currency. A plan with no wholesale price in a partner's currency is not offered to it.
4. In `/admin` > Rate cards, make sure message rates (and `ai_input`, `ai_output`, `ai_embedding`
   if AI is on) exist in that currency. These are the wholesale rates.

## Adding a partner

1. The person who will run the partner signs up for an ordinary account.
2. `/admin` > Partners > New partner: name, currency (fixed afterwards), an optional limit on
   client workspaces, and that person's email. More staff are added from the Staff menu.
3. They reload the app and find "Partner console" in the account menu.

## What a partner does

- **Markup**: a percentage added to every wallet charge (messages and AI) of its clients. It
  applies to charges from then on.
- **New client**: a workspace name, the owner's email, a plan, optional limits below the plan's,
  and optionally what the partner charges the client a month (only used to show the margin). The
  owner gets an invitation by email.
- **Add funds**: after collecting from the client, the partner credits the client's wallet. The
  client spends it at the partner's prices.
- **Suspend / Restore / Delete**: suspending shuts the client's team, API keys and live
  connections out at once and deletes nothing. Deleting disconnects its numbers and frees the
  partner's slot; history is kept.

A client of a partner cannot buy a plan or top up by itself. Its billing page says who manages it.

## Money

The platform does not collect from a partner's clients. For each client charge it records:

- **wholesale**: the rate card price, which the partner owes the platform
- **client price**: wholesale plus the markup, taken from the client's wallet
- **margin**: the difference, which the partner keeps

A refunded send reverses all three. Each month also adds one plan fee per client: the plan's
wholesale price (owed), and the partner's own client price (for the margin).

The worker closes the previous month for every partner once a day (01:30 UTC, job
`partner-statements`); a statement is created once and never changed. To close one by hand:

```
POST /admin/partners/<partner id>/statements/close   { "period": "2026-10" }
```

Invoice the partner for the statement's "Total due" outside the system, then record the payment
in `/admin` > Statements with its reference.

## Things to know

- A partner has no credit limit yet. Watch unpaid statements, and suspend a partner's console
  access from `/admin` > Partners if needed (its clients keep working; suspend those separately).
- Statement amounts are before tax. Add tax on your invoice as your accountant advises.
- Plan fees are for a whole month, with no proration for a client added or removed mid-month.
- White-label, custom domains and branded emails are not part of this.
