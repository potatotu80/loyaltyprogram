'use strict';

const { errors } = require('@strapi/utils');
const {
  ADMIN_USER_UID,
  isAdminLeaderRole,
  parsePositiveInt,
} = require('../../../../utils/tenant-access');

const { ValidationError } = errors;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const findAdminUser = async ({ adminUserId, adminEmail }) => {
  const parsedId = parsePositiveInt(adminUserId);
  const normalizedEmail = normalizeEmail(adminEmail);

  if (parsedId) {
    const user = await strapi.db.query(ADMIN_USER_UID).findOne({
      where: { id: parsedId },
      populate: ['roles'],
    });
    if (user) {
      return user;
    }
  }

  if (!normalizedEmail) {
    return null;
  }

  const candidates = await strapi.db.query(ADMIN_USER_UID).findMany({
    populate: ['roles'],
    limit: 500,
  });
  return candidates.find((entry) => normalizeEmail(entry.email) === normalizedEmail) || null;
};

const syncAdminLeaderAccount = async (event) => {
  const data = event.params?.data;
  if (!data) {
    return;
  }

  const currentRecordId = parsePositiveInt(event.params?.where?.id);
  let existingRecord = null;
  if (currentRecordId) {
    existingRecord = await strapi.db.query('api::admin-leader.admin-leader').findOne({
      where: { id: currentRecordId },
      select: ['admin_user_id', 'admin_email'],
    });
  }

  const hasRequestedEmail = Object.prototype.hasOwnProperty.call(data, 'admin_email');
  const adminUser = await findAdminUser({
    adminUserId: hasRequestedEmail ? null : (data.admin_user_id || existingRecord?.admin_user_id),
    adminEmail: data.admin_email || existingRecord?.admin_email,
  });

  if (!adminUser) {
    throw new ValidationError('Create the Strapi Admin Leader account first, then enter its email here.');
  }

  const hasAdminLeaderRole = Array.isArray(adminUser.roles) && adminUser.roles.some(isAdminLeaderRole);
  if (!hasAdminLeaderRole) {
    throw new ValidationError('The selected Strapi admin user must have the Admin Leader role.');
  }

  data.admin_user_id = adminUser.id;
  data.admin_email = adminUser.email;
};

module.exports = {
  async beforeCreate(event) {
    await syncAdminLeaderAccount(event);
  },

  async beforeUpdate(event) {
    await syncAdminLeaderAccount(event);
  },
};
