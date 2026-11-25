# Osudh24

React + TypeScript + Vite frontend with a Node.js API. Development uses persistent SQLite; production runs the frontend and API on Vercel with hosted Neon PostgreSQL.

## Run locally

Requires **Node.js 22.x, version 22.13 or newer**, and pnpm. The backend uses Node’s built-in `node:sqlite` module locally, which emits an experimental API warning on Node 22. The storefront can run without provider credentials; Google and mobile sign-in require the Firebase and MSG91 settings described below.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

One command starts both services:

- Website: http://localhost:5173
- API health: http://127.0.0.1:3001/api/health
- SQLite database: `data/osudh24.sqlite` (created and seeded automatically)

For local Google sign-in, use `http://localhost:5173` consistently. Firebase authorizes hostnames separately; `127.0.0.1` needs its own authorized-domain entry.

Stop both services with Ctrl+C. Both bind to the local computer. Vite proxies `/api` to the backend, so the frontend uses the same origin and sends its guest session cookie automatically. The website port is fixed; startup reports an error if 5173 is already occupied.

Optional configuration: copy `.env.example` to `.env`, then change `API_PORT` or `DATABASE_PATH`. Leave `DATABASE_URL` empty to use local SQLite; setting it selects PostgreSQL. Restart after changing these values. `data/` and local environment files are ignored by Git. A custom database path should also be kept out of version control.

Individual services for development:

```sh
pnpm dev:server
pnpm dev:client
```

For a built version, stop the development API first and run:

```sh
pnpm build
pnpm start
```

The Node server serves both `dist/` and `/api` at http://127.0.0.1:3001. `pnpm preview` is also available on port 4173 while a separate API server is running.

## Connected features

- Product and fictional doctor catalogs are seeded into the database and loaded through the API.
- Cart quantities are saved on the server, with a limit of 99 per product.
- Account profiles and delivery PIN codes survive refreshes and server restarts. Google and verified mobile identities restore the same account in another browser.
- Checkout reads the saved cart, validates contact/address fields and calculates prices on the server. `WELCOME10` gives a 10% demo discount. Demo delivery is ₹49 below ₹499 after discounts and free at or above ₹499.
- Order creation saves the profile and order and empties the cart in one transaction. An idempotency key prevents duplicate orders when a checkout is retried. Orders can be cancelled from Profile.
- Appointments use server-provided dates/times in India Standard Time. A database constraint prevents duplicate reservations for the same doctor/date/time. Cancelling releases the slot.
- Prescription JPG, PNG and PDF files are uploaded to the database, limited to 10 MiB each, 20 files and 50 MiB per account. The API checks the content signature. Profile lists private downloads and deletion controls.
- App news signup saves the email address; email delivery is not connected.
- Clearing profile/history removes saved contact details, orders, appointments, prescriptions, saved PIN and signup. The cart and verified sign-in identities stay.

Loading states, disabled submit buttons and visible errors reflect actual API results. A failed request does not show a successful checkout or booking.

## Google and mobile sign-in

Fill the ignored `.env` file using the fields in `.env.example`, then restart `pnpm dev` (or rebuild and restart `pnpm start`). Empty settings disable the corresponding provider with a clear message; there are no demo tokens or bypass codes.

### Firebase Google sign-in

1. In your Firebase project, register a Web app. Copy its configuration from Project settings into `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID` and `VITE_FIREBASE_APP_ID`.
2. Enable **Google** under Authentication → Sign-in method and set the support email. Add `localhost` and `127.0.0.1` to Authentication → Settings → Authorized domains for local testing. Use the same hostname consistently.
3. Configure the backend with the matching `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` from a service account for that project. In `.env`, quote the private key and use literal `\n` for line breaks. Alternatively, set `GOOGLE_APPLICATION_CREDENTIALS` to the service-account JSON file path.
4. Restart the services. Use **Sign in → Continue with Google**. Allow the browser’s sign-in popup.

The `VITE_FIREBASE_*` and `VITE_MSG91_*` settings are public browser configuration. Keep the service-account private key and MSG91 auth key in server-only variables. Do not add a `VITE_` prefix to them. Service-account JSON files should stay outside version control.

