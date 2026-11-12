# Running the local services without Docker (Windows)

Docker Desktop needs several GB of memory. Everything the project needs also runs natively, in
about 200 MB, on the same ports, so `.env` does not change.

| Service                | Port                        | How it runs                                                                             |
| ---------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| PostgreSQL 16 or later | 5433                        | Windows service, installed once (below)                                                 |
| Redis                  | 6379                        | Windows service: [Memurai](https://www.memurai.com/) (Redis-compatible), installed once |
| SeaweedFS (S3)         | 9000                        | `pnpm services:up`, from `.tools/seaweedfs/weed.exe`                                    |
| Mailpit (SMTP, inbox)  | 1025, http://localhost:8025 | `pnpm services:up`, from `.tools/mailpit/mailpit.exe`                                   |

```
pnpm services:up       # start SeaweedFS and Mailpit, then check all four
pnpm services:status   # check all four answer
pnpm services:down     # stop SeaweedFS and Mailpit (Postgres and Redis keep running as services)
```

Data and logs are in `.tools/data` and `.tools/logs` (not committed). Start `services:up` again
after a restart; Postgres and Memurai start with Windows on their own.

## 1. PostgreSQL 16 or later (once)

1. Download the Windows installer for PostgreSQL 16 or later (18 is used on the development PC) from
   https://www.enterprisedb.com/downloads/postgres-postgresql-downloads.
2. Run it. Keep the defaults, except:
   - **Port: 5433.** Port 5432 is taken by the Postgres that comes with Odoo, which stays as it is.
   - Choose your own password for the `postgres` superuser and keep it to yourself.
   - Stack Builder at the end is not needed.
3. Create the project's database account, the same one Docker used. In PowerShell (it asks for
   the `postgres` password you chose):

   ```
   & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -c "CREATE ROLE wacrm LOGIN SUPERUSER PASSWORD 'wacrm';" -c "CREATE DATABASE wacrm OWNER wacrm;"
   ```

   `wacrm` / `wacrm` is the local development login already in `.env.example`; it only accepts
   connections from this computer, as the installer sets up.

4. Create the tables, the app's login role and the demo data:

   ```
   pnpm db:setup
   ```

Memory: Postgres idles at about 50 to 100 MB. To make it smaller still, set
`shared_buffers = 64MB` in `C:\Program Files\PostgreSQL\16\data\postgresql.conf` and restart the
`postgresql-x64-<version>` service.

**pgvector** (the AI knowledge base, from phase 3.7) does not come with the Windows installer.
Build it from the official source with Visual Studio 2022 (the "Desktop development with C++"
workload), in an "x64 Native Tools Command Prompt for VS 2022" opened as administrator:

```bat
git clone --branch v0.8.7 https://github.com/pgvector/pgvector.git
cd pgvector
set "PGROOT=C:\Program Files\PostgreSQL\18"
nmake /F Makefile.win
nmake /F Makefile.win install
```

The migrations run `CREATE EXTENSION IF NOT EXISTS vector`; check with
`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`. After a PostgreSQL
major upgrade, build it again against the new version. Hosted Postgres (Neon, RDS) offers
pgvector as an extension to enable.

## 2. Redis (once)

Memurai Developer is a Windows-native, Redis-compatible server that BullMQ works with. Install it
from https://www.memurai.com/get-memurai and keep port 6379. It runs as the `Memurai` service.

## 3. SeaweedFS and Mailpit

They live in `.tools/`, which git ignores. On a new machine, download them again:

- SeaweedFS `windows_amd64.zip` from https://github.com/seaweedfs/seaweedfs/releases (checked
  against its `.md5`), unpacked to `.tools/seaweedfs/weed.exe`.
- Mailpit `mailpit-windows-amd64.zip` from https://github.com/axllent/mailpit/releases, unpacked
  to `.tools/mailpit/mailpit.exe`.

## Tests

`pnpm test` and `pnpm test:e2e` use the same four services, so run `pnpm services:up` first. The
test suites create their own `*_test` databases.

Docker still works for anyone who prefers it: `pnpm docker:up` starts the same services in
containers. Run one or the other, not both, since they use the same ports.
