# Deploys and rollback

How releases go out without downtime, and what to do when one goes wrong. The full procedure is in `infra/deployment.md` (Updating and zero-downtime migrations).

## Order of a release

1. Back up (or confirm last night's backup and PITR are healthy).
2. `migrate deploy` with the new release's tools image or checkout, **before** any new code runs. Migrations must be backward compatible with the running release (expand first, contract in a later release).
3. Roll the API instances one at a time (the load balancer drains each), then the worker, then the web app.
4. Watch the dashboard for 15 minutes: 5xx, latency, jobs failing.

## Roll back the code

Code is stateless; the previous release runs against the new schema because migrations are expand-only.

- systemd: switch the `current` symlink back to the previous release directory and restart `wacrm-api`, `wacrm-worker` and `wacrm-web`.
- Docker: set the previous image tag in the environment (`WACRM_TAG`) and `docker compose up -d`.
- Do not roll back the web app alone if the release changed an API response the web uses; roll back all three.

## Roll back a migration

Prisma has no down migrations, and you rarely want one: a rollback deletes data written since. Instead:

1. Leave the schema as it is and roll back only the code (above). Expand-only migrations make this safe.
2. If the migration itself is wrong (a bad index, a broken constraint), write a new forward migration that fixes it and release it.
3. If a migration failed halfway, Prisma marks it failed and refuses to continue. Look at what it applied (`\d` the tables it touches). Then either finish it by hand and `prisma migrate resolve --applied <name>`, or undo what it did by hand and `prisma migrate resolve --rolled-back <name>`, and deploy a corrected migration.
4. Last resort, data damaged: restore to a point in time before the release (`infra/backup-restore.md`). Everything written since is lost, including customers' messages: weigh that before choosing it.

## Things that are not safe to roll back

- A changed `ENCRYPTION_KEY` or JWT secret: follow `infra/key-rotation.md` instead.
- A release that ran a data migration the old code cannot read. The release notes must say so; the zero-downtime rules in `infra/deployment.md` forbid it within one release.
