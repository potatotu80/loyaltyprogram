'use strict';

const crypto = require('crypto');
const TENANT_API_KEY_PATTERN = /^[a-z0-9]+_[a-f0-9]{48}$/;

const isGeneratedTenantApiKey = (value) => TENANT_API_KEY_PATTERN.test(String(value || '').trim());

const generateTenantApiKey = (tenant) => {
  const rawPrefix = String(tenant?.slug || tenant?.name || 'tenant')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const prefix = rawPrefix || 'tenant';
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
};

module.exports = {
  generateTenantApiKey,
  isGeneratedTenantApiKey,
};