The browser obtains a Firebase ID token, and the backend verifies it with the Firebase Admin SDK, including revocation and Google-provider checks, before issuing its own session. Firebase browser state is held in memory and cleared after the exchange. See the official [Google sign-in guide](https://firebase.google.com/docs/auth/web/google-signin) and [ID token verification guide](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

### MSG91 mobile OTP

The sign-in panel supports the **MSG91 OTP Widget** supplied by the client-side integration snippet.

1. Copy `widgetId` to `VITE_MSG91_WIDGET_ID` and `tokenAuth` to `VITE_MSG91_TOKEN_AUTH` in `.env`. These two values are intended for the browser. Keep the widget configured for **web** integration and allow your local website domain in its settings if domain restrictions are enabled.
2. Put your private MSG91 **Authkey** in `MSG91_AUTH_KEY`. This is a separate credential from `tokenAuth`. Find it under Authkey or the widget's Server-side integration section. Keep it server-only. Allow the backend's outgoing IP if your key has IP restrictions.
3. Configure the widget's SMS channel, approved sender/template and sending credit in MSG91. The widget manages its OTP length, resend policy, captcha and expiry. `MSG91_TEMPLATE_ID` is not needed for the widget.
4. Restart `pnpm dev`. Choose **Sign in → Continue with mobile**, then enter your Indian mobile number and received SMS code in the MSG91 verification popup. For an existing Google account, open **Profile → Add sign-in method** first to connect the phone to the same account.

The MSG91 script loads only when requested, with the official `verify.phone91.com` fallback if `verify.msg91.com` fails. After the widget verifies the code, the browser sends its access token to `/api/auth/msg91`. The server calls MSG91's `verifyAccessToken` endpoint with the private Authkey and uses only the returned, verified phone number to sign in or link. Client-supplied phone numbers never authenticate an account. Tokens are not logged or saved in browser storage; their hashes prevent reuse. A widget success callback alone does not create a session.

A missing Authkey keeps phone sign-in disabled. MSG91 errors and cancelled or failed verification appear in the sign-in panel. Local integration tests use injected provider responses and do not send SMS. Live delivery and sign-in require the real MSG91 account settings and a code entered by the phone owner.

See the official [widget integration guide](https://msg91.com/help/sendotp/how-to-integrate-the-new-login-with-otp-widget/) and [server access-token verification API](https://docs.msg91.com/en/otp-widget/verify-access-token).

For the older **OTP API** flow, leave both `VITE_MSG91_*` fields empty and set `MSG91_AUTH_KEY` plus `MSG91_TEMPLATE_ID` to an approved template containing `##OTP##`. That fallback sends a six-digit code through the backend with five-minute expiry, a 60-second resend cooldown and limited send/verification attempts. See [SendOTP](https://docs.msg91.com/otp/sendotp) and [Verify OTP](https://docs.msg91.com/en/otp/verify-otp).

### Accounts, linking and logout

Browsing, cart changes, delivery PINs and app-news signup remain available without signing in. Profile changes, checkout, appointment booking and prescription upload/download require an authenticated account. A signed-in profile shows verified login identities separately from editable delivery contact details.

To use Google and mobile as two ways into the same account, sign in using the existing method first, then choose **Add sign-in method** in Profile and verify the other method. Changing a delivery email or phone does not change sign-in identity. Accounts are never joined by matching editable email/phone fields; linking an identity already assigned to another account is rejected.

Signing in adopts the current guest’s cart and demo data. Returning accounts keep their history across browsers and server restarts. Signing out revokes the current browser session, clears its account view and starts a new guest session. Other signed-in devices keep their own sessions. Other tabs are notified to refresh account state after sign-in/sign-out.

Random session secrets are kept in HttpOnly, SameSite=Strict cookies; the database stores only hashes. Cookies rotate after authentication. Session expiry does not delete account history. The pre-authentication SQLite schema and guest records are migrated automatically without resetting the database. Earlier browser-only `localStorage` records are not imported.

For an explicitly authorized merge of two existing local accounts, stop the API and run the administration script with the **verified** Google email and mobile identity:

```sh
node scripts/merge-accounts.mjs --google-email owner@example.com --mobile +919876543210
# Review the dry run, then repeat with --apply to perform the merge.
```

The script accepts one Google-only account and one mobile-only account. It creates a private, integrity-checked SQLite backup in `data/backups/` before applying one transaction. The Google account remains canonical; blank profile/settings fields are filled from the mobile account, while conflicting non-empty Google values take precedence. Orders, appointments, prescription files and cart items move together; a combined cart quantity above 99 is rejected without changing either account. Existing authenticated browsers continue with the canonical account after refresh; guest sessions and pending verifications for those owners are invalidated. Both verified sign-in identities then restore the same account. No HTTP endpoint or matching of editable contact fields can trigger a merge.

The server validates input and request origins, uses parameterized SQL, and rate-limits OTP requests and attempts. Vercel deployments require PostgreSQL and issue Secure session cookies; local HTTP development keeps its own SQLite database and cookies.

Payments, fulfilment, pharmacist review, real doctor consultations and reminders remain unconnected. Products, prices and doctors are illustrative; demo orders do not collect money or arrange delivery. The contact email/domain remain proposed brand details. Google Fonts and the Unsplash hero image load externally.

## Deploy on Vercel with Neon

Import the repository into Vercel using the Vite preset and **Node.js 22.x**. `vercel.json` installs the pinned pnpm dependencies, runs `pnpm build`, serves `dist/`, and deploys `api/[...path].mjs` as a native Node function in Singapore (`sin1`). The function handles `/api/*` on the same origin as the website; Vite's development proxy is not used in production. Keep Neon near the function region.

Create a Neon PostgreSQL database and configure these Vercel environment variables for the intended deployment environment:

| Variables | Purpose |
| --- | --- |
| `DATABASE_URL` | Server-only pooled Neon connection URL. Vercel refuses to use local SQLite as production storage. |
| `APP_ORIGINS` | Comma-separated exact HTTPS origins, such as `https://your-project.vercel.app,https://your-domain.example`. No paths or wildcard hosts. Vercel's own deployment/project URLs are also recognized automatically. |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Public Firebase web-app settings, embedded at build time. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Server-only Admin credentials for the same Firebase project. Keep the private key's line breaks, or use literal `\n` escapes. A local service-account file path will not exist on Vercel. |
| `VITE_MSG91_WIDGET_ID`, `VITE_MSG91_TOKEN_AUTH` | Public widget configuration, needed by the browser and the API's provider-readiness check. |
| `MSG91_AUTH_KEY` | Server-only MSG91 credential for verifying widget access tokens. `MSG91_TEMPLATE_ID` is needed only for the older direct OTP fallback. |
| `VERCEL_SUPPORT_LARGE_REQUEST_BODY=1` | Enables the larger request-body limit when the function prerequisites below are satisfied. |

Keep database URLs and private provider credentials in Vercel's sensitive environment variables. Never prefix them with `VITE_`, put them in `vercel.json`, commit `.env`/service-account files, or include their values in logs. Redeploy after changing environment variables; `VITE_*` changes require a new frontend build. Use a separate Neon branch/database for Preview deployments so previews do not share production account data.

Add the final website hostname to Firebase Authentication's authorized domains. Keep `VITE_FIREBASE_AUTH_DOMAIN` set to the configured Firebase auth handler; it is not automatically the Vercel website hostname. If MSG91 widget tokens or private keys restrict domains/outgoing IPs, configure them for the deployed website/backend.

### Prescription size support

The app accepts files up to **10 MiB**. Enable **Fluid Compute**, select **Performance (4 GB)** memory, and set `VERCEL_SUPPORT_LARGE_REQUEST_BODY=1` before deploying. The function is configured for 4096 MB and a 60-second maximum duration. Vercel's 20 MiB request-body beta requires a Pro or Enterprise plan; the default 4.5 MB cap cannot support the app's full upload allowance. Large downloads must also use streamed responses because the standard response limit remains 4.5 MB. See [Vercel function limits](https://vercel.com/docs/functions/limitations#request-body-size).

After deployment, verify `/api/health`, `/api/bootstrap`, guest cart persistence, Secure/HttpOnly session cookies, and account sign-in/history after refresh. Live SMS verification requires the phone owner's participation.

### Import existing SQLite data

Perform the import **before enabling production traffic**. Stop the local API and create a private, integrity-checked immutable SQLite backup using SQLite's backup or `VACUUM INTO` facility, which includes committed WAL data. Keep that backup unchanged; do not copy only the main file of a running WAL database.

Set `DIRECT_DATABASE_URL` in the ignored local environment to Neon's direct connection URL; the migration CLI prefers it over `DATABASE_URL`. Keep this URL server-only. Preview the import from the backup, review the aggregate counts, then apply:

```sh
node scripts/import-postgres.mjs --source data/backups/before-postgres-import.sqlite
node scripts/import-postgres.mjs --source data/backups/before-postgres-import.sqlite --apply
```

Dry-run is the default. Opening a blank target can initialize its schema and seed catalog, but dry-run does not write account records. Apply requires every target account/authentication table to be empty and rejects repeat imports; it never overwrites existing production data. The source catalog must match the seeded target catalog exactly.

One transaction imports data owners, users, Google/mobile identity links, carts, orders, appointments, and prescription metadata/file bytes. Account IDs and insertion ordering are preserved, generated sequences are advanced, and record hashes and file bytes are verified before commit. Browser sessions, OTP challenges, used widget tokens, and rate limits are excluded, so users sign in again on production. The command prints counts and verification results without contact details, tokens, connection strings, or record IDs. Keep the source backup for recovery; do not re-run the local SQLite account-merge script against PostgreSQL.

## API

Responses and request bodies are JSON except file upload/download. `GET /api/bootstrap` returns session/account state plus catalogs and appointment availability. Data mutations and completed sign-ins return `{ state }`; checkout, booking and upload also return the created `order`, `appointment` or `prescription`. OTP send returns `{ challengeId, expiresAt, retryAfter }`.

| Method | Route | Input / purpose |
| --- | --- | --- |
| GET | `/api/health` | Service/database health |
| GET | `/api/bootstrap` | Catalogs, account/session state and availability |
| POST | `/api/auth/google` | `{ idToken, mode: 'login' or 'link' }` |
| POST | `/api/auth/msg91` | `{ accessToken, mode }`; verifies the MSG91 widget token on the server |
| POST | `/api/auth/otp/send` | `{ mobile, mode }`; returns challenge ID, expiry and resend cooldown |
| POST | `/api/auth/otp/verify` | `{ challengeId, otp }`; consumes the challenge |
| POST | `/api/auth/logout` | Revoke current session and start a fresh guest |
| PUT | `/api/cart/items/:productId` | `{ quantity }`, integer 0–99; zero removes |
| PUT | `/api/profile` | `{ name, email, phone, address, city, pin }` |
| DELETE | `/api/profile` | Clear signed-in profile/history/files; keep cart and login identities |
| PUT | `/api/location` | `{ pin }`, six digits |
| POST | `/api/orders` | `{ profile, coupon }`; `Idempotency-Key` header required |
| POST | `/api/orders/:id/cancel` | Cancel own order |
| POST | `/api/appointments` | `{ doctorId, patient, date, time }` |
| POST | `/api/appointments/:id/cancel` | Cancel own appointment |
| POST | `/api/prescriptions` | Raw file bytes, MIME `Content-Type`, URL-encoded `X-File-Name` |
| GET | `/api/prescriptions/:id/file` | Download own upload |
| DELETE | `/api/prescriptions/:id` | Delete own upload |
| POST | `/api/newsletter` | `{ email }` |

Errors return `{ error: string }` with an appropriate HTTP status. Clients must retain the session cookie. The web client also sends `X-Account-Id` (the current account ID or `guest`) to reject stale writes after another tab switches accounts; this header never substitutes for authentication. Appointment conflicts return 409. Checkout prices/fees submitted by the client are never authoritative.

## Validation

```sh
pnpm test
pnpm build
```

The Node integration tests use temporary databases and real HTTP requests, covering storage, checkout, appointments, uploads and authentication/session behavior. Widget client tests exercise script fallback, token callbacks, timeout and cancellation with a simulated browser. Provider requests are replaced through test-only dependency injection; tests never send live SMS, contact Google or modify the development database. A passing test suite does not verify that your external account settings, SMS template or credit are configured correctly.

PostgreSQL adapter and migration tests are opt-in: set `TEST_DATABASE_URL` to a dedicated test database, then run `pnpm test`. They create and remove randomly named test schemas and do not use the application's `DATABASE_URL`. Without it, hosted tests are skipped; local storage and migration checks still run using temporary SQLite fixtures.

## Code layout

- `api/[...path].mjs`: native Vercel Node API entry point.
- `server/storage.mjs`: asynchronous SQLite/PostgreSQL adapter, transactions and snapshots.
- `server/`: HTTP routes, schemas, deployment checks, seed catalogs and integration tests.
- `scripts/dev.mjs`: starts/stops the API and Vite together.
- `scripts/import-postgres.mjs`: verified, empty-target-only SQLite-to-PostgreSQL migration.
- `src/components/auth.tsx`: Google and mobile OTP sign-in/linking UI.
- `src/lib/firebase-auth.ts`: lazy Firebase browser token acquisition.
- `src/lib/msg91-auth.ts`: lazy MSG91 widget loader and verification callbacks.
- `src/lib/types.ts`: frontend API types.
- `src/lib/use-backend.ts`: API client, loading/error state and serialized mutations.
- `src/components/commerce.tsx`: cart, checkout, signed-in profile and history.
- `src/components/doctors.tsx`: directory and appointment booking.
- `src/components/ui/`: shared animated components; aliases and `components.json` are configured for shadcn.
- `src/index.css`: Tailwind v4 entry and global styles.

Reduced-motion preferences skip the intro and breathing animation and shorten entrance transitions. The `BreathingText` preview remains in `src/components/ui/demo.tsx`. Vite may report ignored Framer Motion `use client` directives during SPA builds; these do not prevent the production build.
