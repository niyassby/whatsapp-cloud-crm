# Backup and restore

What to back up, how, how to restore, and the drill that proves a backup works.

## What holds what

| Store                                       | What is in it                                                                         | Back up?                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| PostgreSQL                                  | Everything that matters: workspaces, contacts, messages, wallets, ledgers, audit logs | Yes: the source of truth         |
| Object storage (S3 / R2)                    | Message media, template header files, knowledge documents, import and export files    | Yes                              |
| Secrets (`.env` or the host's secret store) | `ENCRYPTION_KEY` above all: without it, every stored credential is unreadable         | Yes, separately and encrypted    |
| Redis                                       | Queues, rate-limit counters, OAuth state                                              | No: rebuilt on start (see below) |

Redis needs no backup. After a loss, schedules are re-created when the worker starts, and the
database-driven sweeps pick up what was in flight:

- `outbound-sweep` re-queues messages still `queued`.
- `flow-tick` finds due and stuck flow runs.
- `campaign-tick` finds campaigns that lost their job chain.
- `webhook-dispatch` reads the delivery outbox.
- Webhook events still `received` can be replayed.

What is lost: rate-limit windows (they start again) and OAuth sign-ins in progress (the person
tries again).

## Targets

- **RPO** (data that can be lost): 5 minutes, with continuous WAL archiving or a managed
  point-in-time restore.
- **RTO** (time to be back): 1 hour for a database restore of the sizes measured below.

## PostgreSQL

**Managed** (Neon, RDS, Cloud SQL): turn on point-in-time recovery with at least 7 days, plus a
daily snapshot kept 30 days. A restore is a new branch or instance from a timestamp.

**Self-hosted**: continuous WAL archiving with pgBackRest or WAL-G to object storage in another
region, a full backup weekly and a differential daily. Keep 30 days. Encrypt the repository. For
small installations, a nightly logical dump is the minimum:

```bash
pg_dump --format=custom --file=wacrm-$(date +%F).dump "$DIRECT_URL"
```

Copy it off the machine, encrypted, and keep 30 days.

Back up as the owner (`DIRECT_URL`): the app role cannot read message partitions directly, by
design.

## Object storage

Turn on bucket versioning, with a lifecycle rule that removes non-current versions after 30 days,
and replicate the bucket to another region (R2 and S3 both do this). Erasures and purges delete
objects; versioning keeps them for 30 days, which is how long a mistaken erasure can be undone.

## Restoring

1. Stop the worker, so nothing writes while you restore. Leave the API answering webhooks if you
   can: Meta and payment providers retry what fails.
2. Restore the database into a new instance or database:
   - managed: point-in-time restore to just before the incident;
   - self-hosted: `pgbackrest restore`;
   - a dump:

     ```bash
     pg_restore --exit-on-error --dbname="<new database>" wacrm-<date>.dump
     ```

   Restore on a server where the roles `app_user`, `app_definer` and the runtime login role already
   exist (`pnpm db:roles`); the dump keeps their grants and function owners.

3. Run `pnpm db:migrate:deploy` in case the backup predates a migration. It applies only what is
   missing.
4. Point `DATABASE_URL` and `DIRECT_URL` at the restored database. Start the API, then the worker.
5. Check:
   - `GET /health/ready` and `/admin` > System;
   - a test message both ways;
   - the latest wallet entries against Stripe and Razorpay;
   - webhook events received during the outage, replayed from Settings > WhatsApp if needed.
6. **Re-apply erasures.** A backup taken before an erasure brings the erased data back. Before
   letting people in, run every contact erasure completed after the backup time again: list them
   from the restored database's audit logs (`action = 'privacy.contact_erased'`) and the live
   database's `privacy_requests`, and erase those contacts again. Purged workspaces too: delete
   their organizations again (they cascade). Erasure is safe to repeat.

## The drill

`node infra/scripts/backup-restore-check.mjs` dumps the database in `DIRECT_URL` with `pg_dump`,
restores it into a scratch database (`wacrm_restore_check`) on the same server, and compares:

- the row count of every table, message partitions included;
- the migration history;
- row level security on every table;
- every policy;
- every definer function with its owner.

It also confirms the app role still sees nothing without a workspace in the copy. It exits 1 on any
difference. Set `PG_BIN` to the PostgreSQL `bin` folder if `pg_dump` is not on the path.

Run it monthly against a restore of the real backup (point `DIRECT_URL` at the restored copy's
server), and after any change to the backup setup. Record the result in
`infra/security-checklist.md`.

Last results on the development PC (PostgreSQL 18, 2026-11-18):

| Database                                           | Tables | Rows      | Dump          | Restore | Result |
| -------------------------------------------------- | ------ | --------- | ------------- | ------- | ------ |
| Development (`wacrm`)                              | 94     | 63        | 1.4 s         | 2.1 s   | PASS   |
| Benchmark (`wacrm_bench_test`, 5,000,000 messages) | 99     | 8,152,272 | 76 s (396 MB) | 184 s   | PASS   |
