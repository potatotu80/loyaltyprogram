'use strict';

const crypto = require('crypto');

const DEFAULT_SHARED_DEEP_LINK_SCHEME = 'loyaltycircle';
const DEFAULT_SHARED_ANDROID_APPLICATION_ID = 'com.loyaltycircle.mobile';

const resolvePublicBaseUrl = () =>
  String(process.env.QR_INSTALL_BASE_URL || process.env.PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');

const getSharedDeepLinkScheme = () => {
  const normalized = String(process.env.SHARED_ANDROID_DEEP_LINK_SCHEME || DEFAULT_SHARED_DEEP_LINK_SCHEME)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || DEFAULT_SHARED_DEEP_LINK_SCHEME;
};

const getSharedAndroidApplicationId = () =>
  String(process.env.SHARED_ANDROID_APPLICATION_ID || DEFAULT_SHARED_ANDROID_APPLICATION_ID).trim()
    || DEFAULT_SHARED_ANDROID_APPLICATION_ID;

const generateTenantAdminQrToken = () => {
  const tokenBody = crypto.randomBytes(18).toString('hex');
  return `ta_${tokenBody}`;
};

const buildTenantAdminQrCodeUrl = ({ qrToken, tenantCode, referralCode = '' }) => {
  const normalizedToken = String(qrToken || '').trim();
  const normalizedTenantCode = String(tenantCode || '').trim();
  const baseUrl = resolvePublicBaseUrl();
  if (!normalizedToken || !normalizedTenantCode || !baseUrl) {
    return '';
  }

  const url = new URL('/qr-install', `${baseUrl}/`);
  url.searchParams.set('qrToken', normalizedToken);
  url.searchParams.set('tenantCode', normalizedTenantCode);
  if (String(referralCode || '').trim()) {
    url.searchParams.set('referralCode', String(referralCode).trim());
  }
  return url.toString();
};

const isGeneratedTenantAdminQrCodeUrl = (value, { qrToken, tenantCode }) => {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return true;
  }

  return normalizedValue === buildTenantAdminQrCodeUrl({ qrToken, tenantCode });
};

module.exports = {
  buildTenantAdminQrCodeUrl,
  generateTenantAdminQrToken,
  getSharedAndroidApplicationId,
  getSharedDeepLinkScheme,
  isGeneratedTenantAdminQrCodeUrl,
  resolvePublicBaseUrl,
};
