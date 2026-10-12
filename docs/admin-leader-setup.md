# Admin Leader setup

The Admin Leader role can view account-balance screenshots for Users captured by its assigned Tenant Admins and can update the display name of those Tenant Admin records. Tenant Admin assignment, tenant reassignment, credential reassignment, deletion, Shared App settings, contact export, and voice calling remain Super Admin-only actions.

## One-time portal setup

1. In **Settings > Administration Panel > Roles**, create a role with the code `admin-leader`.
2. Give this role access to Content Manager for **User**, **Contact**, and **Tenant Admin**.
3. For **User** and **Contact**, enable only `read`.
4. For **Tenant Admin**, enable `read` and `update`. Do not enable `create` or `delete`.
5. Create the Strapi admin user and assign the `admin-leader` role.
6. Under **Content Manager > Admin Leader**, create the matching leader record using the same Strapi admin user ID and email.
7. Open each Tenant Admin record that belongs to this leader and set its **Admin Leader** relation.

The backend treats the `admin_user_id` as the primary match and the email as a migration fallback. Both should match the Strapi admin account.

## Security checks

- Admin Leaders can only read Users and Contacts whose `tenant_admin_id` belongs to an assigned Tenant Admin.
- Signed image previews are authorized by the backend and logged as `[admin-leader][image-view]`.
- A direct URL to an out-of-scope User, Contact, Tenant Admin, gallery, or selfie endpoint returns `403`.
