'use strict';

const { errors } = require('@strapi/utils');
const { ADMIN_USER_UID, parsePositiveInt } = require('../../../../utils/tenant-access');
const {
  buildTenantAdminQrCodeUrl,
  generateTenantAdminQrToken,
  isGeneratedTenantAdminQrCodeUrl,
} = require('../../../../utils/app-launch');
const { ValidationError } = errors;
const TENANT_ADMIN_UID = 'api::tenant-admin.tenant-admin';
const TENANT_UID = 'api::tenant.tenant';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const resolveTenantRelationId = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return parsePositiveInt(value);
  }

  if (Array.isArray(value)) {
    return value.map(resolveTenantRelationId).find(Boolean) || null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  // Strapi may use connect, set, data, or a direct relation object depending
  // on whether the value came from a create form, edit form, or API request.
  return [value.id, value.connect, value.set, value.data]
    .map(resolveTenantRelationId)
    .find(Boolean) || null;
};

const findAdminUserByEmail = async (email) => {
  const trimmedEmail = String(email || '').trim();
  if (!trimmedEmail) {
    return null;
  }

  const exactMatch = await strapi.query(ADMIN_USER_UID).findOne({
    where: {
      email: trimmedEmail,
    },
    select: ['id', 'email'],
  });
  if (exactMatch) {
    return exactMatch;
  }

  const normalized = normalizeEmail(trimmedEmail);
  const candidates = await strapi.db.query(ADMIN_USER_UID).findMany({
    select: ['id', 'email'],
    limit: 200,
  });

  return candidates.find((entry) => normalizeEmail(entry.email) === normalized) || null;
};

const findTenantById = async (tenantId) => {
  if (!tenantId) {
    return null;
  }

  return strapi.entityService.findOne(TENANT_UID, tenantId, {
    fields: ['id', 'name', 'slug'],
  });
};

const assertUniqueTenantAdminMapping = async ({
  adminUserId,
  tenantId,
  currentRecordId,
}) => {
  if (!adminUserId || !tenantId) {
    return;
  }

  const existingMappings = await strapi.entityService.findMany(TENANT_ADMIN_UID, {
    filters: {
      admin_user_id: {
        $eq: adminUserId,
      },
      tenant: {
        id: {
          $eq: tenantId,
        },
      },
      ...(currentRecordId
        ? {
            id: {
              $ne: currentRecordId,
            },
          }
        : {}),
    },
    fields: ['id', 'admin_email'],
    populate: {
      tenant: {
        fields: ['id', 'name', 'slug'],
      },
    },
    limit: 1,
  });

  const existingMapping = existingMappings[0];
  if (!existingMapping) {
    return;
  }

  const tenantLabel = String(existingMapping.tenant?.name || existingMapping.tenant?.slug || tenantId).trim();
  throw new ValidationError(
    `This admin is already assigned to tenant "${tenantLabel}". Create separate Tenant Admin records only for different tenants.`
  );
};

const assertUniqueTenantAdminName = async ({
  tenantAdminName,
  tenantId,
  currentRecordId,
}) => {
  const normalizedName = String(tenantAdminName || '').trim();
  const normalizedTenantId = Number(tenantId) || 0;
  if (!normalizedName || !normalizedTenantId) {
    return;
  }

  const existingRecords = await strapi.entityService.findMany(TENANT_ADMIN_UID, {
    filters: {
      tenant_name: {
        $eq: normalizedName,
      },
      ...(currentRecordId
        ? {
            id: {
              $ne: currentRecordId,
            },
          }
        : {}),
      tenant: {
        id: {
          $eq: normalizedTenantId,
        },
      },
    },
    fields: ['id', 'tenant_name', 'admin_email'],
    limit: 1,
  });

  if (!existingRecords[0]) {
    return;
  }

  throw new ValidationError(
    `Tenant Admin Name "${normalizedName}" is already in use for this tenant. Please choose a unique Tenant Admin Name because the referral code uses the combination of Tenant Slug and Tenant Admin Name.`
  );
};

