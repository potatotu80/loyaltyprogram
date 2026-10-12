# Strapi Contact Backend

This workspace contains a Strapi v4 backend configured to use PostgreSQL.

## Content Types

- `User`
  - `tenant` (`many-to-one` relation to `Tenant`)
  - `email` (`email`, required, unique)
  - `phone` (`string`)
  - `phoneVerified` (`boolean`, default `false`)
  - `device_id` (`string`, required)
- `Contact`
  - `name` (`string`, required)
  - `phone` (`string`, required)
  - `email` (`email`, optional)
  - `user_email` (`string`, auto-filled from related User for easier filtering)
  - `user_phone` (`string`, auto-filled from related User for easier filtering)
  - `user` (`many-to-one` relation to `User`, required)
  - `tenant` (`many-to-one` relation to `Tenant`)
- `Tenant`
  - `name` (`string`, required, unique)
  - `slug` (`uid`, required, unique)
  - `status` (`active` or `inactive`)
  - `app_api_key` (`string`, required, unique)
  - branding fields for white-label Android builds
- `Tenant Admin`
  - `admin_email` (`email`, required, resolves the Strapi admin user automatically)
  - `admin_user_id` (`integer`, auto-filled from the resolved admin user)
  - `tenant` (`many-to-one` relation to `Tenant`, required)

## REST API

Strapi REST is enabled by default in [config/api.js](/c:/Personal/Codex/Contact/config/api.js).

Custom collection endpoints:

- `GET/POST /api/app-users`
- `GET/PUT/DELETE /api/app-users/:id`
- `POST /api/phone-verification/send-otp`
- `POST /api/phone-verification/verify-otp`
- `GET /api/app-users/:id/contacts`
- `GET/POST /api/contacts`
- `GET/PUT/DELETE /api/contacts/:id`
- `POST /api/twilio/voice`
- `POST /api/s3/presign`
- `GET /admin/app-user-gallery/:id` (admin-authenticated signed read URLs for S3 gallery preview)
- `GET /privacy_policy` (public privacy policy page)

`app-users` is used for the route path to avoid conflicting with Strapi's built-in `users-permissions` plugin routes under `/api/users`.

All app-facing `app-users`, `contacts`, and `s3/presign` endpoints are protected by a tenant application key.
Send one of these headers on every app/API request:

```text
x-app-api-key: <TENANT_APP_API_KEY>
```

or

```text
Authorization: Bearer <TENANT_APP_API_KEY>
```

Strapi admin users are still allowed through the custom policy for admin-side tools.

Each presented API key resolves to exactly one active `Tenant`. All app user creation, contact sync, profile image upload, and S3 presign calls are automatically scoped to that tenant. Shared Telnyx Verify and Twilio Voice configuration remain global.

To view all contacts for one app user without using a large relation picker in the admin form, use:

```text
GET /api/app-users/:id/contacts
```

For large datasets in the Contact list, filter by `user_email` or `user_phone` instead of relying only on relation picker filters.

S3 image uploads are done via presigned URLs from:

```text
POST /api/s3/presign
```

Request body supports `fileName`, `contentType`, and `userId` (or `userEmail`).
The returned upload URL stores files under:

```text
users/<tenant-slug>/<userId>/images/
```

For the Strapi admin UI, private S3 gallery images can be previewed from the User edit page through signed read URLs returned by:

```text
GET /admin/app-user-gallery/:id
```

This endpoint is restricted to authenticated Strapi admin users and avoids making the S3 bucket public.

Twilio Voice admin calling is supported through:

- `POST /api/twilio/voice` for your TwiML App Voice URL
- `GET /admin/twilio/voice/token` for authenticated Strapi admin users

The admin edit page for `Contact` and `User` includes a softphone panel that can place outbound calls through the Twilio Voice JavaScript SDK.

To configure Twilio Voice:

1. Create or update a TwiML App in Twilio with Voice URL:
   `https://api.yengsang.com/api/twilio/voice`
