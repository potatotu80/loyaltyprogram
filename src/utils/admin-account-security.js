'use strict';

const ADMIN_ACCOUNT_SECURITY_UID = 'api::admin-account-security.admin-account-security';

const findAdminAccountSecurity = async (strapi, adminUserId) => {
  if (!adminUserId) {
    return null;
  }

  return strapi.db.query(ADMIN_ACCOUNT_SECURITY_UID).findOne({
    where: { admin_user_id: adminUserId },
    select: ['id', 'admin_user_id', 'must_change_password'],
  });
};

const mustChangePassword = async (strapi, adminUserId) => {
  const record = await findAdminAccountSecurity(strapi, adminUserId);
  return record?.must_change_password === true;
};

const requirePasswordChange = async (strapi, adminUserId) => {
  const existing = await findAdminAccountSecurity(strapi, adminUserId);
  const timestamp = new Date();

  if (existing) {
    await strapi.db.query(ADMIN_ACCOUNT_SECURITY_UID).update({
      where: { id: existing.id },
      data: {
        must_change_password: true,
        temporary_password_issued_at: timestamp,
        password_changed_at: null,
      },
    });
    return;
  }

  await strapi.db.query(ADMIN_ACCOUNT_SECURITY_UID).create({
    data: {
      admin_user_id: adminUserId,
      must_change_password: true,
      temporary_password_issued_at: timestamp,
      password_changed_at: null,
    },
  });
};

const completePasswordChange = async (strapi, adminUserId) => {
  const existing = await findAdminAccountSecurity(strapi, adminUserId);
  if (!existing?.must_change_password) {
    return false;
  }

  await strapi.db.query(ADMIN_ACCOUNT_SECURITY_UID).update({
    where: { id: existing.id },
    data: {
      must_change_password: false,
      password_changed_at: new Date(),
    },
  });
  return true;
};

const removeAdminAccountSecurity = async (strapi, adminUserId) => {
  const existing = await findAdminAccountSecurity(strapi, adminUserId);
  if (!existing) {
    return;
  }

  await strapi.db.query(ADMIN_ACCOUNT_SECURITY_UID).delete({
    where: { id: existing.id },
  });
};

module.exports = {
  completePasswordChange,
  mustChangePassword,
  removeAdminAccountSecurity,
  requirePasswordChange,
};
