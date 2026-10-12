'use strict';

const { generateTenantApiKey, isGeneratedTenantApiKey } = require('../../../../utils/tenant-api-key');
const {
  buildTenantAdminQrCodeUrl,
  isGeneratedTenantAdminQrCodeUrl,
} = require('../../../../utils/app-launch');

const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';
const TENANT_UID = 'api::tenant.tenant';
const TENANT_ADMIN_UID = 'api::tenant-admin.tenant-admin';
const TENANT_FIELDS = ['id', 'slug', 'qr_code_url', 'android_apk_url'];

const deriveDeepLinkScheme = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return '';
  }

  return /^[a-z]/.test(normalized) ? normalized : '';
};

const shouldReplaceTenantApiKey = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return true;
  }

  if (normalized === MANAGED_API_KEY_PLACEHOLDER) {
    return true;
  }

  return !isGeneratedTenantApiKey(normalized);
};

const resolveQrInstallBaseUrl = () =>
  String(process.env.QR_INSTALL_BASE_URL || process.env.PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');

const parseTenantAdminQrCodeUrl = (value) => {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return null;
  }

  try {
    const parsed = new URL(normalizedValue);
    if (parsed.pathname !== '/qr-install') {
      return null;
    }

    return {
      qrToken: String(parsed.searchParams.get('qrToken') || '').trim(),
      tenantCode: String(parsed.searchParams.get('tenantCode') || '').trim(),
      referralCode: String(parsed.searchParams.get('referralCode') || '').trim(),
      origin: parsed.origin,
    };
  } catch (error) {
    return null;
  }
};

const buildQrCodeUrl = (slug) => {
  const normalizedSlug = String(slug || '').trim();
  const baseUrl = resolveQrInstallBaseUrl();
  if (!normalizedSlug || !baseUrl) {
    return '';
  }

  const url = new URL('/qr-install', `${baseUrl}/`);
  url.searchParams.set('tenantCode', normalizedSlug);
  return url.toString();
};

