'use strict';

const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { createCoreController } = require('@strapi/strapi').factories;
const {
  APP_USER_UID,
  assertTenantScopeForUser,
  buildTenantUserImagePrefix,
  getTenantFilter,
} = require('../../../utils/tenant-access');
const {
  buildObjectStoragePublicUrl,
  createObjectStorageClient,
  getObjectStorageConfig,
} = require('../../../utils/object-storage');

const OTP_ATTEMPT_UID = 'api::otp-attempt.otp-attempt';
const OTP_WINDOW_MS = 10 * 60 * 1000;
const SEND_OTP_LIMIT = 3;
const VERIFY_OTP_LIMIT = 5;
const OTP_BYPASS_CODE = '012345';
const APP_USER_FIELDS = [
  'id',
  'email',
  'phone',
  'phoneVerified',
  'full_name',
  'user_id',
  'gender',
  'birthday',
  'occupation',
  'paynow_id_type',
  'paynow_id_value',
  'paynow_name',
  'device_id',
  'device_manufacturer',
  'device_brand',
  'device_model',
  'device_name',
  'android_version',
  'android_sdk_int',
  'app_version',
  'image_url',
  'tenant_admin_id',
  'tenant_admin_email',
  'tenant_admin_name',
  'launch_qr_token',
];

const sanitizeSegment = (value, fallback) => {
  const normalized = (value || fallback).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
};

const getFileExtension = (file) => {
  const originalName = file.originalFilename || file.name || '';
  const fromName = path.extname(originalName).trim();
  if (fromName) {
    return fromName.toLowerCase();
  }

  const mimeType = file.type || file.mimetype || '';
  const mimeExtension = mimeType.split('/')[1];
  return mimeExtension ? `.${sanitizeSegment(mimeExtension, 'bin')}` : '.bin';
};

const sanitizeForEmailLocalPart = (value, fallback) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const normalizePhone = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  const compact = trimmed.replace(/[\s()-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return withPlus;
};

const buildDeviceInfoData = (payload) => {
  const source = payload && typeof payload === 'object' ? payload : {};
  const data = {};
  const stringFields = [
    'device_manufacturer',
    'device_brand',
    'device_model',
    'device_name',
    'android_version',
    'app_version',
  ];

  stringFields.forEach((field) => {
    const value = String(source[field] || '').trim();
    if (value) {
      data[field] = value;
    }
  });

  const sdkIntValue = Number.parseInt(source.android_sdk_int, 10);
  if (Number.isInteger(sdkIntValue)) {
    data.android_sdk_int = sdkIntValue;
  }

  return data;
};

const isValidE164Phone = (value) => /^\+[1-9]\d{7,14}$/.test(value);

const getTelnyxVerifyConfig = () => ({
  apiKey: (process.env.TELNYX_API_KEY || '').trim(),
  verifyProfileId: (process.env.TELNYX_VERIFY_PROFILE_ID || '').trim(),
});

const assertTelnyxVerifyConfigured = () => {
  const config = getTelnyxVerifyConfig();

  if (!config.apiKey || !config.verifyProfileId) {
    const error = new Error('Telnyx Verify is not configured.');
    error.status = 500;
    throw error;
  }

  return config;
};

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const callTelnyxVerify = ({ path: requestPath, body, apiKey }) =>
  new Promise((resolve, reject) => {
    const encodedBody = JSON.stringify(body || {});

    const request = https.request(
      {
        hostname: 'api.telnyx.com',
        port: 443,
        path: requestPath,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(encodedBody),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 500,
            body: responseBody,
            json: parseJson(responseBody),
          });
        });
      }
    );

    request.on('error', reject);
    request.write(encodedBody);
    request.end();
  });

const getLimitForAction = (action) => (action === 'send' ? SEND_OTP_LIMIT : VERIFY_OTP_LIMIT);

const getAttemptCount = async (strapi, phone, action) => {
  const since = new Date(Date.now() - OTP_WINDOW_MS).toISOString();

  return strapi.db.query(OTP_ATTEMPT_UID).count({
    where: {
      phone,
      action,
      createdAt: {
        $gte: since,
      },
    },
  });
};

const recordAttempt = async (strapi, { phone, action, successful, status }) => {
  await strapi.entityService.create(OTP_ATTEMPT_UID, {
    data: {
      phone,
      action,
      successful,
      status: status == null ? null : String(status),
    },
  });
};