const syncAdminSnapshot = async (event) => {
  const data = event.params?.data;
  if (!data) {
    return;
  }

  const adminEmail = String(data.admin_email || '').trim();
  const adminUserId = parsePositiveInt(data.admin_user_id);
  const existingRecordId = parsePositiveInt(event.params?.where?.id);
  const providedAdminEmail = adminEmail;

  let adminUser = null;

  if (adminEmail) {
    adminUser = await findAdminUserByEmail(adminEmail);
  }

  if (!adminUser && adminUserId) {
    adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
      where: {
        id: adminUserId,
      },
      select: ['id', 'email'],
    });
  }

  if (!adminUser && existingRecordId) {
    const existingRecord = await strapi.db.query('api::tenant-admin.tenant-admin').findOne({
      where: {
        id: existingRecordId,
      },
      select: ['admin_user_id', 'admin_email'],
    });

    const existingAdminEmail = String(existingRecord?.admin_email || '').trim();
    const existingAdminUserId = parsePositiveInt(existingRecord?.admin_user_id);

    if (existingAdminEmail) {
      adminUser = await findAdminUserByEmail(existingAdminEmail);
    }

    if (!adminUser && existingAdminUserId) {
      adminUser = await strapi.db.query(ADMIN_USER_UID).findOne({
        where: {
          id: existingAdminUserId,
        },
        select: ['id', 'email'],
      });
    }
  }

  if (!adminUser) {
    if (providedAdminEmail) {
      throw new ValidationError(
        `No existing Strapi admin user was found for "${providedAdminEmail}". Create that admin user first, then assign tenants here.`
      );
    }

    throw new ValidationError('Tenant Admin requires an existing Strapi admin email or admin user id.');
  }

  data.admin_user_id = adminUser.id;
  data.admin_email = adminUser.email || null;

  let existingTenantAdmin = null;
  if (existingRecordId) {
    existingTenantAdmin = await strapi.db.query(TENANT_ADMIN_UID).findOne({
      where: {
        id: existingRecordId,
      },
      select: ['tenant_name', 'qr_token', 'qr_code_url'],
      populate: {
        tenant: {
          select: ['id', 'name', 'slug'],
        },
      },
    });
  }

  const tenantId = resolveTenantRelationId(data.tenant) || parsePositiveInt(existingTenantAdmin?.tenant?.id);
  const tenant = await findTenantById(tenantId);
  if (!tenant) {
    strapi.log.warn(
      `[tenant-admin][sync] invalid tenant relation record=${existingRecordId || 'new'}` +
      ` resolvedTenantId=${tenantId || 'null'} value=${JSON.stringify(data.tenant || null)}`
    );
    throw new ValidationError('Tenant Admin requires a valid tenant.');
  }

  await assertUniqueTenantAdminMapping({
    adminUserId: adminUser.id,
    tenantId,
    currentRecordId: existingRecordId,
  });

  if (!String(data.tenant_name || '').trim()) {
    data.tenant_name = String(existingTenantAdmin?.tenant_name || tenant.name || '').trim() || null;
  }

  await assertUniqueTenantAdminName({
    tenantAdminName: data.tenant_name,
    tenantId: tenant.id,
    currentRecordId: existingRecordId,
  });

  const nextQrToken = String(data.qr_token || existingTenantAdmin?.qr_token || '').trim() || generateTenantAdminQrToken();
  data.qr_token = nextQrToken;

  const explicitQrCodeUrlProvided = Object.prototype.hasOwnProperty.call(data, 'qr_code_url');
  const existingQrCodeUrl = String(existingTenantAdmin?.qr_code_url || '').trim();
  const nextQrCodeUrl = explicitQrCodeUrlProvided ? String(data.qr_code_url || '').trim() : existingQrCodeUrl;
  const shouldReplaceQrCodeUrl =
    !nextQrCodeUrl ||
    isGeneratedTenantAdminQrCodeUrl(nextQrCodeUrl, {
      qrToken: String(existingTenantAdmin?.qr_token || nextQrToken).trim(),
      tenantCode: String(existingTenantAdmin?.tenant?.slug || tenant.slug || '').trim(),
    });

  if (shouldReplaceQrCodeUrl) {
    data.qr_code_url = buildTenantAdminQrCodeUrl({
      qrToken: nextQrToken,
      tenantCode: tenant.slug,
    }) || null;
  }
};

module.exports = {
  async beforeCreate(event) {
    await syncAdminSnapshot(event);
  },

  async beforeUpdate(event) {
    await syncAdminSnapshot(event);
  },
};
