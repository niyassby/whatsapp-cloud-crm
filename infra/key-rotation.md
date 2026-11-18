# Key rotation

How to replace each secret this system holds, without downtime unless a step says otherwise.
Rotate on a schedule (yearly at least), whenever someone who knew a secret leaves, and at once
when one may have leaked. A leaked secret is also in backups and logs: rotate it, do not just
delete it.

Every secret lives in the environment (`.env` / the host's secret store) of the API and the worker.
Where both read a value, change both and restart both.

## The encryption key: `ENCRYPTION_KEY`

Encrypts WhatsApp, Instagram and integration credentials, webhook signing secrets and 2FA seeds at
rest (`SecretBox`, AES-256-GCM, a data key per value). It also keys the hashes of erased numbers.

1. Make a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Put the new key in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEY_PREVIOUS`
   (comma-separated if there are several). Restart the API and worker. Both keys now decrypt; new
   values use the new one.
3. Run `pnpm secrets:reencrypt`. It rewrites every value still under an old key and lists any
   row it could not rewrite. Fix those before going on.
4. Remove the old key from `ENCRYPTION_KEY_PREVIOUS` and restart.

Erased numbers are stored as keyed hashes, which cannot be rewritten. While an old key stays in
`ENCRYPTION_KEY_PREVIOUS`, numbers erased before the rotation are still recognised on import and
manual add. After it is dropped those people are still erased, but a file that lists them again
would add them back as new, unconsented contacts. Keep old keys listed if that matters to you;
they are then used only for this check.

## Access tokens: `JWT_ACCESS_SECRET`

Signs the 15-minute access tokens.

1. Put the new secret in `JWT_ACCESS_SECRET` and the old one in `JWT_ACCESS_SECRET_PREVIOUS`.
   Restart the API. Tokens signed with either are accepted; new ones use the new secret.
2. After 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`), remove `JWT_ACCESS_SECRET_PREVIOUS` and restart.

Without the previous step, everyone signed in gets one silent refresh: the web refreshes on a 401,
so nobody is logged out.

## Stored token pepper: `JWT_REFRESH_SECRET`

Keys the hashes of refresh tokens, email links (verify, reset), invitations and API keys, and signs
website chat visitor tokens. Changing it alone would log everyone out, kill every link in flight,
and break every API key.

1. Put the new secret in `JWT_REFRESH_SECRET` and the old one in `JWT_REFRESH_SECRET_PREVIOUS`.
   Restart the API. Lookups try the new pepper, then the old one.
2. API keys matched by the old pepper are rehashed under the new one the first time they are used.
   Refresh tokens are rotated on each refresh, so active sessions move over by themselves.
3. Keep the old pepper for at least `REFRESH_TOKEN_TTL_DAYS` (30 days), so sessions and 7-day
   invitations finish. Before removing it, check that every API key in use has been used since the
   rotation started:

   ```sql
   SELECT org_id, id, name, last_used_at FROM api_keys
   WHERE revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < '<rotation start>');
   ```

   Keys listed there stop working when the old pepper goes; ask their owners to use or replace them.

4. Remove `JWT_REFRESH_SECRET_PREVIOUS` and restart.

`pnpm test` runs `apps/api/test/key-rotation.test.ts`, which does steps 1 to 4 against a real API.

## Customers' webhook signing secrets

Per endpoint, in Settings > Webhooks > Rotate secret. Takes effect at once; the customer updates
their receiver. Stored under `ENCRYPTION_KEY`.

## Third-party credentials

| Secret                                                              | Where to change it                                         | Notes                                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_SECRET`                                                   | Meta app dashboard > Settings > Basic                      | Verifies every Meta webhook. Change in the app and in the API at the same moment: deliveries signed with the old secret fail until both match, and Meta retries them. |
| `META_WEBHOOK_VERIFY_TOKEN`                                         | Meta app > WhatsApp > Configuration                        | Only used when Meta re-verifies the callback.                                                                                                                         |
| Customers' WhatsApp tokens                                          | Reconnect the number (Settings > WhatsApp)                 | Stored per WABA, encrypted.                                                                                                                                           |
| `INSTAGRAM_APP_SECRET`                                              | Instagram app settings                                     | As for Meta.                                                                                                                                                          |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                        | Stripe dashboard > Developers                              | Roll the key with an overlap (Stripe allows it); add the new webhook secret, then remove the old endpoint secret.                                                     |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay dashboard                                         | Regenerating the key invalidates the old one at once: change both apps in the same deploy.                                                                            |
| `SHOPIFY_CLIENT_SECRET`, Google, HubSpot client secrets             | Each provider's app settings                               | Connected stores keep their tokens; only new connections and token refreshes use the secret.                                                                          |
| `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`             | Each provider's console                                    | Create the new key, deploy, then revoke the old one.                                                                                                                  |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`                         | The storage provider                                       | Create a second key pair, deploy, then delete the first.                                                                                                              |
| `SMTP_URL` password                                                 | The mail provider                                          | As above.                                                                                                                                                             |
| Database passwords                                                  | `ALTER ROLE wacrm_app PASSWORD '...'` (and the owner role) | Change `DATABASE_URL` / `DIRECT_URL` and restart. Open connections keep working until they close.                                                                     |
| `SENTRY_DSN`                                                        | Sentry project settings                                    | Not a secret that grants access, but rotate it if abused.                                                                                                             |

After any rotation, check `/admin` > System and the API's `/health/ready`, and send a test message.