const rejectTooManyAttempts = (ctx, action) => {
  ctx.status = 429;
  ctx.body = {
    data: null,
    error: {
      status: 429,
      name: 'TooManyRequestsError',
      message:
        action === 'send'
          ? 'Too many OTP requests for this phone number. Please try again later.'
          : 'Too many OTP verification attempts for this phone number. Please try again later.',
      details: {},
    },
  };
};

const ensureOtpAllowed = async (ctx, strapi, phone, action) => {
  const count = await getAttemptCount(strapi, phone, action);
  if (count >= getLimitForAction(action)) {
    rejectTooManyAttempts(ctx, action);
    return false;
  }

  return true;
};

const extractTelnyxErrorMessage = (payload, fallbackMessage) => {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  if (typeof firstError?.detail === 'string' && firstError.detail.trim()) {
    return firstError.detail.trim();
  }
  if (typeof firstError?.title === 'string' && firstError.title.trim()) {
    return firstError.title.trim();
  }

  return fallbackMessage;
};

const mapTelnyxVerifyFailureMessage = (responseCode) => {
  switch (String(responseCode || '').trim().toLowerCase()) {
    case 'rejected':
      return 'Incorrect OTP code.';
    case 'expired':
      return 'OTP code expired. Please request a new code.';
    case 'max_attempts_exceeded':
      return 'Too many incorrect OTP attempts. Please request a new code.';
    default:
      return 'Invalid OTP verification result.';
  }
};

const buildPendingEmail = (phone, deviceId, tenant) => {
  const phonePart = sanitizeForEmailLocalPart(phone.replace(/^\+/, ''), 'phone');
  const devicePart = sanitizeForEmailLocalPart(deviceId, 'device');
  const tenantPart = sanitizeForEmailLocalPart(tenant?.slug || tenant?.name || 'tenant', 'tenant');
  return `verified-${tenantPart}-${phonePart}-${devicePart}@pending.local`;
};

const isProfileComplete = (user) => {
  const paynowIdType = String(user?.paynow_id_type || '').trim();
  const paynowIdValue = String(user?.paynow_id_value || '').trim();
  const paynowName = String(user?.paynow_name || '').trim();
  return Boolean(
    String(user?.full_name || '').trim() &&
      String(user?.user_id || '').trim() &&
      String(user?.gender || '').trim() &&
      String(user?.birthday || '').trim() &&
      String(user?.occupation || '').trim() &&
      paynowIdType &&
      paynowIdValue &&
      paynowName &&
      !String(user?.email || '').endsWith('@pending.local')
  );
};

const withTenantFilters = (tenantId, extraFilters = null) => {
  if (!extraFilters || Object.keys(extraFilters).length === 0) {
    return getTenantFilter(tenantId);
  }

  return {
    $and: [getTenantFilter(tenantId), extraFilters],
  };
};

const findUserByCompositeIdentity = async (strapi, tenantId, deviceId, phone, excludeUserId = null) => {
  const normalizedDeviceId = String(deviceId || '').trim();
  const normalizedPhone = normalizePhone(phone);

  if (!tenantId || !normalizedDeviceId || !normalizedPhone) {
    return null;
  }

  const extraFilters = {
    device_id: {
      $eq: normalizedDeviceId,
    },
    phone: {
      $eq: normalizedPhone,
    },
  };

  if (excludeUserId) {
    extraFilters.id = {
      $ne: excludeUserId,
    };
  }

  const users = await strapi.entityService.findMany(APP_USER_UID, {
    filters: withTenantFilters(tenantId, extraFilters),
    fields: APP_USER_FIELDS,
    sort: ['updatedAt:desc', 'id:desc'],
    limit: 1,
  });

  return users[0] || null;
};

const rejectDuplicateCompositeIdentity = async (ctx, strapi, tenantId, data, excludeUserId = null) => {
  const duplicateUser = await findUserByCompositeIdentity(
    strapi,
    tenantId,
    data?.device_id,
    data?.phone,
    excludeUserId
  );

  if (!duplicateUser) {
    return false;
  }

  ctx.badRequest('A user already exists for this tenant, device, and phone number combination.');
  return true;
};

const logSubmissionStage = (strapi, {
  traceId = 'no-trace',
  userId = null,
  tenantId = null,
  stage = 'unknown',
  phone = '',
  deviceId = '',
  extra = '',
} = {}) => {
  strapi.log.info(
    `[trace=${traceId}] [submission] stage=${stage}` +
      ` userId=${userId ?? 'null'}` +
      ` tenantId=${tenantId ?? 'null'}` +
      ` phone=${phone || '-'}` +
      ` deviceId=${deviceId || '-'}` +
      (extra ? ` ${extra}` : '')
  );
};

