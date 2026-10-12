'use strict';

const SHARED_APP_UID = 'api::shared-app.shared-app';

const resolveBaseUrl = () =>
  String(process.env.QR_INSTALL_BASE_URL || process.env.PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');

const resolveAbsoluteMediaUrl = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return normalized;
  }

  return `${baseUrl}${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
};

const syncSharedApkUrl = async (entityId) => {
  if (!global.strapi || !entityId) {
    return;
  }

  const entry = await global.strapi.entityService.findOne(SHARED_APP_UID, entityId, {
    fields: ['id', 'android_apk_url'],
    populate: {
      android_apk: {
        fields: ['id', 'url'],
      },
    },
  });

  if (!entry) {
    return;
  }

  const nextUrl = resolveAbsoluteMediaUrl(entry.android_apk?.url);
  const currentUrl = String(entry.android_apk_url || '').trim();
  if (nextUrl === currentUrl) {
    return;
  }

  await global.strapi.db.query(SHARED_APP_UID).update({
    where: { id: entityId },
    data: {
      android_apk_url: nextUrl || null,
    },
  });
};

module.exports = {
  async afterCreate(event) {
    await syncSharedApkUrl(event.result?.id);
  },

  async afterUpdate(event) {
    await syncSharedApkUrl(event.result?.id || event.params?.where?.id);
  },
};
