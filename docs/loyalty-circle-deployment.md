# Loyalty Circle Deployment Identity

Loyalty Circle is a separate product deployment. It must not share the previous product's domain, database, Android package ID, deep-link scheme, or public object-storage prefix.

## Required production values

Before deployment, set these values in `LoyaltyProgram/.env` with the real new domain values:

```env
PUBLIC_URL=https://api.<your-new-domain>
ADMIN_URL=https://admin.<your-new-domain>/admin
CORS_ORIGIN="https://admin.<your-new-domain>,https://api.<your-new-domain>"
DATABASE_NAME=loyalty_program
S3_IMAGES_PREFIX=loyalty-program-users
STRAPI_ADMIN_S3_IMAGES_PREFIX=loyalty-program-users
SHARED_ANDROID_DEEP_LINK_SCHEME=loyaltycircle
SHARED_ANDROID_APPLICATION_ID=com.loyaltycircle.mobile
QR_INSTALL_BASE_URL=https://api.<your-new-domain>
```

Use a new database and a separate R2 bucket or prefix. Never point this backend at the previous product database or image prefix.

## Required Android values

Set these values in `LoyaltyProgramApp/android-app/gradle.properties`, or provide them through CI environment variables:

```properties
APP_BASE_URL_PROD=https://api.<your-new-domain>
APP_BASE_URL_STAGING=https://api-staging.<your-new-domain>
APP_DEEP_LINK_SCHEME=loyaltycircle
```

The Android application ID is `com.loyaltycircle.mobile`. If your Play Console package name differs, change it before the first signed release. Do not change it after publishing the first production app.

## Branding

The new customer-facing identity is `Loyalty Circle` with a midnight, cream, and acid-lime palette. Tenant display names can still override the label returned by the backend, but the default landing page and app no longer expose the previous product name.

The placeholder `support@loyaltycircle.example` is intentionally not deliverable. Replace it in `src/index.js` before publishing the Privacy Policy.