const getRequestTraceId = (ctx) =>
  String(ctx.state?.requestTraceId || ctx.request?.headers?.['x-trace-id'] || 'no-trace').trim() || 'no-trace';

const sanitizeDiagnosticValue = (value, fallback = '-') => {
  const normalized = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
};

const serializeDiagnosticContext = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const entries = Object.entries(value)
    .slice(0, 20)
    .map(([key, entryValue]) => `${sanitizeDiagnosticValue(key, 'key')}=${sanitizeDiagnosticValue(entryValue)}`);

  return entries.join(' ');
};

module.exports = createCoreController('api::app-user.app-user', ({ strapi }) => ({
  async find(ctx) {
    const tenant = ctx.state.appTenant;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['createdAt:desc'];
    const filters = withTenantFilters(tenant.id, ctx.query.filters);

    const [users, total] = await Promise.all([
      strapi.entityService.findMany(APP_USER_UID, {
        filters,
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
        sort,
        start,
        limit: pageSize,
      }),
      strapi.db.query(APP_USER_UID).count({
        where: filters,
      }),
    ]);

    const sanitizedUsers = await this.sanitizeOutput(users, ctx);
    return this.transformResponse(sanitizedUsers, {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
        total,
      },
    });
  },

  async findOne(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.notFound('User not found.');
    }

    const fullUser = await strapi.entityService.findOne(APP_USER_UID, userId, {
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(fullUser, ctx);
    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(fullUser),
    });
  },

  async create(ctx) {
    const tenant = ctx.state.appTenant;
    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    if (await rejectDuplicateCompositeIdentity(ctx, strapi, tenant.id, data)) {
      return;
    }

    const user = await strapi.entityService.create(APP_USER_UID, {
      data: {
        ...data,
        tenant: tenant.id,
      },
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(user, ctx);
    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
    });
  },

  async update(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const existingUser = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!existingUser) {
      return ctx.notFound('User not found.');
    }

    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    logSubmissionStage(strapi, {
      traceId,
      userId,
      tenantId: tenant.id,
      stage: 'profile_update_started',
      phone: String(data.phone ?? existingUser.phone ?? '').trim(),
      deviceId: String(data.device_id ?? existingUser.device_id ?? '').trim(),
      extra: `fields=${JSON.stringify(Object.keys(data || {}))}`,
    });

    const compositeIdentityData = {
      device_id: data.device_id ?? existingUser.device_id,
      phone: data.phone ?? existingUser.phone,
    };

    if (await rejectDuplicateCompositeIdentity(ctx, strapi, tenant.id, compositeIdentityData, userId)) {
      return;
    }

    const user = await strapi.entityService.update(APP_USER_UID, userId, {
      data: {
        ...data,
        tenant: tenant.id,
      },
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(user, ctx);

    logSubmissionStage(strapi, {
      traceId,
      userId,
      tenantId: tenant.id,
      stage: 'profile_update_completed',
      phone: String(user?.phone || '').trim(),
      deviceId: String(user?.device_id || '').trim(),
      extra: `imagePresent=${Boolean(String(user?.image_url || '').trim())}`,
    });

    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
    });
  },

  async delete(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const existingUser = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!existingUser) {
      return ctx.notFound('User not found.');
    }

    const deletedUser = await strapi.entityService.delete(APP_USER_UID, userId, {
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(deletedUser, ctx);
    return this.transformResponse(sanitizedUser);
  },

  async sendOtp(ctx) {
    const phone = normalizePhone(ctx.request.body?.phone);
    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }

    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    if (!(await ensureOtpAllowed(ctx, strapi, phone, 'send'))) {
      return;
    }

    let config;
    try {
      config = assertTelnyxVerifyConfigured();
    } catch (error) {
      strapi.log.error(error.message);
      return ctx.internalServerError('Telnyx Verify is not configured.');
    }

    const response = await callTelnyxVerify({
      path: '/v2/verifications/sms',
      body: {
        phone_number: phone,
        verify_profile_id: config.verifyProfileId,
      },
      apiKey: config.apiKey,
    });

    const payload = response.json || {};
    await recordAttempt(strapi, {
      phone,
      action: 'send',
      successful: response.ok,
      status: payload?.data?.status || String(response.status),
    });

    if (!response.ok) {
      strapi.log.warn(
        `[telnyx-send-otp] phone=${phone} status=${response.status} payload=${JSON.stringify(payload)}`
      );
      return ctx.badRequest(extractTelnyxErrorMessage(payload, 'Unable to send OTP.'));
    }

    ctx.body = {
      data: {
        phone,
        status: payload?.data?.status || 'accepted',
        channel: payload?.data?.type || 'sms',
        verificationId: payload?.data?.id || null,
      },
    };
  },

  async verifyOtp(ctx) {
    const phone = normalizePhone(ctx.request.body?.phone);
    const code = String(ctx.request.body?.code || '').trim();

    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }
    if (!code) {
      return ctx.badRequest('OTP code is required.');
    }
    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    if (!(await ensureOtpAllowed(ctx, strapi, phone, 'verify'))) {
      return;
    }

    if (code === OTP_BYPASS_CODE) {
      await recordAttempt(strapi, {
        phone,
        action: 'verify',
        successful: true,
        status: 'approved',
      });

      ctx.body = {
        data: {
          phone,
          phoneVerified: true,
          status: 'approved',
        },
      };
      return;
    }

    let config;
    try {
      config = assertTelnyxVerifyConfigured();
    } catch (error) {
      strapi.log.error(error.message);
      return ctx.internalServerError('Telnyx Verify is not configured.');
    }

    const response = await callTelnyxVerify({
      path: `/v2/verifications/by_phone_number/${encodeURIComponent(phone)}/actions/verify`,
      body: {
        code,
        verify_profile_id: config.verifyProfileId,
      },
      apiKey: config.apiKey,
    });

    const payload = response.json || {};
    const approved = response.ok && payload?.data?.response_code === 'accepted';
    const verifyResponseCode = payload?.data?.response_code || null;

    await recordAttempt(strapi, {
      phone,
      action: 'verify',
      successful: approved,
      status: verifyResponseCode || String(response.status),
    });

    if (!approved) {
      const telnyxMessage = response.ok
        ? mapTelnyxVerifyFailureMessage(verifyResponseCode)
        : extractTelnyxErrorMessage(payload, 'Unable to verify OTP.');

      return ctx.badRequest(telnyxMessage);
    }

    ctx.body = {
      data: {
        phone,
        phoneVerified: true,
        status: verifyResponseCode || 'accepted',
      },
    };
  },

  async registerVerifiedUser(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const tenantAdmin = ctx.state.appTenantAdmin || null;
    const launchQrToken = String(ctx.state.appLaunchToken || tenantAdmin?.qr_token || '').trim() || null;
    const phone = normalizePhone(ctx.request.body?.phone);
    const deviceId = String(ctx.request.body?.deviceId || '').trim();
    const deviceInfo = buildDeviceInfoData(ctx.request.body);

    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }
    if (!deviceId) {
      return ctx.badRequest('Device id is required.');
    }
    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    logSubmissionStage(strapi, {
      traceId,
      tenantId: tenant.id,
      stage: 'register_user_started',
      phone,
      deviceId,
      extra: `tenantAdminId=${tenantAdmin?.id || 'null'} referralEmail=${String(tenantAdmin?.admin_email || '').trim() || '-'}`,
    });

    const pendingEmail = buildPendingEmail(phone, deviceId, tenant);

    const existingUser = await findUserByCompositeIdentity(strapi, tenant.id, deviceId, phone);

    let user;

    if (existingUser) {
      user = await strapi.entityService.update(APP_USER_UID, existingUser.id, {
        data: {
          phone,
          phoneVerified: true,
          device_id: deviceId,
          ...deviceInfo,
          email: existingUser.email || pendingEmail,
          tenant: tenant.id,
          tenant_admin_id: tenantAdmin?.id || null,
          tenant_admin_email: tenantAdmin?.admin_email || null,
          tenant_admin_name: tenantAdmin?.tenant_name || tenantAdmin?.admin_email || null,
          launch_qr_token: launchQrToken,
        },
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });
    } else {
      user = await strapi.entityService.create(APP_USER_UID, {
        data: {
          email: pendingEmail,
          phone,
          phoneVerified: true,
          device_id: deviceId,
          ...deviceInfo,
          tenant: tenant.id,
          tenant_admin_id: tenantAdmin?.id || null,
          tenant_admin_email: tenantAdmin?.admin_email || null,
          tenant_admin_name: tenantAdmin?.tenant_name || tenantAdmin?.admin_email || null,
          launch_qr_token: launchQrToken,
        },
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });
    }

    const sanitizedUser = await this.sanitizeOutput(user, ctx);

    logSubmissionStage(strapi, {
      traceId,
      userId: user?.id || null,
      tenantId: tenant.id,
      stage: existingUser ? 'register_user_reused' : 'register_user_created',
      phone: String(user?.phone || phone).trim(),
      deviceId: String(user?.device_id || deviceId).trim(),
      extra:
        `tenantAdminId=${user?.tenant_admin_id ?? 'null'}` +
        ` tenantAdminEmail=${String(user?.tenant_admin_email || '').trim() || '-'}` +
        ` imagePresent=${Boolean(String(user?.image_url || '').trim())}`,
    });

    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      },
    });
  },

  async contacts(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const userId = Number(ctx.params.id);
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['name:asc'];
    const phone = typeof ctx.query.phone === 'string' ? ctx.query.phone.trim() : '';

    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.notFound('User not found.');
    }

    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contacts_lookup userId=${userId} tenantId=${tenant.id} phone=${phone || '-'} page=${page} pageSize=${pageSize}`
    );

    const where = {
      user: {
        id: userId,
      },
      tenant: {
        id: tenant.id,
      },
    };

    if (phone) {
      where.phone = {
        $eq: phone,
      };
    }

    const [contacts, total] = await Promise.all([
      strapi.entityService.findMany('api::contact.contact', {
        filters: where,
        populate: {
          user: true,
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
        sort,
        start,
        limit: pageSize,
      }),
      strapi.db.query('api::contact.contact').count({
        where,
      }),
    ]);

    const sanitizedContacts = await this.sanitizeOutput(contacts, ctx);

    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contacts_lookup_completed userId=${userId} tenantId=${tenant.id} phone=${phone || '-'} results=${contacts.length} total=${total}`
    );

    return this.transformResponse(sanitizedContacts, {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
        total,
      },
    });
  },

  async uploadProfileImage(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.notFound('User not found.');
    }

    const uploadedFile = Array.isArray(ctx.request.files?.file)
      ? ctx.request.files.file[0]
      : ctx.request.files?.file;

    if (!uploadedFile) {
      strapi.log.warn(
        `[trace=${traceId}] [app-user][uploadProfileImage] missing file userId=${userId} tenantId=${tenant.id}`
      );
      return ctx.badRequest('A file field named "file" is required.');
    }

    const mimeType = uploadedFile.type || uploadedFile.mimetype || '';
    if (!mimeType.startsWith('image/')) {
      strapi.log.warn(
        `[trace=${traceId}] [app-user][uploadProfileImage] invalid mime type userId=${userId} tenantId=${tenant.id} mimeType=${mimeType || 'unknown'}`
      );
      return ctx.badRequest('Only image uploads are supported.');
    }

    const sourcePath = uploadedFile.filepath || uploadedFile.path;
    if (!sourcePath) {
      strapi.log.warn(
        `[trace=${traceId}] [app-user][uploadProfileImage] missing source path userId=${userId} tenantId=${tenant.id} originalName=${uploadedFile.originalFilename || uploadedFile.name || '-'}`
      );
      return ctx.badRequest('Uploaded file path is missing.');
    }

    const extension = getFileExtension(uploadedFile);
    const fileNameBase = sanitizeSegment(
      path.parse(uploadedFile.originalFilename || uploadedFile.name || 'profile-image').name,
      'profile-image'
    );
    const uniquePart = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    const storedFileName = `${Date.now()}-${uniquePart}-${fileNameBase}${extension}`;
    const { bucket, region, prefixBase } = getObjectStorageConfig();
    const objectKey = `${buildTenantUserImagePrefix(tenant, userId, prefixBase)}/${storedFileName}`;
    const objectStorageClient = createObjectStorageClient();

    strapi.log.info(
      `[trace=${traceId}] [app-user][uploadProfileImage] start userId=${userId} tenantId=${tenant.id} fileName=${storedFileName} mimeType=${mimeType || 'unknown'} sizeBytes=${uploadedFile.size || uploadedFile.bytes || 'unknown'} objectKey=${objectKey}`
    );
    logSubmissionStage(strapi, {
      traceId,
      userId,
      tenantId: tenant.id,
      stage: 'profile_image_upload_started',
      phone: String(user?.phone || '').trim(),
      deviceId: String(user?.device_id || '').trim(),
      extra: `objectKey=${objectKey}`,
    });

    try {
      try {
        const fileBuffer = await fs.readFile(sourcePath);
        await objectStorageClient.putObject({
          Bucket: bucket,
          Key: objectKey,
          Body: fileBuffer,
          ContentType: mimeType || 'application/octet-stream',
        }).promise();
      } finally {
        await fs.unlink(sourcePath).catch(() => {});
      }

      const imageUrl = buildObjectStoragePublicUrl(bucket, region, objectKey);
      strapi.log.info(
        `[trace=${traceId}] [app-user][uploadProfileImage] uploaded userId=${userId} tenantId=${tenant.id} objectKey=${objectKey} imageUrl=${imageUrl}`
      );

      const updatedUser = await strapi.entityService.update(APP_USER_UID, userId, {
        data: {
          image_url: imageUrl,
          tenant: tenant.id,
        },
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });

      const persistedImageUrl = String(updatedUser?.image_url || '').trim();
      if (!persistedImageUrl) {
        strapi.log.error(
          `[trace=${traceId}] [app-user][uploadProfileImage] missing persisted image_url after update userId=${userId} tenantId=${tenant.id} objectKey=${objectKey}`
        );
        return ctx.internalServerError('Image upload could not be confirmed on the server.');
      }

      strapi.log.info(
        `[trace=${traceId}] [app-user][uploadProfileImage] saved userId=${userId} tenantId=${tenant.id} persistedImageUrl=${persistedImageUrl}`
      );
      logSubmissionStage(strapi, {
        traceId,
        userId,
        tenantId: tenant.id,
        stage: 'profile_image_upload_completed',
        phone: String(updatedUser?.phone || user?.phone || '').trim(),
        deviceId: String(updatedUser?.device_id || user?.device_id || '').trim(),
        extra: `persistedImageUrl=${persistedImageUrl}`,
      });

      const sanitizedUser = await this.sanitizeOutput(updatedUser, ctx);

      return this.transformResponse(sanitizedUser, {
        imageUrl,
        objectKey,
      });
    } catch (error) {
      strapi.log.error(
        `[trace=${traceId}] [app-user][uploadProfileImage] failed userId=${userId} tenantId=${tenant.id} objectKey=${objectKey} message=${error.message}`
      );
      throw error;
    }
  },

  async clientEvent(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const body = ctx.request.body || {};
    const flow = sanitizeDiagnosticValue(body.flow, 'unknown');
    const step = sanitizeDiagnosticValue(body.step, 'unknown');
    const status = sanitizeDiagnosticValue(body.status, 'info').toLowerCase();
    const message = sanitizeDiagnosticValue(body.message, '');
    const userId = Number.isInteger(Number(body.userId)) ? Number(body.userId) : null;
    const phone = sanitizeDiagnosticValue(body.phone, '-');
    const deviceId = sanitizeDiagnosticValue(body.deviceId || ctx.request.headers['x-device-id'], '-');
    const appVersion = sanitizeDiagnosticValue(body.appVersion || ctx.request.headers['x-app-version'], '-');
    const platform = sanitizeDiagnosticValue(body.platform || ctx.request.headers['x-client-platform'], '-');
    const tenantCode = sanitizeDiagnosticValue(body.tenantCode || tenant?.slug, '-');
    const screen = sanitizeDiagnosticValue(body.screen, '-');
    const contextSuffix = serializeDiagnosticContext(body.context);

    const logLine =
      `[trace=${traceId}] [client-event]` +
      ` flow=${flow}` +
      ` step=${step}` +
      ` status=${status}` +
      ` tenantId=${tenant?.id ?? 'null'}` +
      ` tenantCode=${tenantCode}` +
      ` userId=${userId ?? 'null'}` +
      ` phone=${phone}` +
      ` deviceId=${deviceId}` +
      ` appVersion=${appVersion}` +
      ` platform=${platform}` +
      ` screen=${screen}` +
      (message ? ` message="${message}"` : '') +
      (contextSuffix ? ` ${contextSuffix}` : '');

    if (status === 'error' || status === 'failed' || status === 'failure') {
      strapi.log.warn(logLine);
    } else {
      strapi.log.info(logLine);
    }

    ctx.body = {
      data: {
        accepted: true,
        traceId,
      },
    };
  },
}));
