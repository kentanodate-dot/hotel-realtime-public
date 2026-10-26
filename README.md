# Hotel realtime: vacancy collector

Read-only vacancy collector for a configured set of hotel pages (HappyHotel and Hotenavi). Source HTML is parsed for public room counts; unavailable data is reported as unknown and never fabricated.

## Safety and setup
- Repository source and GitHub Actions logs are **public**. Never commit passwords, cookies, session keys or `.session/`.
- The sole workflow trigger is **manual** (`workflow_dispatch`); no automatic schedule is active.
- Repository Secrets required: `HH_LOGIN_ID`, `HH_PASSWORD`, and `SESSION_CACHE_KEY`. The last is an independent cryptographically random string of at least 32 characters.
- Encrypted session cache uses AES-256-GCM with a per-run salt and nonce. Do not add untrusted PR triggers or upload cache plaintext.
- Outbound sync to Cloudflare uses a short-lived GitHub OIDC token with repository ID, workflow, ref and signature verification.
- Set all available account and repository billing budgets to **$0**, with spending blocked at the threshold before enabling any schedule.
- Only enable scheduled runs after validating that the usage complies with GitHub Actions terms and each source website's policies.
- Avoid logging responses that could contain session tokens.

## Sources
- `config/hotels.json`: 20 registered hotels, 15 confirmed retrievable in the previous private-repo tests.
- Pending hotels remain unknown until a verified source contains actual vacancy numbers.
- `scripts/http-hotels.mjs`: fetches by HTTP; starts Chrome only when the cached login session no longer works.
- `.github/workflows/hotel-fetch.yml`: manually runnable validation workflow.

## Proposed schedule (NOT ACTIVE)
If the requirements above are satisfied, the intended timing is every 10 minutes from 09:00 JST to 05:59 JST, pausing 06:00–08:59 JST. GitHub cron (UTC): `3,13,23,33,43,53 0-20 * * *`. Scheduled GitHub jobs are not guaranteed to run at an exact time.

## Operations
After the GitHub repository secrets and the Cloudflare repository allow-list are configured, run `Actions → Hotel vacancy collector → Run workflow` to test once. Check that Cloudflare sync succeeds and the expected hotels have fresh timestamps.
