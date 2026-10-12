'use strict';

const crypto = require('crypto');
const { findTenantByApiKey, findTenantLaunchByQrToken, findTenantLaunchByReferralCode } = require('../utils/tenant-access');

const getClientIp = (ctx) => {
  const forwardedFor = ctx.request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return ctx.request.ip || ctx.ip || 'unknown';
};

const maskKey = (value) => {
  const key = String(value || '').trim();
  if (!key) {
    return '(empty)';
  }

  if (key.length <= 10) {
    return `${key.slice(0, 2)}...${key.slice(-2)}`;
  }

  return `${key.slice(0, 8)}...${key.slice(-6)}`;
};

const rejectForbidden = (ctx, message) => {
  ctx.status = 403;
  ctx.body = {
    data: null,
    error: {
      status: 403,
      name: 'ForbiddenError',
      message,
      details: {},
    },
  };
  return false;
};

const getOrCreateTraceId = (ctx) => {
  const headerTraceId = String(ctx.request.headers['x-trace-id'] || '').trim();
  const traceId = headerTraceId || `backend-${Date.now()}-${(crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex')).slice(0, 8)}`;
  ctx.state.requestTraceId = traceId;
  if (typeof ctx.set === 'function') {
    ctx.set('x-trace-id', traceId);
  } else if (ctx.response && typeof ctx.response.set === 'function') {
    ctx.response.set('x-trace-id', traceId);
  } else {
    ctx.response = ctx.response || {};
    ctx.response.headers = ctx.response.headers || {};
    ctx.response.headers['x-trace-id'] = traceId;
  }
  return traceId;
};

module.exports = async (policyContext, _config, { strapi }) => {
  const traceId = getOrCreateTraceId(policyContext);
  const headerKey = (
    policyContext.request.headers['x-app-api-key']
    || policyContext.request.headers['x-app-write-key']
    || ''
  ).trim();
  const qrTokenHeader = String(
    policyContext.request.headers['x-tenant-qr-token']
    || policyContext.request.headers['x-app-launch-token']
    || ''
  ).trim();

  const authHeader = (policyContext.request.headers.authorization || '').trim();
  const bearerPrefix = 'Bearer ';
  const bearerToken = authHeader.startsWith(bearerPrefix)
    ? authHeader.slice(bearerPrefix.length).trim()
    : '';
  const referralCode = String(
    policyContext.request.body?.referralCode
    || policyContext.request.query?.referralCode
    || policyContext.request.headers['x-referral-code']
    || ''
  ).trim();

  const presentedKey = qrTokenHeader || headerKey || bearerToken;

  const adminUser = policyContext.state?.admin?.user;
  if (adminUser?.id) {
    return true;
  }

  if (!presentedKey && !referralCode) {
    strapi.log.warn(
      `[trace=${traceId}] [app-api-key] Missing tenant API key for ${policyContext.request.method} ${policyContext.request.path} ` +
      `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
    );
    return rejectForbidden(policyContext, 'Invalid tenant launch token or application API key.');
  }

  const launchContext = qrTokenHeader
    ? await findTenantLaunchByQrToken(strapi, qrTokenHeader)
    : null;
  const referralLaunchContext = !launchContext && referralCode
    ? await findTenantLaunchByReferralCode(strapi, referralCode)
    : null;
  const tenant =
    launchContext?.tenant
    || await findTenantByApiKey(strapi, presentedKey)
    || referralLaunchContext?.tenant;
  if (tenant) {
    strapi.log.info(
      `[trace=${traceId}] [app-api-key] Accepted ${policyContext.request.method} ${policyContext.request.path} ` +
      `tenant=${tenant.slug || tenant.id} key=${maskKey(presentedKey || referralCode)} ` +
      `qrTokenPresent=${Boolean(qrTokenHeader)} referralCodePresent=${Boolean(referralCode)} ` +
      `deviceId=${String(policyContext.request.headers['x-device-id'] || '').trim() || '-'} ` +
      `appVersion=${String(policyContext.request.headers['x-app-version'] || '').trim() || '-'} ` +
      `platform=${String(policyContext.request.headers['x-client-platform'] || '').trim() || '-'} ` +
      `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
    );
    policyContext.state.appTenant = tenant;
    const resolvedTenantAdmin = launchContext?.tenantAdmin || referralLaunchContext?.tenantAdmin || null;
    if (resolvedTenantAdmin) {
      policyContext.state.appTenantAdmin = resolvedTenantAdmin;
      policyContext.state.appLaunchToken = resolvedTenantAdmin.qr_token;
    }
    return true;
  }

  strapi.log.warn(
    `[trace=${traceId}] [app-api-key] Blocked ${policyContext.request.method} ${policyContext.request.path} ` +
    `key=${maskKey(presentedKey)} ` +
    `qrTokenPresent=${Boolean(qrTokenHeader)} referralCodePresent=${Boolean(referralCode)} ` +
    `deviceId=${String(policyContext.request.headers['x-device-id'] || '').trim() || '-'} ` +
    `appVersion=${String(policyContext.request.headers['x-app-version'] || '').trim() || '-'} ` +
    `platform=${String(policyContext.request.headers['x-client-platform'] || '').trim() || '-'} ` +
    `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
  );

  return rejectForbidden(policyContext, 'Invalid tenant launch token or application API key.');
};