2. Set these environment variables:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_VOICE_API_KEY_SID`
   - `TWILIO_VOICE_API_KEY_SECRET`
   - `TWILIO_VOICE_TWIML_APP_SID`
   - `TWILIO_VOICE_CALLER_ID`
3. Install dependencies and rebuild the Strapi admin app.

The public privacy policy page is available at:

```text
https://cmsportal.yengsang.com/privacy_policy
```

Phone verification uses Telnyx Verify. Before the mobile app uploads images, it should:

1. Call `POST /api/phone-verification/send-otp` with `{"phone":"+60123456789"}`.
2. Call `POST /api/phone-verification/verify-otp` with `{"phone":"+60123456789","code":"123456"}`.
3. Only proceed with upload after verification succeeds, then store the same phone in `User.phone` with `User.phoneVerified=true`.

Basic abuse protection is enforced server-side:

- `send-otp`: maximum `3` requests per phone number per `10` minutes
- `verify-otp`: maximum `5` attempts per phone number per `10` minutes
- When exceeded, the API returns HTTP `429`

## Multi-Tenant Roles

- `Super Admin`
  - Native Strapi super admin
  - Can manage all tenants, tenant admins, users, contacts, and admin tools
- `Tenant Admin`
  - A normal Strapi admin user mapped to one or more tenants through the `Tenant Admin` collection type
  - Restricted in the admin UI to only `User` and `Contact` entries that belong to assigned tenants
  - Cannot manage `Tenant` or `Tenant Admin` records

## Run Locally

1. Create a PostgreSQL database, for example `contact`.

2. Copy the environment template and update the database credentials:

```bash
copy .env.example .env
```

Set these values in `.env`:

```env
TELNYX_API_KEY=replace-me
TELNYX_VERIFY_PROFILE_ID=replace-me
TWILIO_VOICE_API_KEY_SID=replace-me
TWILIO_VOICE_API_KEY_SECRET=replace-me
TWILIO_VOICE_TWIML_APP_SID=replace-me
TWILIO_VOICE_CALLER_ID=+12345678901
TWILIO_VOICE_TOKEN_TTL=3600
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=contact
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=postgres
DATABASE_SCHEMA=public
DATABASE_SSL=false
```

3. Install dependencies if needed:

```bash
npm install
```

4. Start Strapi in development mode:

```bash
npm run develop
```

5. Open the admin panel:

```text
http://localhost:1337/admin
```

On first run, Strapi will prompt you to create the initial admin user in the browser.

## Useful Commands

```bash
npm run develop
npm run build
npm run start
```

## Production Deployment

Production deployment files for EC2 + Nginx are included in:

- [deploy/nginx/strapi.conf](/c:/Personal/Codex/Contact/deploy/nginx/strapi.conf)
- [deploy/pm2/ecosystem.config.js](/c:/Personal/Codex/Contact/deploy/pm2/ecosystem.config.js)

Recommended production URLs:

- API: `https://api.yengsang.com`
- Admin: `https://cmsportal.yengsang.com/admin`

Set these environment variables on the EC2 instance before building and starting Strapi:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=1337
TELNYX_API_KEY=replace-me
TELNYX_VERIFY_PROFILE_ID=replace-me
TWILIO_VOICE_API_KEY_SID=replace-me
TWILIO_VOICE_API_KEY_SECRET=replace-me
TWILIO_VOICE_TWIML_APP_SID=replace-me
TWILIO_VOICE_CALLER_ID=+12345678901
TWILIO_VOICE_TOKEN_TTL=3600
PUBLIC_URL=https://api.yengsang.com
ADMIN_URL=https://cmsportal.yengsang.com/admin
SERVE_ADMIN_PANEL=true
CORS_ORIGIN="https://cmsportal.yengsang.com,https://api.yengsang.com"
DATABASE_CLIENT=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=contact
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=change-me
DATABASE_SCHEMA=public
DATABASE_SSL=false
AWS_REGION=ap-southeast-1
S3_BUCKET_NAME=yengtesting
S3_IMAGES_PREFIX=users
S3_PRESIGN_EXPIRES_IN=900
STRAPI_ADMIN_S3_BUCKET=yengtesting
STRAPI_ADMIN_S3_REGION=ap-southeast-1
STRAPI_ADMIN_S3_IMAGES_PREFIX=users
APP_KEYS="replace-me-1,replace-me-2,replace-me-3,replace-me-4"
API_TOKEN_SALT=replace-me
ADMIN_JWT_SECRET=replace-me
TRANSFER_TOKEN_SALT=replace-me
JWT_SECRET=replace-me
```

When running on EC2 with an attached IAM role, you should not set static AWS keys in `.env`. The AWS SDK will use the instance role automatically.

Build and run in production:

```bash
npm ci
NODE_ENV=production npm run build
NODE_ENV=production npm run start
```

## Tenant Setup Checklist

After deploying this multi-tenant version:

1. Create a `Tenant` entry for each white-label customer.
2. Give each tenant a unique `app_api_key`.
3. Backfill existing `User` and `Contact` rows with the correct `tenant`.
4. Create Strapi admin users for tenant operators as needed.
5. Create `Tenant Admin` entries by entering the Strapi admin email and linking it to the correct tenant.
6. Set Android flavor secrets per tenant before building:
   - `APP_API_KEY_MEMBERREWARD`
   - add more tenant-specific keys as more flavors are introduced