const resolveAbsoluteMediaUrl = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  const baseUrl = resolveQrInstallBaseUrl();
  if (!baseUrl) {
    return normalized;
  }

  return `${baseUrl}${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
};

const getTenantStrapi = () => global.strapi;

const syncTenantAdminQrCodeUrls = async ({ previousSlug, tenantId }) => {
  const strapi = getTenantStrapi();
  if (!strapi || !tenantId) {
    return;
  }

  const tenant = await strapi.entityService.findOne(TENANT_UID, tenantId, {
    fields: ['id', 'slug'],
  });

  const nextTenantSlug = String(tenant?.slug || '').trim();
  if (!nextTenantSlug) {
    return;
  }

  const tenantAdmins = await strapi.db.query(TENANT_ADMIN_UID).findMany({
    where: {
      tenant: {
        id: {
          $eq: tenantId,
        },
      },
    },
    select: ['id', 'qr_token', 'qr_code_url'],
  });

  for (const tenantAdmin of tenantAdmins) {
    const qrToken = String(tenantAdmin.qr_token || '').trim();
    const currentQrCodeUrl = String(tenantAdmin.qr_code_url || '').trim();

    if (!qrToken || !currentQrCodeUrl) {
      continue;
    }

    const parsedQrCodeUrl = parseTenantAdminQrCodeUrl(currentQrCodeUrl);
    const currentTenantCode = String(parsedQrCodeUrl?.tenantCode || '').trim();
    const referralCode = String(parsedQrCodeUrl?.referralCode || '').trim();
    const generatedFromPreviousSlug = previousSlug
      && isGeneratedTenantAdminQrCodeUrl(currentQrCodeUrl, {
        qrToken,
        tenantCode: previousSlug,
      });
    const generatedFromCurrentUrl =
      parsedQrCodeUrl
      && parsedQrCodeUrl.qrToken === qrToken
      && currentTenantCode;

    if (!generatedFromPreviousSlug && !generatedFromCurrentUrl) {
      continue;
    }

    if (currentTenantCode === nextTenantSlug) {
      continue;
    }

    const nextQrCodeUrl = buildTenantAdminQrCodeUrl({
      qrToken,
      tenantCode: nextTenantSlug,
      referralCode,
    });

    if (!nextQrCodeUrl || nextQrCodeUrl === currentQrCodeUrl) {
      continue;
    }

    await strapi.db.query(TENANT_ADMIN_UID).update({
      where: {
        id: tenantAdmin.id,
      },
      data: {
        qr_code_url: nextQrCodeUrl,
      },
    });
  }
};

const syncAndroidApkUrl = async (tenantId) => {
  const strapi = getTenantStrapi();
  if (!strapi || !tenantId) {
    return;
  }

  const tenant = await strapi.entityService.findOne(TENANT_UID, tenantId, {
    fields: TENANT_FIELDS,
    populate: {
      android_apk: {
        fields: ['id', 'url'],
      },
    },
  });

  if (!tenant) {
    return;
  }

  const nextUrl = resolveAbsoluteMediaUrl(tenant.android_apk?.url);
  const currentUrl = String(tenant.android_apk_url || '').trim();
  if (nextUrl === currentUrl) {
    return;
  }

  await strapi.db.query(TENANT_UID).update({
    where: { id: tenantId },
    data: {
      android_apk_url: nextUrl || null,
    },
  });
};

const shouldReplaceGeneratedQrCodeUrl = (value, previousSlug) => {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return true;
  }

  if (!previousSlug) {
    return false;
  }

  return normalizedValue === buildQrCodeUrl(previousSlug);
};

const ensureTenantApiKeyOnCreate = (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (shouldReplaceTenantApiKey(data.app_api_key)) {
    data.app_api_key = generateTenantApiKey(data);
  }

  if (!String(data.android_deep_link_scheme || '').trim()) {
    data.android_deep_link_scheme =
      deriveDeepLinkScheme(data.slug) ||
      deriveDeepLinkScheme(data.name) ||
      'loyaltycircle';
  }

  if (!String(data.qr_code_url || '').trim()) {
    const generatedUrl = buildQrCodeUrl(data.slug || data.name);
    if (generatedUrl) {
      data.qr_code_url = generatedUrl;
    }
  }
};

const ensureTenantApiKeyOnUpdate = async (event) => {
  const data = event.params?.data;
  if (!data || typeof data !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'app_api_key') && shouldReplaceTenantApiKey(data.app_api_key)) {
    data.app_api_key = generateTenantApiKey(data);
  }

  if (!String(data.android_deep_link_scheme || '').trim()) {
    data.android_deep_link_scheme =
      deriveDeepLinkScheme(data.slug) ||
      deriveDeepLinkScheme(data.name);
  }

  const tenantId = event.params?.where?.id;
  if (!tenantId) {
    return;
  }

  const strapi = getTenantStrapi();
  if (!strapi) {
    return;
  }

  const existingTenant = await strapi.entityService.findOne(TENANT_UID, tenantId, {
    fields: TENANT_FIELDS,
  });
  if (!existingTenant) {
    return;
  }

  event.state = event.state || {};
  event.state.existingTenant = existingTenant;

  const nextSlug = String(data.slug || existingTenant.slug || data.name || '').trim();
  if (!nextSlug) {
    return;
  }

  const explicitQrCodeUrlProvided = Object.prototype.hasOwnProperty.call(data, 'qr_code_url');
  const existingQrCodeUrl = String(existingTenant.qr_code_url || '').trim();
  const nextQrCodeUrl = explicitQrCodeUrlProvided ? data.qr_code_url : existingQrCodeUrl;

  if (shouldReplaceGeneratedQrCodeUrl(nextQrCodeUrl, existingTenant.slug)) {
    const generatedUrl = buildQrCodeUrl(nextSlug);
    if (generatedUrl) {
      data.qr_code_url = generatedUrl;
    }
  }
};

module.exports = {
  beforeCreate(event) {
    ensureTenantApiKeyOnCreate(event);
  },

  async beforeUpdate(event) {
    await ensureTenantApiKeyOnUpdate(event);
  },

  async afterCreate(event) {
    await syncAndroidApkUrl(event.result?.id);
  },

  async afterUpdate(event) {
    const tenantId = event.result?.id || event.params?.where?.id;
    await syncAndroidApkUrl(tenantId);
    await syncTenantAdminQrCodeUrls({
      previousSlug: String(event.state?.existingTenant?.slug || '').trim(),
      tenantId,
    });
  },
};
