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
BACKUP_R2_BUCKET=<your-r2-backup-bucket>
BACKUP_R2_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
BACKUP_R2_ACCESS_KEY_ID=<r2-access-key-id>
BACKUP_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
BACKUP_R2_REGION=auto
BACKUP_RETENTION_DAYS=7
BACKUP_LOCAL_DIR=/var/backups/loyalty-program
BACKUP_KEEP_LOCAL=false
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

## Daily R2 backups

The included `deploy/backup/backup-to-r2.sh` backs up the PostgreSQL database and local `public/uploads` Media Library files to R2. User screenshots stored directly in R2 are already durable objects and are not duplicated by this job.

On the EC2 instance, install the PostgreSQL client and AWS CLI, prepare an `ubuntu`-owned temporary directory, and make the script executable:

```bash
sudo apt update
sudo apt install -y postgresql-client
pipx install awscli
sudo mkdir -p /var/backups/loyalty-program /var/www/loyaltyprogram/logs
sudo chown ubuntu:ubuntu /var/backups/loyalty-program /var/www/loyaltyprogram/logs
sudo chmod 700 /var/backups/loyalty-program
chmod +x /var/www/loyaltyprogram/deploy/backup/backup-to-r2.sh
```

Test it as the `ubuntu` user before scheduling it:

```bash
cd /var/www/loyaltyprogram
./deploy/backup/backup-to-r2.sh
```

Add the following with `crontab -e` to run every day at 3:00 AM in the server's timezone and write to the application log directory:

```cron
0 3 * * * cd /var/www/loyaltyprogram && /var/www/loyaltyprogram/deploy/backup/backup-to-r2.sh >> /var/www/loyaltyprogram/logs/backup.log 2>&1
```

The script keeps seven days by default, deleting older backups under `db-backups/` and `media-backups/` in the configured R2 bucket.
