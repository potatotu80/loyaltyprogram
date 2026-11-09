'use strict';

const AWS = require('aws-sdk');
const { format: formatCsv } = require('fast-csv');
const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const twilio = require('twilio');
const { generateTenantApiKey } = require('./utils/tenant-api-key');
const {
  buildObjectStoragePublicUrl,
  createObjectStorageClient,
  extractObjectStorageKeyFromUrl,
  getObjectStorageConfig,
} = require('./utils/object-storage');
const {
  buildTenantAdminQrCodeUrl,
  generateTenantAdminQrToken,
  getSharedAndroidApplicationId,
  getSharedDeepLinkScheme,
} = require('./utils/app-launch');
const {
  APP_ADMIN_LEADER_UID,
  APP_TENANT_ADMIN_UID,
  APP_TENANT_UID,
  APP_USER_UID,
  CONTACT_UID,
  buildTenantLocalImagePath,
  buildTenantUserImagePrefix,
  findTenantLaunchByQrToken,
  getAdminTenantContext,
  getTenantIdsFilter,
  isAdminLeaderRole,
  parsePositiveInt,
} = require('./utils/tenant-access');
const {
  completePasswordChange,
  mustChangePassword,
  removeAdminAccountSecurity,
  requirePasswordChange,
} = require('./utils/admin-account-security');
const TENANT_ADMIN_BULK_SENTINEL = '__tenant_admin_bulk__:';
const SHARED_APP_UID = 'api::shared-app.shared-app';

const parseCorsOrigins = (value) => String(value || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const scopedAdminCorsOrigins = new Set(
  parseCorsOrigins(process.env.CORS_ORIGIN).length
    ? parseCorsOrigins(process.env.CORS_ORIGIN)
    : ['https://admin.loyaltycircle.win', 'https://api.loyaltycircle.win']
);

// This middleware can return a scoped response before Strapi's CORS middleware.
// Preserve the same origin restrictions for those early responses.
const applyScopedAdminCorsHeaders = (ctx) => {
  const origin = String(ctx.get('origin') || '').trim();
  if (!origin || !scopedAdminCorsOrigins.has(origin)) {
    return;
  }

  ctx.vary('Origin');
  ctx.set('Access-Control-Allow-Origin', origin);
  ctx.set('Access-Control-Allow-Credentials', 'true');
};

const deleteUserObjectStoragePrefix = async (tenant, userId) => {
  const storageConfig = getObjectStorageConfig();
  const bucket = storageConfig.bucket;
  const region = storageConfig.region;
  const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
  const prefix = `${buildTenantUserImagePrefix(tenant, userId, prefixBase)}/`;

  if (!bucket || !region) {
    return;
  }

  const s3Client = createObjectStorageClient();
  let continuationToken;

  do {
    const listed = await s3Client.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }).promise();

    const objects = (listed.Contents || [])
      .map((item) => ({ Key: item.Key }))
      .filter((item) => item.Key);

    if (objects.length > 0) {
      await s3Client.deleteObjects({
        Bucket: bucket,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      }).promise();
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
};

const deleteUserLocalImages = async (tenant, userId) => {
  const targetDir = path.join(
    strapi.dirs.static.public,
    'uploads',
    'user-images',
    buildTenantLocalImagePath(tenant, userId)
  );

  await fs.rm(targetDir, { recursive: true, force: true });
};

const buildVoiceIdentity = (adminUser) => {
  const prefix = (process.env.TWILIO_VOICE_IDENTITY_PREFIX || 'admin').trim() || 'admin';
  return `${prefix}-${adminUser.id}`;
};

const getAdminRequestUserFromState = (ctx) => ctx.state?.user || ctx.state?.admin?.user || ctx.state?.adminUser || null;

const getAdminRequestUser = async (ctx, strapi) => {
  const adminUser = getAdminRequestUserFromState(ctx);
  if (adminUser?.id) {
    return adminUser;
  }

  const authorization = ctx.request.header?.authorization || '';
  const parts = authorization.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'bearer' || parts.length !== 2) {
    return null;
  }

  const tokenService = strapi.admin?.services?.token;
  if (!tokenService?.decodeJwtToken) {
    return null;
  }

  const { payload, isValid } = tokenService.decodeJwtToken(parts[1]);
  if (!isValid || !payload?.id) {
    return null;
  }

  return { id: payload.id };
};

const getTwilioVoiceConfig = () => ({
  accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
  apiKeySid: (process.env.TWILIO_VOICE_API_KEY_SID || '').trim(),
  apiKeySecret: (process.env.TWILIO_VOICE_API_KEY_SECRET || '').trim(),
  twimlAppSid: (process.env.TWILIO_VOICE_TWIML_APP_SID || '').trim(),
  callerId: (process.env.TWILIO_VOICE_CALLER_ID || '').trim(),
  tokenTtl: parsePositiveInt(process.env.TWILIO_VOICE_TOKEN_TTL) || 3600,
});

const createVoiceAccessToken = (adminUser) => {
  const config = getTwilioVoiceConfig();

  if (!config.accountSid || !config.apiKeySid || !config.apiKeySecret || !config.twimlAppSid || !config.callerId) {
    throw new Error(
      'Twilio Voice configuration is incomplete. Required: TWILIO_ACCOUNT_SID, ' +
      'TWILIO_VOICE_API_KEY_SID, TWILIO_VOICE_API_KEY_SECRET, TWILIO_VOICE_TWIML_APP_SID, ' +
      'TWILIO_VOICE_CALLER_ID.'
    );
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: buildVoiceIdentity(adminUser),
      ttl: config.tokenTtl,
    }
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid,
      incomingAllow: false,
    })
  );

  return {
    token: token.toJwt(),
    identity: buildVoiceIdentity(adminUser),
    callerId: config.callerId,
    expiresIn: config.tokenTtl,
  };
};

const getContentManagerSlug = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

const getContentManagerEntityId = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/[^/]+\/(\d+)/);
  return parsePositiveInt(match?.[1]);
};

const isContentManagerConfigurationRequest = (requestPath) => (
  /\/content-manager\/collection-types\/[^/]+\/configuration$/.test(String(requestPath || ''))
);

const isPasswordChangeRestrictedAdminRequest = (requestPath) => {
  const path = String(requestPath || '').replace(/^\/admin(?=\/)/, '');
  if (path === '/tenant-admin/capabilities' || path === '/admin/users/me' || path === '/admin/renew-token') {
    return false;
  }

  return (
    path.startsWith('/content-manager/') ||
    path.startsWith('/tenant-admin/') ||
    path.startsWith('/contact-export') ||
    path.startsWith('/app-user-gallery/') ||
    path.startsWith('/app-user-selfie/')
  );
};

const getContentManagerRelationParams = (requestPath) => {
  const existingMatch = requestPath.match(/^\/content-manager\/relations\/([^/]+)\/(\d+)\/([^/]+)/);
  if (existingMatch) {
    return {
      model: decodeURIComponent(existingMatch[1]),
      entityId: parsePositiveInt(existingMatch[2]),
      targetField: decodeURIComponent(existingMatch[3]),
      mode: 'existing',
    };
  }

  const availableMatch = requestPath.match(/^\/content-manager\/relations\/([^/]+)\/([^/]+)/);
  if (availableMatch) {
    return {
      model: decodeURIComponent(availableMatch[1]),
      entityId: null,
      targetField: decodeURIComponent(availableMatch[2]),
      mode: 'available',
    };
  }

  return null;
};

const getRequestData = (ctx) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    return ctx.request.body.data;
  }

  if (ctx.request.body && typeof ctx.request.body === 'object') {
    return ctx.request.body;
  }

  return null;
};

const setRequestData = (ctx, nextData) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    ctx.request.body.data = nextData;
    return;
  }

  ctx.request.body = nextData;
};

const resolveTenantRelationIds = (value) => {
  if (!value) {
    return [];
  }

  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = parsePositiveInt(value);
    return parsed ? [parsed] : [];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => parsePositiveInt(entry?.id || entry)).filter(Boolean))];
  }

  if (Array.isArray(value?.connect)) {
    return [...new Set(value.connect.map((entry) => parsePositiveInt(entry?.id || entry)).filter(Boolean))];
  }

  if (typeof value?.id === 'number' || typeof value?.id === 'string') {
    const parsed = parsePositiveInt(value.id);
    return parsed ? [parsed] : [];
  }

  return [];
};

const resolveTenantAdminBulkTenantIds = (data) => {
  const relationTenantIds = resolveTenantRelationIds(data?.tenant);
  if (relationTenantIds.length > 0) {
    return relationTenantIds;
  }

  const qrCodeUrlValue = String(data?.qr_code_url || '').trim();
  if (!qrCodeUrlValue.startsWith(TENANT_ADMIN_BULK_SENTINEL)) {
    return [];
  }

  try {
    const parsed = JSON.parse(qrCodeUrlValue.slice(TENANT_ADMIN_BULK_SENTINEL.length));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return [...new Set(parsed.map((entry) => parsePositiveInt(entry)).filter(Boolean))];
  } catch (error) {
    return [];
  }
};

const stripManagedTenantFields = (ctx, slug) => {
  if (slug !== APP_TENANT_UID) {
    return;
  }

  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'app_api_key')) {
    delete data.app_api_key;
    setRequestData(ctx, data);
  }
};

const withAdminTenantFilter = (ctx, filterOrTenantIds) => {
  const tenantFilter = Array.isArray(filterOrTenantIds)
    ? getTenantIdsFilter(filterOrTenantIds)
    : filterOrTenantIds;
  const existingFilters = ctx.query?.filters || ctx.request?.query?.filters;

  if (!existingFilters || Object.keys(existingFilters).length === 0) {
    if (!ctx.query) {
      ctx.query = {};
    }
    if (!ctx.request.query) {
      ctx.request.query = {};
    }

    ctx.query.filters = tenantFilter;
    ctx.request.query.filters = tenantFilter;
    return;
  }

  const combinedFilters = {
    $and: [existingFilters, tenantFilter],
  };

  ctx.query.filters = combinedFilters;
  ctx.request.query.filters = combinedFilters;
};

const normalizeDistinctStrings = (values) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
)];

const getScopedUserFilter = (tenantContext) => {
  const tenantIds = Array.isArray(tenantContext?.tenantIds) ? tenantContext.tenantIds : [];
  const tenantAdminIds = Array.isArray(tenantContext?.tenantAdminIds) ? tenantContext.tenantAdminIds : [];
  const tenantAdminEmails = normalizeDistinctStrings(tenantContext?.tenantAdminEmails).map((value) => value.toLowerCase());
  const ownershipFilters = [];

  if (tenantAdminIds.length) {
    // The mapping ID is immutable and prevents a removed Tenant Admin from
    // retaining access through the same email address on another mapping.
    ownershipFilters.push({ tenant_admin_id: { $in: tenantAdminIds } });
  } else if (tenantAdminEmails.length) {
    // Legacy records may predate tenant_admin_id. Use email only when no
    // mapping IDs are available for the current scoped admin.
    ownershipFilters.push({ tenant_admin_email: { $in: tenantAdminEmails } });
  }

  if (!ownershipFilters.length) {
    // A Leader may administer a tenant without yet owning a Tenant Admin team.
    // Do not expose every record in that tenant before a team mapping exists.
    if (tenantContext?.isAdminLeader) {
      return { id: { $in: [] } };
    }
    return getTenantIdsFilter(tenantIds);
  }

  return {
    $and: [
      getTenantIdsFilter(tenantIds),
      ownershipFilters.length === 1 ? ownershipFilters[0] : { $or: ownershipFilters },
    ],
  };
};

const getScopedContactFilter = (tenantContext) => {
  const tenantIds = Array.isArray(tenantContext?.tenantIds) ? tenantContext.tenantIds : [];
  const tenantAdminIds = Array.isArray(tenantContext?.tenantAdminIds) ? tenantContext.tenantAdminIds : [];
  const tenantAdminEmails = normalizeDistinctStrings(tenantContext?.tenantAdminEmails).map((value) => value.toLowerCase());
  const ownershipFilters = [];

  if (tenantAdminIds.length) {
    ownershipFilters.push({ user: { tenant_admin_id: { $in: tenantAdminIds } } });
  } else if (tenantAdminEmails.length) {
    ownershipFilters.push({ user: { tenant_admin_email: { $in: tenantAdminEmails } } });
  }

  if (!ownershipFilters.length) {
    if (tenantContext?.isAdminLeader) {
      return { id: { $in: [] } };
    }
    return getTenantIdsFilter(tenantIds);
  }

  return {
    $and: [
      getTenantIdsFilter(tenantIds),
      ownershipFilters.length === 1 ? ownershipFilters[0] : { $or: ownershipFilters },
    ],
  };
};

const getScopedAdminListFilter = (tenantContext, model) => {
  if (model === APP_USER_UID) {
    return getScopedUserFilter(tenantContext);
  }

  if (model === CONTACT_UID) {
    return getScopedContactFilter(tenantContext);
  }

  return getTenantIdsFilter(tenantContext?.tenantIds || []);
};

const buildTenantAdminOwnershipFilter = ({ adminUserId, adminEmail }) => {
  const filters = [];
  const parsedAdminUserId = parsePositiveInt(adminUserId);
  const normalizedAdminEmail = String(adminEmail || '').trim().toLowerCase();

  if (parsedAdminUserId) {
    filters.push({ admin_user_id: { $eq: parsedAdminUserId } });
  }

  if (normalizedAdminEmail) {
    filters.push({ admin_email: { $eq: normalizedAdminEmail } });
  }

  if (!filters.length) {
    return null;
  }

  return filters.length === 1 ? filters[0] : { $or: filters };
};

const assertScopedAdminRecord = async (strapi, tenantContext, model, entityId) => {
  const parsedEntityId = parsePositiveInt(entityId);
  if (!parsedEntityId) {
    return null;
  }

  if (model === APP_USER_UID) {
    const users = await strapi.entityService.findMany(APP_USER_UID, {
      filters: {
        $and: [
          { id: { $eq: parsedEntityId } },
          getScopedUserFilter(tenantContext),
        ],
      },
      fields: ['id', 'image_url', 'tenant_admin_id', 'tenant_admin_email', 'tenant_admin_name'],
      populate: {
        tenant: {
          fields: ['id', 'slug', 'name'],
        },
      },
      limit: 1,
    });

    return users[0] || null;
  }

  if (model === CONTACT_UID) {
    const contacts = await strapi.entityService.findMany(CONTACT_UID, {
      filters: {
        $and: [
          { id: { $eq: parsedEntityId } },
          getScopedContactFilter(tenantContext),
        ],
      },
      fields: ['id'],
      populate: {
        tenant: {
          fields: ['id', 'slug', 'name'],
        },
        user: {
          fields: ['id', 'tenant_admin_id', 'tenant_admin_email', 'tenant_admin_name'],
        },
      },
      limit: 1,
    });

    return contacts[0] || null;
  }

  if (model === APP_TENANT_ADMIN_UID) {
    return findScopedTenantAdminRecord({
      strapi,
      tenantContext,
      entityId: parsedEntityId,
    });
  }

  if (model === APP_TENANT_UID) {
    if (!tenantContext.tenantIds.includes(parsedEntityId)) {
      return null;
    }

    return strapi.entityService.findOne(APP_TENANT_UID, parsedEntityId, {
      fields: ['id', 'name', 'slug', 'android_application_id', 'deep_link_scheme', 'apk_url'],
      populate: {
        brand_logo: true,
      },
    });
  }

  return null;
};

const enforceTenantOnAdminBody = (ctx, tenantContext, slug) => {
  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return true;
  }

  if (slug === APP_TENANT_UID || slug === APP_TENANT_ADMIN_UID) {
    return false;
  }

  const nextData = {
    ...data,
  };

  if (tenantContext.tenantIds.length === 1) {
    nextData.tenant = tenantContext.tenantIds[0];
    setRequestData(ctx, nextData);
    return true;
  }

  const requestedTenantId = parsePositiveInt(data.tenant?.id || data.tenant);
  if (requestedTenantId && tenantContext.tenantIds.includes(requestedTenantId)) {
    setRequestData(ctx, nextData);
    return true;
  }

  return false;
};

const attachTenantScopedContentManagerControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('collection-types');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFind = controller.find.bind(controller);
  const originalFindOne = controller.findOne.bind(controller);
  const originalBulkDelete = controller.bulkDelete.bind(controller);
  const getForcedTenantPopulate = (model) => {
    if (model === APP_TENANT_ADMIN_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      };
    }

    if (model === APP_USER_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      };
    }

    if (model === CONTACT_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
        user: {
          fields: ['id', 'email', 'device_id'],
          populate: {
            tenant: {
              fields: ['id', 'name', 'slug'],
            },
          },
        },
      };
    }

    return {};
  };

  controller.find = async (ctx) => {
    const model = ctx.params?.model;
    strapi.log.info(
      `[tenant-admin][content-manager.find] model=${String(model || '-')}` +
      ` path=${String(ctx.request?.path || '-')}` +
      ` query=${JSON.stringify(ctx.request?.query || {})}`
    );
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID && model !== APP_TENANT_ADMIN_UID) {
      return originalFind(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFind(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    strapi.log.info(
      `[tenant-admin][content-manager.find] adminUser=${adminUser.id} isSuperAdmin=${tenantContext.isSuperAdmin}` +
      ` tenantIds=${JSON.stringify(tenantContext.tenantIds || [])}`
    );
    if (tenantContext.isSuperAdmin) {
      return originalFind(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    if (model === APP_TENANT_ADMIN_UID) {
      strapi.log.info(
        `[tenant-admin][content-manager.find] using scoped tenant-admin list for adminUser=${adminUser.id}`
      );
      const response = await buildScopedTenantAdminListResponse({
        strapi,
        tenantContext,
        requestQuery: ctx.request.query || {},
      });

      strapi.log.info(
        `[tenant-admin][content-manager.find] scoped tenant-admin list results=${Array.isArray(response?.results) ? response.results.length : -1}`
      );
      ctx.body = response;
      return;
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    if (model === APP_TENANT_UID) {
      const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.request.query);
      const populate = await strapi
        .plugin('content-manager')
        .service('populate-builder')(model)
        .populateDeep(1)
        .countRelations({ toOne: false, toMany: true })
        .build();

      const mergedFilters =
        permissionQuery.filters && Object.keys(permissionQuery.filters).length
          ? {
              $and: [permissionQuery.filters, { id: { $in: tenantContext.tenantIds } }],
            }
          : { id: { $in: tenantContext.tenantIds } };

      const { results, pagination } = await entityManager.findPage(
        {
          ...permissionQuery,
          filters: mergedFilters,
          populate,
        },
        model
      );

      ctx.body = {
        results,
        pagination,
      };
      return;
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.request.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateDeep(1)
      .countRelations({ toOne: false, toMany: true })
      .build();

    const mergedFilters =
      permissionQuery.filters && Object.keys(permissionQuery.filters).length
        ? {
            $and: [permissionQuery.filters, getScopedAdminListFilter(tenantContext, model)],
          }
        : getScopedAdminListFilter(tenantContext, model);

    const { results, pagination } = await entityManager.findPage(
      {
        ...permissionQuery,
        filters: mergedFilters,
        populate,
      },
      model
    );

    ctx.body = {
      results,
      pagination,
    };
  };

  controller.findOne = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID && model !== APP_TENANT_ADMIN_UID) {
      return originalFindOne(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindOne(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindOne(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(ctx.params?.id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    if (model === APP_TENANT_UID) {
      if (!tenantContext.tenantIds.includes(entityId)) {
        return ctx.forbidden('This tenant is outside your scope.');
      }

      const entity = await strapi.entityService.findOne(APP_TENANT_UID, entityId, {
        fields: Object.keys(strapi.getModel(APP_TENANT_UID)?.attributes || {}),
        populate: {
          brand_logo: true,
        },
      });

      if (!entity) {
        return ctx.notFound();
      }

      ctx.body = entity;
      return;
    }

    if (model === APP_TENANT_ADMIN_UID) {
      const scopedEntity = await findScopedTenantAdminRecord({
        strapi,
        tenantContext,
        entityId,
      });
      if (!scopedEntity) {
        return ctx.forbidden('This Tenant Admin record is outside your scope.');
      }

      const entity = await strapi.entityService.findOne(APP_TENANT_ADMIN_UID, entityId, {
        fields: TENANT_ADMIN_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });

      if (!entity) {
        return ctx.notFound();
      }

      ctx.body = entity;
      return;
    }

    const scopedEntity = await assertScopedAdminRecord(strapi, tenantContext, model, entityId);

    if (!scopedEntity) {
      return ctx.forbidden('This record is outside your tenant admin scope.');
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateFromQuery(permissionQuery)
      .populateDeep(Infinity)
      .countRelations()
      .build();

    const forcedPopulate = getForcedTenantPopulate(model);

    const entity = await entityManager.findOne(entityId, model, {
      populate: {
        ...populate,
        ...forcedPopulate,
      },
    });
    if (!entity) {
      return ctx.notFound();
    }

    ctx.body = entity;
  };

  controller.bulkDelete = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID) {
      return originalBulkDelete(ctx);
    }

    const requestedIds = Array.isArray(ctx.request?.body?.ids)
      ? [...new Set(ctx.request.body.ids.map((entry) => parsePositiveInt(entry)).filter(Boolean))]
      : [];

    if (!requestedIds.length) {
      return originalBulkDelete(ctx);
    }

    const { userAbility } = ctx.state;
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.delete()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.delete(ctx.request.query || {});
    const deletableUsers = await strapi.entityService.findMany(APP_USER_UID, {
      ...permissionQuery,
      filters: {
        $and: [{ id: { $in: requestedIds } }].concat(permissionQuery.filters || []),
      },
      fields: ['id'],
      populate: {
        tenant: {
          fields: ['id', 'slug', 'name'],
        },
      },
      limit: requestedIds.length,
    });

    const deletableUserIds = deletableUsers
      .map((entry) => parsePositiveInt(entry?.id))
      .filter(Boolean);

    if (deletableUserIds.length) {
      strapi.log.info(
        `[admin-bulk-delete] Preparing to delete users=${deletableUserIds.join(', ')} with related contacts and images.`
      );

      for (const user of deletableUsers) {
        const userId = parsePositiveInt(user?.id);
        if (!userId) {
          continue;
        }

        const tenantLabel = user?.tenant?.slug || user?.tenant?.name || `tenant-${user?.tenant?.id || 'unknown'}`;
        strapi.log.info(
          `[admin-bulk-delete] Cleaning storage for user=${userId} tenant=${tenantLabel}.`
        );
        await deleteUserObjectStoragePrefix(user?.tenant, userId);
        await deleteUserLocalImages(user?.tenant, userId);
      }

      const relatedContacts = await strapi.entityService.findMany(CONTACT_UID, {
        filters: {
          user: {
            id: {
              $in: deletableUserIds,
            },
          },
        },
        fields: ['id'],
        limit: 10000,
      });

      for (const contact of relatedContacts) {
        const contactId = parsePositiveInt(contact?.id);
        if (!contactId) {
          continue;
        }

        await strapi.entityService.delete(CONTACT_UID, contactId);
      }

      strapi.log.info(
        `[admin-bulk-delete] Deleted related contacts count=${relatedContacts.length} for users=${deletableUserIds.join(', ')}.`
      );
    }

    const response = await originalBulkDelete(ctx);
    strapi.log.info(
      `[admin-bulk-delete] Deleted users count=${response?.body?.count || response?.count || 0} requested=${requestedIds.join(', ')} permitted=${deletableUserIds.join(', ')}.`
    );
    return response;
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantScopedRelationControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('relations');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFindExisting = controller.findExisting.bind(controller);

  controller.findExisting = async (ctx) => {
    const { model, id, targetField } = ctx.params;
    const supportedModel = model === APP_USER_UID || model === CONTACT_UID;

    if (!supportedModel || targetField !== 'tenant') {
      return originalFindExisting(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindExisting(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindExisting(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    const entity = await assertScopedAdminRecord(strapi, tenantContext, model, entityId);
    if (!entity) {
      return ctx.forbidden('This record is outside your tenant admin scope.');
    }

    const tenant = entity.tenant || null;
    ctx.body = {
      data: tenant
        ? {
            id: tenant.id,
            name: tenant.name || tenant.slug || String(tenant.id),
            slug: tenant.slug || null,
          }
        : null,
    };
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantAdminPermissionExpansion = (strapi) => {
  const controller =
    strapi.admin?.controllers?.['authenticated-user'] ||
    strapi.admin?.controllers?.authenticatedUser;
  if (!controller || controller.__tenantPermissionWrapped) {
    return;
  }

  const originalGetOwnPermissions = controller.getOwnPermissions.bind(controller);
  const originalUpdateMe = controller.updateMe?.bind(controller);
  const managedSubjects = [APP_USER_UID, CONTACT_UID, APP_TENANT_UID, APP_TENANT_ADMIN_UID];
  const fieldsBySubject = Object.fromEntries(
    managedSubjects.map((uid) => [uid, Object.keys(strapi.getModel(uid)?.attributes || {})])
  );

  controller.getOwnPermissions = async (ctx) => {
    const adminUser = ctx.state?.user;
    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin || !tenantContext.tenantIds.length) {
      return originalGetOwnPermissions(ctx);
    }

    const { findUserPermissions, sanitizePermission } = strapi.admin.services.permission;
    const userPermissions = await findUserPermissions(adminUser);
    const hiddenSubjects = new Set([
      APP_TENANT_UID,
      SHARED_APP_UID,
      'plugin::upload.file',
      'plugin::upload.folder',
      ...(tenantContext.isTenantAdmin ? [APP_ADMIN_LEADER_UID] : []),
    ]);
    const hiddenActionPrefixes = ['plugin::upload.'];
    const readOnlySubjects = new Set([
      APP_USER_UID,
      CONTACT_UID,
      ...(tenantContext.isAdminLeader ? [] : [APP_TENANT_ADMIN_UID]),
    ]);
    const visiblePermissions = userPermissions.filter(
      (permission) =>
        !hiddenSubjects.has(permission.subject) &&
        !hiddenActionPrefixes.some((prefix) => String(permission.action || '').startsWith(prefix)) &&
        !(
          readOnlySubjects.has(permission.subject) &&
          ['.create', '.update', '.delete'].some((suffix) =>
            String(permission.action || '').endsWith(suffix)
          )
        )
    );

    const expandedPermissions = visiblePermissions.map((permission) => {
      if (!managedSubjects.includes(permission.subject)) {
        return permission;
      }

      const action = permission.action || '';
      if (
        !action.endsWith('.read') &&
        !action.endsWith('.create') &&
        !action.endsWith('.update')
      ) {
        return permission;
      }

      return {
        ...permission,
        properties: {
          ...(permission.properties || {}),
          fields: fieldsBySubject[permission.subject],
        },
      };
    });

    const hasTenantAdminReadPermission = expandedPermissions.some(
      (permission) =>
        permission.subject === APP_TENANT_ADMIN_UID &&
        String(permission.action || '').endsWith('.read')
    );

    if (!hasTenantAdminReadPermission) {
      const templateReadPermission = expandedPermissions.find(
        (permission) =>
          managedSubjects.includes(permission.subject) &&
          permission.subject !== APP_TENANT_ADMIN_UID &&
          permission.subject !== APP_TENANT_UID &&
          String(permission.action || '').endsWith('.read')
      );

      if (templateReadPermission) {
        expandedPermissions.push({
          ...templateReadPermission,
          subject: APP_TENANT_ADMIN_UID,
          properties: {
            ...(templateReadPermission.properties || {}),
            fields: fieldsBySubject[APP_TENANT_ADMIN_UID],
          },
        });
      }
    }

    if (tenantContext.isAdminLeader) {
      const hasTenantAdminCreatePermission = expandedPermissions.some(
        (permission) =>
          permission.subject === APP_TENANT_ADMIN_UID &&
          String(permission.action || '').endsWith('.create')
      );
      const tenantAdminReadPermission = expandedPermissions.find(
        (permission) =>
          permission.subject === APP_TENANT_ADMIN_UID &&
          String(permission.action || '').endsWith('.read')
      );

      if (!hasTenantAdminCreatePermission && tenantAdminReadPermission) {
        expandedPermissions.push({
          ...tenantAdminReadPermission,
          action: String(tenantAdminReadPermission.action).replace(/\.read$/, '.create'),
          properties: {
            ...(tenantAdminReadPermission.properties || {}),
            fields: fieldsBySubject[APP_TENANT_ADMIN_UID],
          },
        });
      }
    }

    ctx.body = {
      data: expandedPermissions.map(sanitizePermission),
    };
  };

  if (originalUpdateMe) {
      controller.updateMe = async (ctx) => {
        const adminUser = ctx.state?.user;
        const tenantContext = await getAdminTenantContext(strapi, adminUser);
        let hasPasswordChange = false;
        if (!tenantContext.isSuperAdmin && tenantContext.tenantIds.length) {
          const body =
            ctx.request?.body && typeof ctx.request.body === 'object'
              ? ctx.request.body
              : {};
          const bodyUser =
            body.user && typeof body.user === 'object'
              ? body.user
              : null;
          const bodyData =
            body.data && typeof body.data === 'object'
              ? body.data
              : null;
          const passwordBody =
            [body, bodyUser, bodyData].find((candidate) => {
              if (!candidate || typeof candidate !== 'object') {
                return false;
              }

              return ['currentPassword', 'password', 'confirmPassword'].some((key) =>
                Object.prototype.hasOwnProperty.call(candidate, key)
              );
            }) || body;
          const hasCurrentPassword = Boolean(String(passwordBody.currentPassword || '').trim());
          const hasPassword = Boolean(String(passwordBody.password || '').trim());
          const hasConfirmPassword = Boolean(String(passwordBody.confirmPassword || '').trim());
          hasPasswordChange = hasCurrentPassword && hasPassword;

          strapi.log.info(
            `[tenant-admin][updateMe] user=${adminUser?.id || 'unknown'} topKeys=${Object.keys(body).join(',') || '-'} userKeys=${Object.keys(bodyUser || {}).join(',') || '-'} dataKeys=${Object.keys(bodyData || {}).join(',') || '-'} passwordFields=${JSON.stringify({
              currentPassword: Boolean(String(passwordBody.currentPassword || '').trim()),
              password: Boolean(String(passwordBody.password || '').trim()),
              confirmPassword: hasConfirmPassword,
            })}`
          );

          if (!hasPasswordChange) {
            strapi.log.warn(
              `[tenant-admin][updateMe] blocked password-only profile save for user=${adminUser?.id || 'unknown'}`
            );
            return ctx.forbidden('Tenant admin users can only change their password.');
          }

          // Strapi may submit the rest of the profile payload together with the password form.
          // Keep tenant admins password-only by stripping the request down to password fields.
          ctx.request.body = {
            currentPassword: passwordBody.currentPassword,
            password: passwordBody.password,
          };

          if (hasConfirmPassword) {
            ctx.request.body.confirmPassword = passwordBody.confirmPassword;
          }
        }

        const response = await originalUpdateMe(ctx);
        if (hasPasswordChange && adminUser?.id) {
          const clearedRequirement = await completePasswordChange(strapi, adminUser.id);
          if (clearedRequirement) {
            strapi.log.info(`[admin-account-security] password-change-completed adminUser=${adminUser.id}`);
          }
        }
        return response;
      };
  }

  controller.__tenantPermissionWrapped = true;
};

const ensureAdminLeaderContentManagerPermissions = async (strapi) => {
  const adminLeaderRoles = (await strapi.entityService.findMany('admin::role', {
    fields: ['id', 'name', 'code'],
    limit: 1000,
  })).filter(isAdminLeaderRole);

  if (!adminLeaderRoles.length) {
    return;
  }

  const permissionDefinitions = [
    { subject: APP_USER_UID, actions: ['read'] },
    { subject: CONTACT_UID, actions: ['read'] },
    { subject: APP_TENANT_ADMIN_UID, actions: ['read', 'create', 'update'] },
  ];
  let createdCount = 0;

  for (const role of adminLeaderRoles) {
    for (const definition of permissionDefinitions) {
      const fields = Object.keys(strapi.getModel(definition.subject)?.attributes || {});
      for (const operation of definition.actions) {
        const action = `plugin::content-manager.explorer.${operation}`;
        const existingPermission = await strapi.db.query('admin::permission').findOne({
          where: {
            action,
            subject: definition.subject,
            role: {
              id: role.id,
            },
          },
          select: ['id'],
        });

        if (existingPermission) {
          continue;
        }

        await strapi.db.query('admin::permission').create({
          data: {
            action,
            subject: definition.subject,
            properties: { fields },
            conditions: [],
            role: role.id,
          },
        });
        createdCount += 1;
      }
    }
  }

  if (createdCount) {
    strapi.log.info(
      `[admin-leader][permissions] granted scoped Content Manager permissions=${createdCount}`
    );
  }
};

const backfillAdminLeaderTenants = async (strapi) => {
  const leaders = await strapi.entityService.findMany(APP_ADMIN_LEADER_UID, {
    fields: ['id'],
    populate: {
      tenants: {
        fields: ['id'],
      },
      tenant_admins: {
        fields: ['id'],
        populate: {
          tenant: {
            fields: ['id'],
          },
        },
      },
    },
    limit: 1000,
  });

  let updatedCount = 0;
  for (const leader of leaders) {
    const directTenantIds = new Set(
      (leader.tenants || []).map((tenant) => parsePositiveInt(tenant?.id)).filter(Boolean)
    );
    const legacyTenantIds = (leader.tenant_admins || [])
      .map((tenantAdmin) => parsePositiveInt(tenantAdmin?.tenant?.id))
      .filter(Boolean);
    const missingTenantIds = [...new Set(legacyTenantIds)].filter((id) => !directTenantIds.has(id));

    if (!missingTenantIds.length) {
      continue;
    }

    await strapi.entityService.update(APP_ADMIN_LEADER_UID, leader.id, {
      data: {
        tenants: {
          connect: missingTenantIds.map((id) => ({ id })),
        },
      },
    });
    updatedCount += 1;
  }

  if (updatedCount) {
    strapi.log.info(`[admin-leader][tenant-backfill] updated leaders=${updatedCount}`);
  }
};

const syncAdminLeaderListConfiguration = async (strapi) => {
  const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
  if (!contentTypesService) {
    return;
  }

  const adminLeaderContentType = contentTypesService.findContentType(APP_ADMIN_LEADER_UID);
  if (!adminLeaderContentType) {
    return;
  }

  const configuration = await contentTypesService.findConfiguration(adminLeaderContentType);
  const nextConfiguration = {
    ...configuration,
    settings: {
      ...(configuration.settings || {}),
      mainField: 'name',
      defaultSortBy: 'id',
      defaultSortOrder: 'DESC',
    },
    layouts: {
      ...(configuration.layouts || {}),
      list: ['name', 'admin_email'],
    },
    metadatas: {
      ...(configuration.metadatas || {}),
      name: {
        ...(configuration.metadatas?.name || {}),
        list: {
          ...(configuration.metadatas?.name?.list || {}),
          label: 'Leader Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.name?.edit || {}),
          label: 'Leader Name',
        },
      },
      admin_email: {
        ...(configuration.metadatas?.admin_email || {}),
        list: {
          ...(configuration.metadatas?.admin_email?.list || {}),
          label: 'Admin Email',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.admin_email?.edit || {}),
          label: 'Admin Email',
        },
      },
    },
  };

  await contentTypesService.updateConfiguration(adminLeaderContentType, nextConfiguration);
};

const syncTenantAdminListConfiguration = async (strapi) => {
  const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
  if (!contentTypesService) {
    return;
  }

  const tenantAdminContentType = contentTypesService.findContentType(APP_TENANT_ADMIN_UID);
  if (!tenantAdminContentType) {
    return;
  }

  const configuration = await contentTypesService.findConfiguration(tenantAdminContentType);
  const desiredListLayout = ['tenant_name', 'tenant', 'admin_email', 'qr_code_url'];
  const nextConfiguration = {
    ...configuration,
    settings: {
      ...(configuration.settings || {}),
      mainField: 'tenant_name',
      defaultSortBy: 'id',
      defaultSortOrder: 'DESC',
    },
    layouts: {
      ...(configuration.layouts || {}),
      list: desiredListLayout,
    },
    metadatas: {
      ...(configuration.metadatas || {}),
      tenant_name: {
        ...(configuration.metadatas?.tenant_name || {}),
        list: {
          ...(configuration.metadatas?.tenant_name?.list || {}),
          label: 'Tenant Admin Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.tenant_name?.edit || {}),
          label: 'Tenant Admin Name',
        },
      },
      tenant: {
        ...(configuration.metadatas?.tenant || {}),
        list: {
          ...(configuration.metadatas?.tenant?.list || {}),
          label: 'Linked Tenant',
        },
        edit: {
          ...(configuration.metadatas?.tenant?.edit || {}),
          label: 'Linked Tenant',
          mainField: 'name',
        },
      },
      admin_leader: {
        ...(configuration.metadatas?.admin_leader || {}),
        edit: {
          ...(configuration.metadatas?.admin_leader?.edit || {}),
          label: 'Leader Name',
          mainField: 'name',
        },
      },
      admin_email: {
        ...(configuration.metadatas?.admin_email || {}),
        list: {
          ...(configuration.metadatas?.admin_email?.list || {}),
          label: 'Admin Email',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.admin_email?.edit || {}),
          label: 'Admin Email',
        },
      },
      qr_code_url: {
        ...(configuration.metadatas?.qr_code_url || {}),
        list: {
          ...(configuration.metadatas?.qr_code_url?.list || {}),
          label: 'QR URL',
          searchable: false,
          sortable: false,
        },
        edit: {
          ...(configuration.metadatas?.qr_code_url?.edit || {}),
          label: 'QR URL',
        },
      },
      qr_token: {
        ...(configuration.metadatas?.qr_token || {}),
        edit: {
          ...(configuration.metadatas?.qr_token?.edit || {}),
          label: 'QR Token',
        },
      },
    },
  };

  await contentTypesService.updateConfiguration(tenantAdminContentType, nextConfiguration);
};

const syncAppUserListConfiguration = async (strapi) => {
  const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
  if (!contentTypesService) {
    return;
  }

  const appUserContentType = contentTypesService.findContentType(APP_USER_UID);
  if (!appUserContentType) {
    return;
  }

  const configuration = await contentTypesService.findConfiguration(appUserContentType);
  const desiredListLayout = ['email', 'phone', 'tenant', 'tenant_admin_name'];
  const nextConfiguration = {
    ...configuration,
    settings: {
      ...(configuration.settings || {}),
      mainField: 'email',
      defaultSortBy: 'id',
      defaultSortOrder: 'ASC',
    },
    layouts: {
      ...(configuration.layouts || {}),
      list: desiredListLayout,
    },
    metadatas: {
      ...(configuration.metadatas || {}),
      email: {
        ...(configuration.metadatas?.email || {}),
        list: {
          ...(configuration.metadatas?.email?.list || {}),
          label: 'Email',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.email?.edit || {}),
          label: 'Email',
        },
      },
      phone: {
        ...(configuration.metadatas?.phone || {}),
        list: {
          ...(configuration.metadatas?.phone?.list || {}),
          label: 'Phone',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.phone?.edit || {}),
          label: 'Phone',
        },
      },
      device_id: {
        ...(configuration.metadatas?.device_id || {}),
        edit: {
          ...(configuration.metadatas?.device_id?.edit || {}),
          label: 'Device ID',
        },
      },
      device_manufacturer: {
        ...(configuration.metadatas?.device_manufacturer || {}),
        edit: {
          ...(configuration.metadatas?.device_manufacturer?.edit || {}),
          label: 'Device Manufacturer',
        },
      },
      device_brand: {
        ...(configuration.metadatas?.device_brand || {}),
        edit: {
          ...(configuration.metadatas?.device_brand?.edit || {}),
          label: 'Device Brand',
        },
      },
      device_model: {
        ...(configuration.metadatas?.device_model || {}),
        edit: {
          ...(configuration.metadatas?.device_model?.edit || {}),
          label: 'Device Model',
        },
      },
      device_name: {
        ...(configuration.metadatas?.device_name || {}),
        edit: {
          ...(configuration.metadatas?.device_name?.edit || {}),
          label: 'Device Name',
        },
      },
      android_version: {
        ...(configuration.metadatas?.android_version || {}),
        edit: {
          ...(configuration.metadatas?.android_version?.edit || {}),
          label: 'Android Version',
        },
      },
      android_sdk_int: {
        ...(configuration.metadatas?.android_sdk_int || {}),
        edit: {
          ...(configuration.metadatas?.android_sdk_int?.edit || {}),
          label: 'Android SDK',
        },
      },
      app_version: {
        ...(configuration.metadatas?.app_version || {}),
        edit: {
          ...(configuration.metadatas?.app_version?.edit || {}),
          label: 'App Version',
        },
      },
      tenant: {
        ...(configuration.metadatas?.tenant || {}),
        list: {
          ...(configuration.metadatas?.tenant?.list || {}),
          label: 'Tenant',
        },
        edit: {
          ...(configuration.metadatas?.tenant?.edit || {}),
          label: 'Tenant',
          mainField: 'name',
        },
      },
      tenant_admin_name: {
        ...(configuration.metadatas?.tenant_admin_name || {}),
        list: {
          ...(configuration.metadatas?.tenant_admin_name?.list || {}),
          label: 'Tenant Admin Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.tenant_admin_name?.edit || {}),
          label: 'Tenant Admin Name',
        },
      },
    },
  };

  await contentTypesService.updateConfiguration(appUserContentType, nextConfiguration);
};

const syncContactListConfiguration = async (strapi) => {
  const contentTypesService = strapi.plugin('content-manager')?.service('content-types');
  if (!contentTypesService) {
    return;
  }

  const contactContentType = contentTypesService.findContentType(CONTACT_UID);
  if (!contactContentType) {
    return;
  }

  const configuration = await contentTypesService.findConfiguration(contactContentType);
  const desiredListLayout = ['name', 'phone', 'tenant', 'tenant_admin_name'];
  const nextConfiguration = {
    ...configuration,
    settings: {
      ...(configuration.settings || {}),
      mainField: 'name',
      defaultSortBy: 'id',
      defaultSortOrder: 'DESC',
    },
    layouts: {
      ...(configuration.layouts || {}),
      list: desiredListLayout,
    },
    metadatas: {
      ...(configuration.metadatas || {}),
      name: {
        ...(configuration.metadatas?.name || {}),
        list: {
          ...(configuration.metadatas?.name?.list || {}),
          label: 'Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.name?.edit || {}),
          label: 'Name',
        },
      },
      phone: {
        ...(configuration.metadatas?.phone || {}),
        list: {
          ...(configuration.metadatas?.phone?.list || {}),
          label: 'Phone',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.phone?.edit || {}),
          label: 'Phone',
        },
      },
      tenant: {
        ...(configuration.metadatas?.tenant || {}),
        list: {
          ...(configuration.metadatas?.tenant?.list || {}),
          label: 'Tenant',
        },
        edit: {
          ...(configuration.metadatas?.tenant?.edit || {}),
          label: 'Tenant',
          mainField: 'name',
        },
      },
      tenant_admin_name: {
        ...(configuration.metadatas?.tenant_admin_name || {}),
        list: {
          ...(configuration.metadatas?.tenant_admin_name?.list || {}),
          label: 'Tenant Admin Name',
          searchable: true,
          sortable: true,
        },
        edit: {
          ...(configuration.metadatas?.tenant_admin_name?.edit || {}),
          label: 'Tenant Admin Name',
        },
      },
    },
  };

  await contentTypesService.updateConfiguration(contactContentType, nextConfiguration);
};

const backfillContactTenantAdminNames = async (strapi) => {
  const contactsNeedingBackfill = await strapi.entityService.findMany(CONTACT_UID, {
    filters: {
      tenant_admin_name: {
        $null: true,
      },
    },
    fields: ['id'],
    populate: {
      user: {
        fields: ['tenant_admin_name'],
      },
    },
    limit: 500,
  });

  for (const contact of contactsNeedingBackfill) {
    const tenantAdminName = String(contact?.user?.tenant_admin_name || '').trim();
    if (!tenantAdminName) {
      continue;
    }

    await strapi.entityService.update(CONTACT_UID, contact.id, {
      data: {
        tenant_admin_name: tenantAdminName,
      },
    });
  }
};

const getTenantAdminScopeFilter = (tenantContext) => {
  const tenantAdminIds = Array.isArray(tenantContext?.tenantAdminIds)
    ? tenantContext.tenantAdminIds.map((entry) => parsePositiveInt(entry)).filter(Boolean)
    : [];

  return tenantAdminIds.length
    ? { id: { $in: tenantAdminIds } }
    : null;
};

// Production records predate Strapi's camel-case audit columns. Select only
// actual Tenant Admin fields instead of asking Entity Service for every model attribute.
const TENANT_ADMIN_FIELDS = [
  'id',
  'admin_user_id',
  'admin_email',
  'tenant_name',
  'qr_token',
  'qr_code_url',
  'role',
  'created_at',
  'updated_at',
];

const getScopedTenantAdminListSort = (value) => {
  const [requestedField, requestedDirection] = String(value || 'id:DESC').split(':');
  const allowedFields = new Set(['id', 'tenant_name', 'admin_email']);
  const field = allowedFields.has(requestedField) ? requestedField : 'id';
  const direction = String(requestedDirection || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  // Entity Service accepts an object sort reliably across Strapi 4.x releases.
  return { [field]: direction };
};

const buildScopedTenantAdminListResponse = async ({ strapi, tenantContext, requestQuery }) => {
  const scopeFilter = getTenantAdminScopeFilter(tenantContext);
  if (!scopeFilter) {
    const emptyPageSize = Math.max(1, Math.min(100, Number(requestQuery?.pageSize) || 10));
    return {
      results: [],
      pagination: {
        page: 1,
        pageSize: emptyPageSize,
        pageCount: 0,
        total: 0,
      },
    };
  }

  const mergedFilters =
    requestQuery?.filters && Object.keys(requestQuery.filters).length
      ? {
          $and: [
            requestQuery.filters,
            scopeFilter,
          ],
        }
      : {
          $and: [
            scopeFilter,
          ],
        };

  const page = Math.max(1, Number(requestQuery?.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(requestQuery?.pageSize) || 10));
  const start = (page - 1) * pageSize;
  const sort = getScopedTenantAdminListSort(requestQuery?.sort);

  try {
    const [results, totalEntries] = await Promise.all([
      strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
        filters: mergedFilters,
        sort,
        start,
        limit: pageSize,
        fields: TENANT_ADMIN_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      }),
      strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
        filters: mergedFilters,
        fields: ['id'],
        limit: 10000,
      }),
    ]);
    const total = Array.isArray(totalEntries) ? totalEntries.length : 0;

    return {
      results,
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
        total,
      },
    };
  } catch (error) {
    strapi.log.error(
      `[tenant-admin][scoped-list] failed leaderIds=${JSON.stringify(tenantContext?.adminLeaderIds || [])}` +
      ` tenantAdminIds=${JSON.stringify(tenantContext?.tenantAdminIds || [])}` +
      ` tenantIds=${JSON.stringify(tenantContext?.tenantIds || [])}` +
      ` sort=${JSON.stringify(sort)} error=${error?.stack || error?.message || String(error)}`
    );
    throw error;
  }
};

const findScopedTenantAdminRecord = async ({ strapi, tenantContext, entityId }) => {
  const scopeFilter = getTenantAdminScopeFilter(tenantContext);
  if (!scopeFilter) {
    return null;
  }

  const results = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
    filters: {
      $and: [
        {
          id: {
            $eq: entityId,
          },
        },
        scopeFilter,
      ],
    },
    populate: {
      tenant: {
        fields: ['id', 'name', 'slug'],
      },
    },
    limit: 1,
  });

  return results[0] || null;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const ensureAbsoluteUrl = (value) => {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized) ? normalized : '';
};

const buildTenantAdminReferralCode = ({ tenantCode, tenantAdminName }) => {
  const normalizedTenantCode = String(tenantCode || '').trim();
  const normalizedTenantAdminName = String(tenantAdminName || '').trim();
  if (!normalizedTenantCode || !normalizedTenantAdminName) {
    return '';
  }

  return `${normalizedTenantCode}${normalizedTenantAdminName}`;
};

const getTenantDeepLinkScheme = (tenant) => {
  const configuredScheme = String(tenant?.android_deep_link_scheme || '').trim();
  if (!configuredScheme) {
    return getSharedDeepLinkScheme();
  }

  return configuredScheme
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || getSharedDeepLinkScheme();
};

const getTenantAndroidApplicationId = (tenant) =>
  String(tenant?.android_application_id || '').trim()
  || getSharedAndroidApplicationId();

const buildTenantDeepLinkUrl = ({ tenant, tenantCode, referralCode, qrToken }) => {
  const scheme = getTenantDeepLinkScheme(tenant);
  if (!scheme) {
    return '';
  }

  const params = new URLSearchParams();
  if (qrToken) {
    params.set('qrToken', qrToken);
  }
  if (tenantCode) {
    params.set('tenantCode', tenantCode);
  }
  if (referralCode) {
    params.set('referralCode', referralCode);
  }

  const query = params.toString();
  return `${scheme}://open${query ? `?${query}` : ''}`;
};

const buildTenantIntentUrl = ({ tenant, tenantCode, referralCode, qrToken }) => {
  const scheme = getTenantDeepLinkScheme(tenant);
  const packageName = getTenantAndroidApplicationId(tenant);
  if (!scheme || !packageName) {
    return '';
  }

  const params = new URLSearchParams();
  if (qrToken) {
    params.set('qrToken', qrToken);
  }
  if (tenantCode) {
    params.set('tenantCode', tenantCode);
  }
  if (referralCode) {
    params.set('referralCode', referralCode);
  }

  const query = params.toString();
  return `intent://open${query ? `?${query}` : ''}#Intent;scheme=${encodeURIComponent(scheme)};package=${encodeURIComponent(packageName)};end`;
};

const renderQrLandingHtml = ({ tenant, tenantCode, referralCode, qrCodeUrl, qrToken, isAndroidRequest }) => {
  const appName = escapeHtml(tenant?.app_display_name || tenant?.name || 'Loyalty Circle');
  const primaryColor = /^#[0-9A-Fa-f]{6}$/.test(String(tenant?.primary_color || '').trim())
    ? tenant.primary_color
    : '#2F6BFF';
  const resolvedReferralCode = String(referralCode || '').trim();
  const installUrl = ensureAbsoluteUrl(tenant?.android_apk_url);
  const deepLinkUrl = buildTenantDeepLinkUrl({ tenant, tenantCode, referralCode: resolvedReferralCode, qrToken });
  const intentUrl = buildTenantIntentUrl({ tenant, tenantCode, referralCode: resolvedReferralCode, qrToken });
  const safeMessage = escapeHtml('Please open this link on an Android device.');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName} | Open App</title>
    <style>
      :root {
        --primary: ${escapeHtml(primaryColor)};
        --text: #f4f2e8;
        --muted: #a5aa9c;
        --surface: #1a201e;
        --border: rgba(244, 242, 232, 0.14);
        --bg: #0a0e0d;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background: var(--bg);
        display: flex;
        padding: 0;
        overflow-x: hidden;
      }
      .card {
        width: min(100%, 680px);
        min-height: 100vh;
        margin: 0 auto;
        padding: 28px 24px 48px;
        background: linear-gradient(160deg, #101614 0%, #0a0e0d 65%);
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .brand-row {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: "Segoe UI", sans-serif;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .1em;
        text-transform: uppercase;
      }
      .brand-mark {
        display: inline-grid;
        place-items: center;
        width: 36px;
        height: 36px;
        background: #d7ff5f;
        color: #101614;
        border-radius: 50%;
        font-size: 10px;
      }
      .brand-name { color: #f4f2e8; }
      .member-tag { margin-left: auto; color: var(--muted); font-size: 9px; }
      .pass-number {
        margin: 54px 0 -16px;
        color: rgba(215,255,95,.2);
        font-family: "Segoe UI", sans-serif;
        font-size: clamp(130px, 38vw, 210px);
        font-weight: 900;
        letter-spacing: -.12em;
        line-height: .8;
        text-align: right;
      }
      .intro { margin-top: 22px; max-width: 34ch; font-size: 18px; }
      .pathway {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 42px 0 28px;
        padding: 14px 0;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        color: #f4f2e8;
        font-family: "Segoe UI", sans-serif;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .05em;
      }
      .pathway span { flex: 1; }
      .pathway i { width: 22px; height: 1px; background: #d7ff5f; opacity: .65; }
      .pathway small { color: var(--muted); font-size: 8px; letter-spacing: .12em; }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #d7ff5f;
        font-weight: 700;
      }
      h1 {
        margin: 0;
        font-size: clamp(42px, 12vw, 70px);
        line-height: .94;
        letter-spacing: -.06em;
      }
      p {
        margin: 0;
        line-height: 1.55;
        color: var(--muted);
      }
      .status {
        margin-top: 18px;
        font-family: "Segoe UI", sans-serif;
        font-size: 13px;
      }
      .action-box {
        display: none;
        margin-top: 12px;
      }
      .install-button {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 58px;
        padding: 16px 18px;
        border-radius: 4px;
        background: #d7ff5f;
        color: #101614;
        text-decoration: none;
        font-family: "Segoe UI", sans-serif;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .08em;
      }
      .install-button.secondary {
        background: transparent;
        color: #f4f2e8;
        border: 1px solid var(--border);
      }
      .hint {
        margin-top: 12px;
        font-size: 13px;
      }
      .referral-box {
        margin-top: 18px;
        padding: 16px;
        border-radius: 4px;
        background: rgba(255,255,255,.04);
        border: 1px solid var(--border);
      }
      .referral-title {
        margin: 0 0 6px;
        font-size: 14px;
        font-weight: 700;
        color: #f4f2e8;
      }
      .referral-copy-row {
        margin-top: 12px;
      }
      .referral-code {
        width: 100%;
        margin: 0;
        padding: 12px 14px;
        border-radius: 2px;
        background: transparent;
        border: 1px solid var(--border);
        color: #d7ff5f;
        font-weight: 700;
        font: inherit;
        -webkit-user-select: all;
        user-select: all;
      }
        code {
          display: block;
          margin-top: 20px;
          padding: 12px 14px;
          border-radius: 12px;
          background: #f5f7fb;
          color: #34415e;
          word-break: break-all;
        }
        .debug {
          margin-top: 18px;
          padding: 12px 14px;
          border-radius: 12px;
          background: #f5f7fb;
          border: 1px solid var(--border);
        }
        .debug strong {
          display: block;
          margin-bottom: 8px;
          color: var(--text);
        }
        .debug ul {
          margin: 0;
          padding-left: 18px;
          color: #34415e;
        }
        .debug li {
          margin: 6px 0;
          word-break: break-all;
        }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand-row">
        <span class="brand-mark">LC</span>
        <span class="brand-name">${appName}</span>
        <span class="member-tag">MEMBER ACCESS</span>
      </div>
      <div class="pass-number">01</div>
      <p class="eyebrow">YOUR DIGITAL MEMBER PASS</p>
      <h1>Step inside<br/>your circle.</h1>
      <p class="intro" id="message">Open your secure member pass to continue your loyalty journey.</p>
      <div class="pathway" aria-hidden="true">
        <span>01<br/><small>VERIFY</small></span><i></i><span>02<br/><small>CONNECT</small></span><i></i><span>03<br/><small>UNLOCK</small></span>
      </div>
        ${resolvedReferralCode ? `
          <div class="referral-box">
            <p class="referral-title">Your member invitation</p>
            <p>Keep this access code. You may need it after installation.</p>
        <div class="referral-copy-row">
          <input class="referral-code" id="referralCodeValue" type="text" readonly value="${escapeHtml(resolvedReferralCode)}" />
        </div>
      </div>` : ''}
      <p class="status" id="status"></p>
      <div class="action-box" id="openAppBox" style="${(intentUrl || deepLinkUrl) ? 'display:block;' : 'display:none;'}">
        <a class="install-button" id="openIntentButton" href="${escapeHtml(intentUrl || deepLinkUrl)}">Enter loyalty circle</a>
      </div>
      <div class="action-box" id="installBox" style="${installUrl ? 'display:block;' : 'display:none;'}">
        <a class="install-button secondary" id="installButton" href="${escapeHtml(installUrl)}" download>Get the member app</a>
      </div>
      </main>
      <script>
        (function () {
          var userAgent = navigator.userAgent || "";
          var userAgentDataPlatform = navigator.userAgentData && navigator.userAgentData.platform
            ? String(navigator.userAgentData.platform)
            : "";
          var platform = navigator.platform || "";
          var isAndroid = /Android/i.test(userAgent)
            || /Android/i.test(userAgentDataPlatform)
            || /Linux armv/i.test(platform);
          var installUrl = ${JSON.stringify(installUrl)};
          var deepLinkUrl = ${JSON.stringify(deepLinkUrl)};
          var intentUrl = ${JSON.stringify(intentUrl)};
          var installBox = document.getElementById("installBox");
          var installButton = document.getElementById("installButton");
          var openAppBox = document.getElementById("openAppBox");
          var openIntentButton = document.getElementById("openIntentButton");
          var referralCodeValue = document.getElementById("referralCodeValue");
          var message = document.getElementById("message");
          var status = document.getElementById("status");
          var hasLeftPage = false;
          var fallbackDelayMs = 2000;

          var showInstallFallback = function () {
            if (installBox) {
              installBox.style.display = installUrl ? "block" : "none";
            }
            if (installButton) {
              installButton.style.display = installUrl ? "inline-flex" : "none";
            }
          };

          if (openAppBox && (intentUrl || deepLinkUrl)) {
            openAppBox.style.display = "block";
          }
          if (openIntentButton) {
            openIntentButton.style.display = (intentUrl || deepLinkUrl) ? "inline-flex" : "none";
          }

          if (!deepLinkUrl) {
            message.textContent = "This app link is missing QR launch metadata.";
            showInstallFallback();
            if (openAppBox) {
              openAppBox.style.display = "none";
            }
            return;
          }

          if (!installUrl) {
            message.textContent = "This tenant is missing an APK download URL.";
            if (installButton) {
              installButton.style.display = "none";
            }
          }

          if (!isAndroid) {
            message.textContent = ${JSON.stringify(safeMessage)};
          }

          status.textContent = installUrl
            ? "Trying to open the app now. If it stays on this page, use Open app."
            : "Trying to open the app now. This tenant currently has no APK download URL configured.";

          if (referralCodeValue) {
            var selectReferralCode = function () {
              referralCodeValue.focus();
              referralCodeValue.select();
              referralCodeValue.setSelectionRange(0, referralCodeValue.value.length);
            };

            referralCodeValue.addEventListener("focus", selectReferralCode);
            referralCodeValue.addEventListener("click", selectReferralCode);
            referralCodeValue.addEventListener("touchstart", function () {
              window.setTimeout(selectReferralCode, 0);
            }, { passive: true });
          }

          document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden") {
              hasLeftPage = true;
            }
          });

          window.addEventListener("pagehide", function () {
            hasLeftPage = true;
          });

          if (isAndroid && (intentUrl || deepLinkUrl)) {
            window.setTimeout(function () {
              try {
                window.location.href = intentUrl || deepLinkUrl;
              } catch (error) {
                // ignore browser deep-link failures and let the fallback appear
              }
            }, 150);
          }

          window.setTimeout(function () {
            if (!hasLeftPage) {
              showInstallFallback();
            }
          }, fallbackDelayMs);
      })();
    </script>
  </body>
</html>`;
};

const findSharedAppConfig = async (strapi) =>
  strapi.db.query(SHARED_APP_UID).findOne({
    select: [
      'id',
      'android_apk_url',
      'android_latest_version_code',
      'android_latest_version_name',
      'android_force_update',
      'enable_twilio_voice_panel',
      'enable_tenant_admin_contact_export',
    ],
  });

const normalizeExportSelectedIds = (value) => {
  if (!value) {
    return [];
  }

  const candidates = Array.isArray(value)
    ? value
    : String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

  return [...new Set(candidates.map((entry) => parsePositiveInt(entry)).filter(Boolean))];
};

const sanitizeCsvCell = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).replace(/\r?\n/g, ' ').trim();
};

const buildContactExportFilename = ({ isScopedExport, isAdminLeader }) => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now
    .toTimeString()
    .slice(0, 8)
    .replace(/:/g, '-');
  if (isAdminLeader) {
    return `contacts-export-admin-leader-${date}_${time}.csv`;
  }

  return isScopedExport
    ? `contacts-export-tenant-admin-${date}_${time}.csv`
    : `contacts-export-${date}_${time}.csv`;
};

const streamContactsCsvExport = async ({ ctx, strapi, adminUser, tenantContext }) => {
  const sharedApp = await findSharedAppConfig(strapi);
  const isScopedExport = !tenantContext.isSuperAdmin && tenantContext.tenantIds.length > 0;
  const isTenantAdminExport = isScopedExport && !tenantContext.isAdminLeader;

  if (isTenantAdminExport && sharedApp?.enable_tenant_admin_contact_export === false) {
    return ctx.forbidden('Contact export is disabled for Tenant Admin users.');
  }

  const { userAbility } = ctx.state;
  const permissionChecker = strapi
    .plugin('content-manager')
    .service('permission-checker')
    .create({ userAbility, model: CONTACT_UID });

  if (permissionChecker.cannot.read()) {
    return ctx.forbidden();
  }

  const rawQuery = { ...(ctx.request?.query || {}) };
  const selectedIds = normalizeExportSelectedIds(rawQuery.selectedIds);
  delete rawQuery.selectedIds;
  delete rawQuery.page;
  delete rawQuery.pageSize;
  delete rawQuery.start;
  delete rawQuery.limit;

  const permissionQuery = await permissionChecker.sanitizedQuery.read(rawQuery);
  let mergedFilters =
    permissionQuery.filters && Object.keys(permissionQuery.filters).length
      ? permissionQuery.filters
      : null;

  if (isScopedExport) {
    const scopedFilter = getScopedContactFilter(tenantContext);
    mergedFilters = mergedFilters
      ? { $and: [mergedFilters, scopedFilter] }
      : scopedFilter;
  }

  if (selectedIds.length) {
    const selectedFilter = { id: { $in: selectedIds } };
    mergedFilters = mergedFilters
      ? { $and: [mergedFilters, selectedFilter] }
      : selectedFilter;
  }

  const sort = permissionQuery.sort || ['id:desc'];
  const filename = buildContactExportFilename({
    isScopedExport,
    isAdminLeader: tenantContext.isAdminLeader,
  });
  const csvStream = formatCsv({ headers: true, writeBOM: true });

  ctx.set('Content-Type', 'text/csv; charset=utf-8');
  ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
  ctx.status = 200;
  ctx.body = csvStream;

  let start = 0;
  const limit = 500;
  let exportedCount = 0;

  try {
    while (true) {
      const batch = await strapi.entityService.findMany(CONTACT_UID, {
        filters: mergedFilters || undefined,
        sort,
        start,
        limit,
        fields: [
          'id',
          'name',
          'phone',
          'email',
          'user_email',
          'user_phone',
          'tenant_admin_name',
          'createdAt',
          'updatedAt',
        ],
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
          user: {
            fields: ['id', 'email', 'phone'],
          },
        },
      });

      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }

      for (const contact of batch) {
        csvStream.write({
          'Contact ID': sanitizeCsvCell(contact?.id),
          Name: sanitizeCsvCell(contact?.name),
          Phone: sanitizeCsvCell(contact?.phone),
          Email: sanitizeCsvCell(contact?.email),
          Tenant: sanitizeCsvCell(contact?.tenant?.name || contact?.tenant?.slug),
          'Tenant Admin Name': sanitizeCsvCell(contact?.tenant_admin_name),
          'Linked User Email': sanitizeCsvCell(contact?.user_email || contact?.user?.email),
          'Linked User Phone': sanitizeCsvCell(contact?.user_phone || contact?.user?.phone),
          'Created At': sanitizeCsvCell(contact?.createdAt),
          'Updated At': sanitizeCsvCell(contact?.updatedAt),
        });
        exportedCount += 1;
      }

      start += batch.length;
      if (batch.length < limit) {
        break;
      }
    }

    strapi.log.info(
      `[contact-export] adminUser=${adminUser.id} isSuperAdmin=${tenantContext.isSuperAdmin}` +
      ` isAdminLeader=${tenantContext.isAdminLeader} selectedIds=${selectedIds.length} exported=${exportedCount}`
    );
  } catch (error) {
    strapi.log.error(
      `[contact-export] Failed export for adminUser=${adminUser?.id || 'unknown'}: ${error.message}`
    );
    csvStream.destroy(error);
    return;
  }

  csvStream.end();
};

const PRIVACY_POLICY_SECTIONS = [
  {
    title: '1. Information We Collect',
    paragraphs: [
      'The app may collect the following information with user permission:',
    ],
    items: [
      'Contacts: to allow users to access and manage their contact list within the app',
      'Photos/Media: to allow users to select and upload images',
      'Basic device information (e.g. device ID) for app functionality',
    ],
    closing: 'We only access this data after the user grants explicit permission.',
  },
  {
    title: '2. How We Use Information',
    paragraphs: [
      'We use the collected information to:',
    ],
    items: [
      'Provide and improve app functionality',
      'Enable features such as contact management and media uploads',
      'Store selected data securely on our servers',
    ],
    closing: 'We do not sell or share user data with third parties for marketing purposes.',
  },
  {
    title: '3. Data Storage and Security',
    paragraphs: [
      'User data may be stored on secure servers, including cloud services. We take reasonable measures to protect data from unauthorized access, loss, or misuse.',
    ],
  },
  {
    title: '4. User Control',
    paragraphs: [
      'Users can:',
    ],
    items: [
      'Grant or revoke permissions at any time through device settings',
      'Stop using the app to prevent further data collection',
    ],
  },
  {
    title: '5. Third-Party Services',
    paragraphs: [
      'The app may use third-party services (e.g. cloud storage providers) to store and process data.',
    ],
  },
  {
    title: '6. Changes to This Policy',
    paragraphs: [
      'We may update this Privacy Policy from time to time. Updates will be reflected within the app.',
    ],
  },
  {
    title: '7. Contact',
    paragraphs: [
      'If you have any questions, please contact us at:',
      'support@loyaltycircle.example',
    ],
  },
];

const renderPrivacyPolicyHtml = () => {
  const renderedSections = PRIVACY_POLICY_SECTIONS.map((section) => {
    const paragraphs = (section.paragraphs || [])
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');

    const items = section.items?.length
      ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';

    const closing = section.closing
      ? `<p>${escapeHtml(section.closing)}</p>`
      : '';

    return `
      <section>
        <h2>${escapeHtml(section.title)}</h2>
        ${paragraphs}
        ${items}
        ${closing}
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy | Loyalty Circle</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --card: #ffffff;
        --text: #172033;
        --muted: #5f6b85;
        --accent: #2952ff;
        --border: #d9dfeb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background:
          radial-gradient(circle at top right, rgba(41, 82, 255, 0.12), transparent 28%),
          linear-gradient(180deg, #f8faff 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 20px 72px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: 0 20px 48px rgba(25, 42, 89, 0.08);
        overflow: hidden;
      }

      header {
        padding: 36px 32px 24px;
        border-bottom: 1px solid var(--border);
      }

      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--accent);
        font-weight: 700;
      }

      h1 {
        margin: 0;
        font-size: clamp(32px, 4vw, 44px);
        line-height: 1.05;
      }

      .intro {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.7;
        max-width: 64ch;
      }

      .content {
        padding: 8px 32px 32px;
      }

      section {
        padding-top: 24px;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 22px;
        line-height: 1.25;
      }

      p, li {
        font-size: 16px;
        line-height: 1.75;
        color: var(--text);
      }

      p {
        margin: 0 0 12px;
      }

      ul {
        margin: 0 0 12px 22px;
        padding: 0;
      }

      li + li {
        margin-top: 8px;
      }

      footer {
        padding: 0 32px 32px;
        color: var(--muted);
        font-size: 14px;
      }

      a {
        color: var(--accent);
      }

      @media (max-width: 640px) {
        header,
        .content,
        footer {
          padding-left: 20px;
          padding-right: 20px;
        }

        main {
          padding-top: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <article class="card">
        <header>
          <p class="eyebrow">Loyalty Circle</p>
          <h1>Privacy Policy</h1>
          <p class="intro">
            This Privacy Policy describes how Loyalty Circle ("we", "our", or "the app")
            collects, uses, and protects user information.
          </p>
        </header>
        <div class="content">
          ${renderedSections}
        </div>
        <footer>
          For support, email <a href="mailto:support@loyaltycircle.example">support@loyaltycircle.example</a>.
        </footer>
      </article>
    </main>
  </body>
</html>`;
};

const getTenantAdminCapabilities = async (ctx, strapi) => {
  const adminUser = await getAdminRequestUser(ctx, strapi);
  if (!adminUser?.id) {
    return null;
  }

  const tenantContext = await getAdminTenantContext(strapi, adminUser);
  const passwordChangeRequired = await mustChangePassword(strapi, adminUser.id);
  const tenantAdminRecordId = tenantContext.isTenantAdmin
    ? tenantContext.tenantAdminIds?.[0] || null
    : null;
  const adminLeaderRecordId = tenantContext.isAdminLeader
    ? tenantContext.adminLeaderIds?.[0] || null
    : null;
  const adminLeader = adminLeaderRecordId
    ? await strapi.entityService.findOne(APP_ADMIN_LEADER_UID, adminLeaderRecordId, {
        fields: ['id', 'name'],
      })
    : null;

  strapi.log.info(
    `[tenant-admin][capabilities] adminUser=${adminUser.id} isSuperAdmin=${tenantContext.isSuperAdmin}` +
    ` isAdminLeader=${tenantContext.isAdminLeader} isTenantAdmin=${tenantContext.isTenantAdmin}` +
    ` roles=${JSON.stringify(tenantContext.roleCodes || [])}` +
    ` tenantIds=${JSON.stringify(tenantContext.tenantIds)}` +
    ` mustChangePassword=${passwordChangeRequired}` +
    ` adminLeaderRecordId=${adminLeaderRecordId || 'null'}` +
    ` tenantAdminRecordId=${tenantAdminRecordId || 'null'}`
  );

  const sharedApp = await findSharedAppConfig(strapi);
  return {
    isSuperAdmin: tenantContext.isSuperAdmin === true,
    isTenantAdminScoped: tenantContext.isTenantAdmin === true,
    isAdminLeader: tenantContext.isAdminLeader === true,
    canViewUserImages: tenantContext.isSuperAdmin || tenantContext.isAdminLeader === true,
    canManageTenantAdmins: tenantContext.isSuperAdmin || tenantContext.isAdminLeader === true,
    canDeleteManagedRecords: tenantContext.isSuperAdmin,
    canExportContacts:
      tenantContext.isAdminLeader ||
      tenantContext.isSuperAdmin ||
      sharedApp?.enable_tenant_admin_contact_export !== false,
    mustChangePassword: passwordChangeRequired,
    adminLeaderRecordId,
    adminLeaderName: adminLeader?.name || null,
    tenantAdminRecordId,
  };
};

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    attachTenantScopedContentManagerControllers(strapi);
    attachTenantScopedRelationControllers(strapi);
    attachTenantAdminPermissionExpansion(strapi);

    strapi.server.use(async (ctx, next) => {
      const adminUser = await getAdminRequestUser(ctx, strapi);
      if (!adminUser?.id) {
        return next();
      }

      applyScopedAdminCorsHeaders(ctx);

      if (
        isPasswordChangeRestrictedAdminRequest(ctx.request.path || '') &&
        await mustChangePassword(strapi, adminUser.id)
      ) {
        return ctx.forbidden('You must change your temporary password before accessing this area.');
      }

      const relationRequest = getContentManagerRelationParams(ctx.request.path || '');
      if (ctx.method === 'GET' && relationRequest?.targetField === 'tenant') {
        const { model, entityId, mode } = relationRequest;
        const supportedRelationModel = (
          model === APP_USER_UID ||
          model === CONTACT_UID ||
          model === APP_TENANT_ADMIN_UID
        );
        if (!supportedRelationModel) {
          return next();
        }

        const tenantContext = await getAdminTenantContext(strapi, adminUser);
        if (tenantContext.isSuperAdmin) {
          return next();
        }

        if (!tenantContext.tenantIds.length) {
          return ctx.forbidden('This admin user is not assigned to a tenant.');
        }

        if (mode === 'available') {
          const page = Math.max(1, Number(ctx.request.query?.page) || 1);
          const pageSize = Math.max(1, Math.min(100, Number(ctx.request.query?.pageSize) || 10));
          const start = (page - 1) * pageSize;
          const tenantResults = tenantContext.tenants
            .slice()
            .sort((left, right) => String(left?.name || left?.slug || '').localeCompare(String(right?.name || right?.slug || '')))
            .slice(start, start + pageSize)
            .map((tenant) => ({
              id: tenant.id,
              name: tenant.name || tenant.slug || String(tenant.id),
              slug: tenant.slug || null,
            }));

          ctx.body = {
            results: tenantResults,
            pagination: {
              page,
              pageSize,
              pageCount: Math.max(1, Math.ceil(tenantContext.tenants.length / pageSize)),
              total: tenantContext.tenants.length,
            },
          };
          return;
        }

        if (!entityId) {
          return ctx.badRequest('Entry id must be a valid number.');
        }

        const scopedEntity = await assertScopedAdminRecord(strapi, tenantContext, model, entityId);
        if (!scopedEntity) {
          return ctx.forbidden('This record is outside your tenant admin scope.');
        }

        const tenant = scopedEntity.tenant || null;
        ctx.body = {
          data: tenant
            ? {
                id: tenant.id,
                name: tenant.name || tenant.slug || String(tenant.id),
                slug: tenant.slug || null,
              }
            : null,
        };
        return;
      }

      if (ctx.method === 'GET' && relationRequest?.targetField === 'admin_leader') {
        const { model, entityId, mode } = relationRequest;
        if (model !== APP_TENANT_ADMIN_UID) {
          return next();
        }

        const tenantContext = await getAdminTenantContext(strapi, adminUser);
        if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.length) {
          return ctx.forbidden('This admin user is not assigned to a tenant.');
        }

        if (mode === 'available') {
          const leaders = tenantContext.isSuperAdmin
            ? await strapi.entityService.findMany(APP_ADMIN_LEADER_UID, {
                fields: ['id', 'name'],
                sort: { name: 'ASC' },
                limit: 100,
              })
            : await strapi.entityService.findMany(APP_ADMIN_LEADER_UID, {
                filters: { id: { $in: tenantContext.adminLeaderIds || [] } },
                fields: ['id', 'name'],
                sort: { name: 'ASC' },
                limit: 100,
              });

          ctx.body = {
            results: leaders.map((leader) => ({
              id: leader.id,
              name: leader.name || `Leader ${leader.id}`,
            })),
            pagination: {
              page: 1,
              pageSize: leaders.length || 10,
              pageCount: 1,
              total: leaders.length,
            },
          };
          return;
        }

        if (!entityId) {
          return ctx.badRequest('Entry id must be a valid number.');
        }

        if (!tenantContext.isSuperAdmin) {
          const scopedEntity = await findScopedTenantAdminRecord({
            strapi,
            tenantContext,
            entityId,
          });
          if (!scopedEntity) {
            return ctx.forbidden('This Tenant Admin record is outside your scope.');
          }
        }

        const tenantAdmin = await strapi.entityService.findOne(APP_TENANT_ADMIN_UID, entityId, {
          fields: ['id'],
          populate: {
            admin_leader: {
              fields: ['id', 'name'],
            },
          },
        });
        const leader = tenantAdmin?.admin_leader || null;
        ctx.body = {
          data: leader
            ? {
                id: leader.id,
                name: leader.name || `Leader ${leader.id}`,
              }
            : null,
        };
        return;
      }

      const slug = getContentManagerSlug(ctx.request.path || '');
      if (!slug) {
        return next();
      }

      if ((ctx.method === 'POST' || ctx.method === 'PUT') && slug === APP_TENANT_UID) {
        stripManagedTenantFields(ctx, slug);
      }

      if (ctx.method === 'POST' && slug === APP_TENANT_ADMIN_UID) {
        const data = getRequestData(ctx);
        const tenantIds = resolveTenantAdminBulkTenantIds(data);
        const relationTenantIds = resolveTenantRelationIds(data?.tenant);

        if (!relationTenantIds.length && tenantIds.length > 0) {
          setRequestData(ctx, {
            ...data,
            qr_code_url: null,
            tenant: {
              connect: tenantIds.map((id) => ({ id })),
            },
          });
        }

        strapi.log.info(
          `[tenant-admin-create] bodyTenant=${JSON.stringify(data?.tenant || null)} qrCodeUrl=${JSON.stringify(data?.qr_code_url || null)} resolvedTenantIds=${JSON.stringify(tenantIds)}`
        );
        if (tenantIds.length > 1) {
          const createPayload = getRequestData(ctx);
          if (!createPayload || typeof createPayload !== 'object') {
            return ctx.badRequest('Tenant Admin bulk creation requires a valid request body.');
          }

          strapi.log.info(
            `[tenant-admin-bulk-create] admin_email="${String(createPayload.admin_email || '').trim()}" tenantIds=${JSON.stringify(tenantIds)}`
          );

          const createdRecords = [];
          for (const tenantId of tenantIds) {
            const nextData = {
              ...createPayload,
              qr_code_url: null,
              tenant: {
                connect: [{ id: tenantId }],
              },
            };

            const created = await strapi.entityService.create(APP_TENANT_ADMIN_UID, {
              data: nextData,
              populate: {
                tenant: {
                  fields: ['id', 'name', 'slug'],
                },
              },
            });
            createdRecords.push(created);
            strapi.log.info(
              `[tenant-admin-bulk-create] created record id=${created?.id || 'unknown'} for tenantId=${tenantId}`
            );
          }

          strapi.log.info(
            `[tenant-admin-bulk-create] completed createdCount=${createdRecords.length}`
          );
          ctx.body = createdRecords[0] || null;
          return;
        }
      }

      const tenantContext = await getAdminTenantContext(strapi, adminUser);
      if (tenantContext.isSuperAdmin) {
        return next();
      }

      if (slug === APP_ADMIN_LEADER_UID && tenantContext.isTenantAdmin) {
        return ctx.forbidden('Tenant Admin users cannot access Admin Leader records.');
      }

      if (!tenantContext.tenantIds.length) {
        return ctx.forbidden('This admin user is not assigned to a tenant.');
      }

      if (slug === APP_TENANT_ADMIN_UID) {
        if (ctx.method === 'GET' && isContentManagerConfigurationRequest(ctx.request.path || '')) {
          return next();
        }

        if (ctx.method === 'GET') {
          const entityId = getContentManagerEntityId(ctx.request.path || '');

          if (!entityId) {
            ctx.body = await buildScopedTenantAdminListResponse({
              strapi,
              tenantContext,
              requestQuery: ctx.request.query || {},
            });
            return;
          }

          const scopedRecord = await findScopedTenantAdminRecord({
            strapi,
            tenantContext,
            entityId,
          });

          if (!scopedRecord) {
            return ctx.forbidden('This record is outside your tenant admin scope.');
          }

          const entity = await strapi.entityService.findOne(APP_TENANT_ADMIN_UID, entityId, {
            fields: TENANT_ADMIN_FIELDS,
            populate: {
              tenant: {
                fields: ['id', 'name', 'slug'],
              },
            },
          });

          if (!entity) {
            return ctx.notFound();
          }

          ctx.body = entity;
          return;
        }

        if (ctx.method === 'PUT' && tenantContext.isAdminLeader) {
          const entityId = getContentManagerEntityId(ctx.request.path || '');
          const scopedRecord = await findScopedTenantAdminRecord({
            strapi,
            tenantContext,
            entityId,
          });
          if (!scopedRecord) {
            return ctx.forbidden('This Tenant Admin record is outside your scope.');
          }

          const data = getRequestData(ctx) || {};
          const safeData = {};
          if (Object.prototype.hasOwnProperty.call(data, 'tenant_name')) {
            safeData.tenant_name = data.tenant_name;
          }
          setRequestData(ctx, safeData);
          return next();
        }

        return ctx.forbidden('Tenant Admin users cannot modify Tenant Admin mappings.');
      }

      if (slug === APP_TENANT_UID) {
        if (ctx.method === 'GET' && isContentManagerConfigurationRequest(ctx.request.path || '')) {
          return next();
        }

        const entityId = getContentManagerEntityId(ctx.request.path || '');

        if (ctx.method === 'GET' && !entityId) {
          withAdminTenantFilter(ctx, getScopedAdminListFilter(tenantContext, slug));
          return next();
        }

        if (ctx.method === 'GET' && entityId) {
          if (!tenantContext.tenantIds.includes(entityId)) {
            return ctx.forbidden('This tenant is outside your scope.');
          }
          return next();
        }

        return ctx.forbidden('Tenant admin users cannot modify tenant configuration.');
      }

      if (slug !== APP_USER_UID && slug !== CONTACT_UID) {
        return next();
      }

      const entityId = getContentManagerEntityId(ctx.request.path || '');
      if (ctx.method === 'GET' && !entityId) {
        withAdminTenantFilter(ctx, getScopedAdminListFilter(tenantContext, slug));
        return next();
      }

      if (entityId && (ctx.method === 'GET' || ctx.method === 'DELETE' || ctx.method === 'PUT')) {
        const scopedEntity = await assertScopedAdminRecord(strapi, tenantContext, slug, entityId);

        if (!scopedEntity) {
          return ctx.forbidden('This record is outside your tenant admin scope.');
        }
      }

      if (ctx.method !== 'GET') {
        return ctx.forbidden('Forbidden');
      }

      return next();
    });

    strapi.server.routes([
      {
        method: 'GET',
        path: '/privacy_policy',
        handler: async (ctx) => {
          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderPrivacyPolicyHtml();
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/tenant-admin/capabilities',
        handler: async (ctx) => {
          applyScopedAdminCorsHeaders(ctx);
          const capabilities = await getTenantAdminCapabilities(ctx, strapi);
          if (!capabilities) {
            return ctx.unauthorized('Admin authentication is required.');
          }

          ctx.body = { data: capabilities };
        },
        config: {
          // The handler validates the Strapi Admin bearer token directly.
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/qr-code.svg',
        handler: async (ctx) => {
          const value = String(ctx.query?.value || '').trim();
          if (!value) {
            return ctx.badRequest('A QR code value is required.');
          }

          const svg = await QRCode.toString(value, {
            type: 'svg',
            margin: 1,
            width: 256,
            color: {
              dark: '#111827',
              light: '#FFFFFF',
            },
          });

          ctx.type = 'image/svg+xml';
          ctx.body = svg;
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/qr-install',
        handler: async (ctx) => {
          const qrToken = String(ctx.query?.qrToken || ctx.query?.token || '').trim();
          const tenantCode = String(
            ctx.query?.tenantCode || ctx.query?.tenant || ctx.query?.tenantSlug || ''
          ).trim();
          const referralCode = String(ctx.query?.referralCode || '').trim();
          const isAndroidRequest = /Android/i.test(String(ctx.get('user-agent') || ''));
          const sharedApp = await findSharedAppConfig(strapi);
          const sharedApkUrl = String(sharedApp?.android_apk_url || '').trim();

          if (!tenantCode && !qrToken) {
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 400;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Loyalty Circle',
                primary_color: '#2F6BFF',
                android_apk_url: sharedApkUrl,
              },
              tenantCode: '',
              qrToken: '',
              referralCode,
              qrCodeUrl: '',
              isAndroidRequest,
            });
            return;
          }

          const launchContext = qrToken
            ? await findTenantLaunchByQrToken(strapi, qrToken)
            : null;
          const tenant = launchContext?.tenant || (await strapi.entityService.findMany(APP_TENANT_UID, {
            filters: {
              slug: {
                $eq: tenantCode,
              },
              status: {
                $ne: 'inactive',
              },
            },
            fields: [
              'id',
              'name',
              'slug',
              'status',
              'app_display_name',
              'primary_color',
              'android_application_id',
              'android_deep_link_scheme',
              'android_apk_url',
              'qr_code_url',
            ],
            limit: 1,
          }))[0];

          const effectiveReferralCode = String(
            referralCode || buildTenantAdminReferralCode({
              tenantCode: launchContext?.tenant?.slug || tenant?.slug || tenantCode,
              tenantAdminName: launchContext?.tenantAdmin?.tenant_name || '',
            }) || ''
          ).trim();

          if (!tenant) {
            strapi.log.warn(
              `[qr-install] Missing tenant for tenantCode="${tenantCode}" qrTokenPresent=${Boolean(qrToken)} referralCode="${effectiveReferralCode}"`
            );
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 404;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Loyalty Circle',
                primary_color: '#2F6BFF',
                android_apk_url: sharedApkUrl,
              },
              tenantCode,
              qrToken,
              referralCode: effectiveReferralCode,
              qrCodeUrl: '',
              isAndroidRequest,
            });
            return;
          }

          strapi.log.info(
            `[qr-install] tenant="${tenant.slug}" sharedDeepLinkScheme="${getSharedDeepLinkScheme()}" apkUrlPresent=${Boolean(
              ensureAbsoluteUrl(sharedApkUrl || tenant.android_apk_url)
            )} qrCodeUrl="${launchContext?.tenantAdmin?.qr_code_url || tenant.qr_code_url || ''}" qrTokenPresent=${Boolean(
              qrToken
            )} referralCode="${effectiveReferralCode}"`
          );

          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderQrLandingHtml({
            tenant: {
              ...tenant,
              android_apk_url: sharedApkUrl || tenant.android_apk_url || '',
            },
            tenantCode: tenant.slug || tenantCode,
            qrToken: qrToken || launchContext?.tenantAdmin?.qr_token || '',
            referralCode: effectiveReferralCode,
            qrCodeUrl: launchContext?.tenantAdmin?.qr_code_url || tenant.qr_code_url || ctx.request.href,
            isAndroidRequest,
          });
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/api/app-bootstrap',
        handler: async (ctx) => {
          const qrToken = String(ctx.query?.qrToken || ctx.query?.token || '').trim();
          const sharedApp = await findSharedAppConfig(strapi);
          const latestVersionCode = parsePositiveInt(sharedApp?.android_latest_version_code) || null;
          const latestVersionName = String(sharedApp?.android_latest_version_name || '').trim() || null;
          const androidApkUrl = ensureAbsoluteUrl(String(sharedApp?.android_apk_url || '').trim()) || null;

          if (!qrToken) {
            ctx.body = {
              data: {
                tenantCode: '',
                tenantName: '',
                appDisplayName: 'Loyalty Circle',
                primaryColor: null,
                supportEmail: null,
                deepLinkScheme: getSharedDeepLinkScheme(),
                androidApplicationId: getSharedAndroidApplicationId(),
                androidApkUrl,
                latestVersionCode,
                latestVersionName,
                forceUpdate: sharedApp?.android_force_update === true,
                qrCodeUrl: null,
              },
            };
            return;
          }

          const launchContext = await findTenantLaunchByQrToken(strapi, qrToken);
          if (!launchContext?.tenant) {
            return ctx.forbidden('Invalid tenant QR token.');
          }

          const tenant = launchContext.tenant;
          const tenantAdmin = launchContext.tenantAdmin;

          ctx.body = {
            data: {
              tenantCode: tenant.slug,
              tenantName: tenantAdmin?.tenant_name || tenant.app_display_name || tenant.name,
              appDisplayName: tenant.app_display_name || tenant.name,
              primaryColor: tenant.primary_color || null,
              supportEmail: tenant.support_email || null,
              deepLinkScheme: getTenantDeepLinkScheme(tenant),
              androidApplicationId: getTenantAndroidApplicationId(tenant),
              androidApkUrl,
              latestVersionCode,
              latestVersionName,
              forceUpdate: sharedApp?.android_force_update === true,
              qrCodeUrl: tenantAdmin?.qr_code_url || null,
            },
          };
        },
        config: {
          auth: false,
        },
      },
    ]);

    strapi.server.routes({
      type: 'admin',
        routes: [
          {
            method: 'GET',
            path: '/shared-app/voice-panel-state',
            handler: async (ctx) => {
              const adminUser = await getAdminRequestUser(ctx, strapi);
              if (!adminUser?.id) {
                return ctx.unauthorized('Admin authentication is required.');
              }

              const sharedApp = await findSharedAppConfig(strapi);
              const tenantContext = await getAdminTenantContext(strapi, adminUser);
              ctx.body = {
                data: {
                  enabled:
                    !tenantContext.isAdminLeader &&
                    sharedApp?.enable_twilio_voice_panel !== false,
                },
              };
            },
            config: {
              auth: false,
            },
          },
          {
            method: 'GET',
            path: '/tenant-admin/capabilities',
            handler: async (ctx) => {
              const capabilities = await getTenantAdminCapabilities(ctx, strapi);
              if (!capabilities) {
                return ctx.unauthorized('Admin authentication is required.');
              }

              ctx.body = {
                data: capabilities,
              };
            },
            config: {
              policies: ['admin::isAuthenticatedAdmin'],
            },
          },
          {
            method: 'GET',
            path: '/contact-export',
            handler: async (ctx) => {
              const adminUser = await getAdminRequestUser(ctx, strapi);
              if (!adminUser?.id) {
                return ctx.unauthorized('Admin authentication is required.');
              }

              const tenantContext = await getAdminTenantContext(strapi, adminUser);
              await streamContactsCsvExport({
                ctx,
                strapi,
                adminUser,
                tenantContext,
              });
            },
            config: {
              policies: ['admin::isAuthenticatedAdmin'],
            },
          },
          {
            method: 'GET',
            path: '/twilio/voice/token',
            handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (tenantContext.isAdminLeader) {
              return ctx.forbidden('Admin Leader users cannot use the voice panel.');
            }

            try {
              ctx.body = {
                data: createVoiceAccessToken(adminUser),
              };
            } catch (error) {
              strapi.log.error(`[twilio-voice] ${error.message}`);
              return ctx.internalServerError(error.message);
            }
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/tenant-api-key/:id/rotate',
          handler: async (ctx) => {
            const tenantId = parsePositiveInt(ctx.params.id);
            if (!tenantId) {
              return ctx.badRequest('Tenant id must be a valid number.');
            }

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            if (!tenantContext.isAdmin) {
              return ctx.forbidden('Only authenticated admins can rotate tenant API keys.');
            }

            if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.includes(tenantId)) {
              return ctx.forbidden('You can only rotate API keys for tenants you manage.');
            }

            const tenant = await strapi.entityService.findOne(APP_TENANT_UID, tenantId, {
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });
            if (!tenant) {
              return ctx.notFound('Tenant not found.');
            }

            const nextKey = generateTenantApiKey(tenant);
            const updatedTenant = await strapi.entityService.update(APP_TENANT_UID, tenantId, {
              data: {
                app_api_key: nextKey,
              },
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });

            ctx.body = {
              data: {
                id: updatedTenant.id,
                name: updatedTenant.name,
                slug: updatedTenant.slug,
                status: updatedTenant.status,
                appApiKey: updatedTenant.app_api_key,
                androidApplicationId: updatedTenant.android_application_id,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/admin-leader/available-tenants',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin) {
              return ctx.forbidden('Only Super Admins can create Admin Leaders.');
            }

            const tenants = await strapi.entityService.findMany(APP_TENANT_UID, {
              fields: ['id', 'name', 'slug'],
              sort: ['name:asc'],
              limit: 1000,
            });
            ctx.body = { data: tenants };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/admin-leader/create-with-account',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin) {
              return ctx.forbidden('Only Super Admins can create Admin Leaders.');
            }

            const data = getRequestData(ctx) || {};
            const leaderName = String(data.name || '').trim();
            const adminEmail = String(data.admin_email || '').trim().toLowerCase();
            const tenantIds = Array.isArray(data.tenantIds)
              ? [...new Set(data.tenantIds.map((entry) => parsePositiveInt(entry)).filter(Boolean))]
              : [];

            if (!leaderName || !adminEmail) {
              return ctx.badRequest('Leader Name and Admin Email are required.');
            }
            if (!tenantIds.length) {
              return ctx.badRequest('Please select at least one tenant.');
            }

            const selectedTenants = await strapi.entityService.findMany(APP_TENANT_UID, {
              filters: { id: { $in: tenantIds } },
              fields: ['id'],
              limit: 1000,
            });
            if (selectedTenants.length !== tenantIds.length) {
              return ctx.badRequest('One or more selected tenants no longer exist.');
            }

            let targetAdminUser = await strapi.db.query('admin::user').findOne({
              where: { email: adminEmail },
              populate: ['roles'],
            });
            let createdAdminUserId = null;

            if (targetAdminUser) {
              const hasAdminLeaderRole = Array.isArray(targetAdminUser.roles) && targetAdminUser.roles.some(isAdminLeaderRole);
              if (!hasAdminLeaderRole) {
                return ctx.badRequest('This email already belongs to a Strapi admin account without the Admin Leader role.');
              }
            } else {
              const newAccountPassword = String(data.newAccountPassword || '');
              const passwordIsValid =
                newAccountPassword.length >= 8 &&
                /[a-z]/.test(newAccountPassword) &&
                /[A-Z]/.test(newAccountPassword) &&
                /\d/.test(newAccountPassword);
              if (!passwordIsValid) {
                return ctx.badRequest(
                  'Enter a temporary password with at least 8 characters, uppercase, lowercase, and a number.'
                );
              }

              const roles = await strapi.db.query('admin::role').findMany({
                fields: ['id', 'name', 'code'],
                limit: 1000,
              });
              const adminLeaderRole = roles.find(isAdminLeaderRole);
              if (!adminLeaderRole) {
                return ctx.internalServerError('The Admin Leader role is not configured.');
              }

              const nameParts = leaderName.split(/\s+/).filter(Boolean);
              const createdAdminUser = await strapi.admin.services.user.create({
                firstname: nameParts[0] || adminEmail.split('@')[0] || 'Admin',
                lastname: nameParts.slice(1).join(' ') || 'Leader',
                email: adminEmail,
                password: newAccountPassword,
                roles: [adminLeaderRole.id],
                isActive: true,
                registrationToken: null,
              });
              targetAdminUser = {
                id: createdAdminUser.id,
                email: createdAdminUser.email,
              };
              createdAdminUserId = createdAdminUser.id;
            }

            let createdLeader = null;
            try {
              createdLeader = await strapi.entityService.create(APP_ADMIN_LEADER_UID, {
                data: {
                  name: leaderName,
                  admin_user_id: targetAdminUser.id,
                  admin_email: targetAdminUser.email,
                  tenants: {
                    connect: tenantIds.map((id) => ({ id })),
                  },
                },
                populate: {
                  tenants: {
                    fields: ['id', 'name', 'slug'],
                  },
                },
              });

              if (createdAdminUserId) {
                await requirePasswordChange(strapi, createdAdminUserId);
                strapi.log.info(
                  `[admin-leader][account-create] adminUser=${createdAdminUserId} email=${adminEmail} createdBy=${adminUser.id}`
                );
              }
            } catch (error) {
              if (createdLeader?.id) {
                await strapi.entityService.delete(APP_ADMIN_LEADER_UID, createdLeader.id);
              }
              if (createdAdminUserId) {
                await removeAdminAccountSecurity(strapi, createdAdminUserId);
                await strapi.db.query('admin::user').delete({ where: { id: createdAdminUserId } });
              }
              throw error;
            }

            ctx.body = { data: createdLeader };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/tenant-admin/available-tenants',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
              return ctx.forbidden('Only Super Admins and Admin Leaders can create Tenant Admin mappings.');
            }

            const tenants = await strapi.entityService.findMany(APP_TENANT_UID, {
              filters: tenantContext.isSuperAdmin
                ? {}
                : { id: { $in: tenantContext.tenantIds } },
              fields: ['id', 'name', 'slug'],
              sort: ['name:asc'],
              limit: 1000,
            });

            ctx.body = { data: tenants };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/tenant-admin/bulk-create',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
              return ctx.forbidden('Only Super Admins and Admin Leaders can create Tenant Admin mappings.');
            }

            const data = getRequestData(ctx) || {};
            const tenantIds = Array.isArray(data.tenantIds)
              ? [...new Set(data.tenantIds.map((entry) => parsePositiveInt(entry)).filter(Boolean))]
              : [];
            const requestedAdminLeaderId = parsePositiveInt(data.adminLeaderId);

            if (!tenantIds.length) {
              return ctx.badRequest('Please select at least one tenant.');
            }

            if (
              tenantContext.isAdminLeader &&
              tenantIds.some((tenantId) => !tenantContext.tenantIds.includes(tenantId))
            ) {
              return ctx.forbidden('You can only create Tenant Admins for tenants assigned to you.');
            }

            const adminEmail = String(data.admin_email || '').trim().toLowerCase();
            if (!adminEmail) {
              return ctx.badRequest('Admin Email is required.');
            }

            let targetAdminUser = await strapi.db.query('admin::user').findOne({
              where: { email: adminEmail },
              select: ['id', 'email'],
            });
            let createdAdminUserId = null;

            if (!targetAdminUser) {
              const newAccountPassword = String(data.newAccountPassword || '');
              const passwordIsValid =
                newAccountPassword.length >= 8 &&
                /[a-z]/.test(newAccountPassword) &&
                /[A-Z]/.test(newAccountPassword) &&
                /\d/.test(newAccountPassword);

              if (!passwordIsValid) {
                return ctx.badRequest(
                  'No Strapi admin account exists for this email. Enter a temporary password with at least 8 characters, uppercase, lowercase, and a number.'
                );
              }

              const standardRoles = await strapi.db.query('admin::role').findMany({
                where: {
                  code: {
                    $in: ['strapi-editor', 'strapi-author'],
                  },
                },
                select: ['id'],
              });
              if (!standardRoles.length) {
                return ctx.internalServerError('The standard Strapi admin roles are not configured.');
              }

              const emailLocalPart = adminEmail.split('@')[0] || 'Tenant';
              const createdAdminUser = await strapi.admin.services.user.create({
                firstname: emailLocalPart,
                lastname: 'Admin',
                email: adminEmail,
                password: newAccountPassword,
                roles: standardRoles.map((role) => role.id),
                isActive: true,
                registrationToken: null,
              });

              targetAdminUser = {
                id: createdAdminUser.id,
                email: createdAdminUser.email,
              };
              createdAdminUserId = createdAdminUser.id;
              strapi.log.info(
                `[tenant-admin][account-create] adminUser=${createdAdminUser.id} email=${adminEmail} createdBy=${adminUser.id}`
              );
            }

            const adminLeaderId = tenantContext.isAdminLeader
              ? tenantContext.adminLeaderIds?.[0] || null
              : requestedAdminLeaderId;

            if (tenantContext.isAdminLeader && !adminLeaderId) {
              return ctx.forbidden('Your Admin Leader profile is not linked to this account.');
            }

            if (adminLeaderId) {
              const adminLeader = await strapi.entityService.findOne(APP_ADMIN_LEADER_UID, adminLeaderId, {
                fields: ['id'],
                populate: {
                  tenants: {
                    fields: ['id'],
                  },
                },
              });
              if (!adminLeader) {
                return ctx.badRequest('The selected Admin Leader no longer exists.');
              }

              const leaderTenantIds = new Set(
                (adminLeader.tenants || []).map((tenant) => parsePositiveInt(tenant?.id)).filter(Boolean)
              );
              if (tenantIds.some((tenantId) => !leaderTenantIds.has(tenantId))) {
                return ctx.badRequest('The selected Tenant Admin must be linked only to tenants assigned to its Admin Leader.');
              }
            }

            const baseData = {
              admin_user_id: targetAdminUser.id,
              admin_email: targetAdminUser.email,
              role: data.role || 'tenant_admin',
              tenant_name: String(data.tenant_name || '').trim() || null,
              qr_token: null,
              qr_code_url: null,
            };

            const selectedTenants = await strapi.entityService.findMany(APP_TENANT_UID, {
              filters: {
                id: {
                  $in: tenantIds,
                },
              },
              fields: ['id', 'name', 'slug'],
              limit: tenantIds.length,
            });
            if (selectedTenants.length !== tenantIds.length) {
              return ctx.badRequest('One or more selected tenants no longer exist.');
            }

            const tenantsById = new Map(
              selectedTenants.map((tenant) => [parsePositiveInt(tenant.id), tenant])
            );
            const createdRecords = [];
            try {
              if (createdAdminUserId) {
                await requirePasswordChange(strapi, createdAdminUserId);
              }

              for (const tenantId of tenantIds) {
                const tenant = tenantsById.get(tenantId);
                const tenantCode = String(tenant?.slug || '').trim();
                if (!tenantCode) {
                  throw new Error(`Tenant ${tenantId} does not have a slug for its QR URL.`);
                }

                const qrToken = generateTenantAdminQrToken();
                const qrCodeUrl = buildTenantAdminQrCodeUrl({
                  qrToken,
                  tenantCode,
                });
                const now = new Date();

                // This database retains direct relation columns from an older
                // migration while Strapi still reads the corresponding link tables.
                // Write both representations in one transaction.
                const created = await strapi.db.connection.transaction(async (transaction) => {
                  const inserted = await transaction('tenant_admins')
                    .insert({
                      ...baseData,
                      tenant: tenantId,
                      admin_leader: adminLeaderId || null,
                      qr_token: qrToken,
                      qr_code_url: qrCodeUrl || null,
                      created_at: now,
                      updated_at: now,
                    })
                    .returning(['id']);
                  const tenantAdminId = Number(inserted[0]?.id || inserted[0]);

                  await transaction('tenant_admins_tenant_links')
                    .insert({ tenant_admin_id: tenantAdminId, tenant_id: tenantId })
                    .onConflict(['tenant_admin_id', 'tenant_id'])
                    .ignore();

                  if (adminLeaderId) {
                    await transaction('tenant_admins_admin_leader_links')
                      .insert({ tenant_admin_id: tenantAdminId, admin_leader_id: adminLeaderId })
                      .onConflict(['tenant_admin_id', 'admin_leader_id'])
                      .ignore();
                  }

                  return {
                    id: tenantAdminId,
                    ...baseData,
                    tenant: tenant,
                    qr_token: qrToken,
                    qr_code_url: qrCodeUrl || null,
                  };
                });
                createdRecords.push(created);
              }
            } catch (error) {
              // Do not leave an unusable account behind when no mapping was created.
              if (createdAdminUserId && createdRecords.length === 0) {
                await removeAdminAccountSecurity(strapi, createdAdminUserId);
                await strapi.db.query('admin::user').delete({ where: { id: createdAdminUserId } });
              }
              throw error;
            }

            ctx.body = {
              data: createdRecords,
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/tenant-admin/eligible-for-tenant/:tenantId',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            const tenantId = parsePositiveInt(ctx.params.tenantId);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }
            if (!tenantId) {
              return ctx.badRequest('Tenant id must be a valid number.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
              return ctx.forbidden('Only Super Admins and Admin Leaders can assign Tenant Admins.');
            }
            if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.includes(tenantId)) {
              return ctx.forbidden('You can only assign Tenant Admins to tenants assigned to you.');
            }

            const sourceMappings = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
              filters: tenantContext.isSuperAdmin
                ? {}
                : { admin_leader: { id: { $in: tenantContext.adminLeaderIds || [] } } },
              fields: ['id', 'admin_user_id', 'admin_email', 'tenant_name', 'role'],
              populate: {
                tenant: { fields: ['id', 'name', 'slug'] },
                admin_leader: { fields: ['id', 'name'] },
              },
              sort: { tenant_name: 'ASC' },
              limit: 1000,
            });
            const assignedMappings = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
              filters: { tenant: { id: { $eq: tenantId } } },
              fields: ['admin_user_id'],
              limit: 1000,
            });
            const assignedAdminUserIds = new Set(
              assignedMappings.map((entry) => parsePositiveInt(entry.admin_user_id)).filter(Boolean)
            );
            const seenAdminUserIds = new Set();
            const eligible = sourceMappings
              .filter((entry) => {
                const sourceAdminUserId = parsePositiveInt(entry.admin_user_id);
                if (!sourceAdminUserId || assignedAdminUserIds.has(sourceAdminUserId) || seenAdminUserIds.has(sourceAdminUserId)) {
                  return false;
                }
                seenAdminUserIds.add(sourceAdminUserId);
                return true;
              })
              .map((entry) => ({
                id: entry.id,
                adminUserId: entry.admin_user_id,
                adminEmail: entry.admin_email,
                tenantAdminName: entry.tenant_name,
                leaderName: entry.admin_leader?.name || null,
                sourceTenantName: entry.tenant?.name || entry.tenant?.slug || null,
              }));

            ctx.body = { data: eligible };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/tenant-admin/assign-to-tenant/:tenantId',
          handler: async (ctx) => {
            const adminUser = await getAdminRequestUser(ctx, strapi);
            const tenantId = parsePositiveInt(ctx.params.tenantId);
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }
            if (!tenantId) {
              return ctx.badRequest('Tenant id must be a valid number.');
            }

            const tenantContext = await getAdminTenantContext(strapi, adminUser);
            if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
              return ctx.forbidden('Only Super Admins and Admin Leaders can assign Tenant Admins.');
            }
            if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.includes(tenantId)) {
              return ctx.forbidden('You can only assign Tenant Admins to tenants assigned to you.');
            }

            const data = getRequestData(ctx) || {};
            const sourceIds = Array.isArray(data.tenantAdminIds)
              ? [...new Set(data.tenantAdminIds.map((entry) => parsePositiveInt(entry)).filter(Boolean))]
              : [];
            if (!sourceIds.length) {
              return ctx.badRequest('Select at least one Tenant Admin.');
            }

            const sourceMappings = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
              filters: {
                id: { $in: sourceIds },
                ...(tenantContext.isSuperAdmin
                  ? {}
                  : { admin_leader: { id: { $in: tenantContext.adminLeaderIds || [] } } }),
              },
              fields: ['id', 'admin_user_id', 'admin_email', 'tenant_name', 'role'],
              populate: {
                admin_leader: { fields: ['id'] },
              },
              limit: sourceIds.length,
            });
            if (sourceMappings.length !== sourceIds.length) {
              return ctx.forbidden('One or more selected Tenant Admins are outside your scope.');
            }

            const existingMappings = await strapi.entityService.findMany(APP_TENANT_ADMIN_UID, {
              filters: { tenant: { id: { $eq: tenantId } } },
              fields: ['admin_user_id', 'tenant_name'],
              limit: 1000,
            });
            const assignedAdminUserIds = new Set(
              existingMappings.map((entry) => parsePositiveInt(entry.admin_user_id)).filter(Boolean)
            );
            const assignedNames = new Set(
              existingMappings.map((entry) => String(entry.tenant_name || '').trim().toLowerCase()).filter(Boolean)
            );
            const created = [];
            const skipped = [];

            for (const source of sourceMappings) {
              const sourceAdminUserId = parsePositiveInt(source.admin_user_id);
              const tenantAdminName = String(source.tenant_name || '').trim();
              if (!sourceAdminUserId || assignedAdminUserIds.has(sourceAdminUserId)) {
                skipped.push({ id: source.id, reason: 'already_assigned' });
                continue;
              }
              if (!tenantAdminName || assignedNames.has(tenantAdminName.toLowerCase())) {
                skipped.push({ id: source.id, reason: 'duplicate_tenant_admin_name' });
                continue;
              }

              const record = await strapi.entityService.create(APP_TENANT_ADMIN_UID, {
                data: {
                  admin_user_id: sourceAdminUserId,
                  admin_email: source.admin_email,
                  tenant_name: tenantAdminName,
                  role: source.role || 'tenant_admin',
                  tenant: tenantId,
                  ...(source.admin_leader?.id
                    ? { admin_leader: source.admin_leader.id }
                    : {}),
                },
                fields: ['id', 'tenant_name', 'admin_email'],
              });
              assignedAdminUserIds.add(sourceAdminUserId);
              assignedNames.add(tenantAdminName.toLowerCase());
              created.push(record);
            }

            strapi.log.info(
              `[tenant-admin][assign-to-tenant] actor=${adminUser.id} tenant=${tenantId}` +
              ` requested=${sourceIds.length} created=${created.length} skipped=${skipped.length}`
            );
            ctx.body = { data: { created, skipped } };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/app-user-gallery/:id',
          handler: async (ctx) => {
            const userId = parsePositiveInt(ctx.params.id);
            if (!userId) {
              return ctx.badRequest('User id must be a valid number.');
            }

            const storageConfig = getObjectStorageConfig();
            const bucket = storageConfig.bucket;
            const region = storageConfig.region;
            const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
            const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;

            if (!bucket || !region) {
              return ctx.internalServerError('Object storage configuration missing: R2_BUCKET_NAME/S3_BUCKET_NAME or AWS_REGION.');
            }

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            let user;

            if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
              return ctx.forbidden('Tenant Admin users are not allowed to view user gallery images.');
            }

            if (tenantContext.isSuperAdmin) {
              user = await strapi.entityService.findOne(APP_USER_UID, userId, {
                fields: ['id'],
                populate: {
                  tenant: {
                    fields: ['id', 'slug', 'name'],
                  },
                },
              });
            } else {
              user = await assertScopedAdminRecord(strapi, tenantContext, APP_USER_UID, userId);
            }

            if (!user) {
              return ctx.forbidden('This user is outside your tenant.');
            }

            if (tenantContext.isAdminLeader) {
              strapi.log.info(
                `[admin-leader][image-view] adminUser=${ctx.state?.user?.id || 'unknown'} user=${userId} action=gallery-preview`
              );
            }

            const s3Client = createObjectStorageClient();

            const prefix = `${buildTenantUserImagePrefix(user.tenant, userId, prefixBase)}/`;
            const listed = await s3Client.listObjectsV2({
              Bucket: bucket,
              Prefix: prefix,
              MaxKeys: 100,
            }).promise();

            const items = await Promise.all(
              (listed.Contents || [])
                .filter((item) => item.Key)
                .sort((left, right) => {
                  const leftTime = new Date(left.LastModified || 0).getTime();
                  const rightTime = new Date(right.LastModified || 0).getTime();
                  return rightTime - leftTime;
                })
                .map(async (item) => {
                  const signedUrl = await s3Client.getSignedUrlPromise('getObject', {
                    Bucket: bucket,
                    Key: item.Key,
                    Expires: expiresIn,
                  });

                  return {
                    key: item.Key,
                    size: item.Size || 0,
                    lastModified: item.LastModified || null,
                    signedUrl,
                    objectUrl: buildObjectStoragePublicUrl(bucket, region, item.Key),
                  };
                })
            );

            ctx.body = {
              data: items,
              meta: {
                bucket,
                region,
                prefix,
                total: items.length,
                expiresIn,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
          {
            method: 'GET',
            path: '/app-user-selfie/:id',
            handler: async (ctx) => {
              const userId = parsePositiveInt(ctx.params.id);
              if (!userId) {
                return ctx.badRequest('User id must be a valid number.');
              }

              const storageConfig = getObjectStorageConfig();
              const bucket = storageConfig.bucket;
              const region = storageConfig.region;
              const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;
              const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
              let user;

              if (!tenantContext.isSuperAdmin && !tenantContext.isAdminLeader) {
                return ctx.forbidden('Tenant Admin users are not allowed to view user selfie images.');
              }

              if (tenantContext.isSuperAdmin) {
                user = await strapi.entityService.findOne(APP_USER_UID, userId, {
                  fields: ['id', 'image_url'],
                  populate: {
                    tenant: {
                      fields: ['id', 'slug', 'name'],
                    },
                  },
                });
              } else {
                user = await assertScopedAdminRecord(strapi, tenantContext, APP_USER_UID, userId);
              }

              if (!user) {
                return ctx.forbidden('This user is outside your tenant.');
              }

              if (tenantContext.isAdminLeader) {
                strapi.log.info(
                  `[admin-leader][image-view] adminUser=${ctx.state?.user?.id || 'unknown'} user=${userId} action=selfie-preview`
                );
              }

              const imageUrl = String(user.image_url || '').trim();
              if (!imageUrl) {
                ctx.body = {
                  data: null,
                  meta: {
                    hasImage: false,
                  },
                };
                return;
              }

              const objectKey = extractObjectStorageKeyFromUrl(imageUrl, bucket, region);
              if (!objectKey) {
                ctx.body = {
                  data: {
                    signedUrl: imageUrl,
                    objectUrl: imageUrl,
                    key: null,
                  },
                  meta: {
                    hasImage: true,
                    storage: 'public-url',
                  },
                };
                return;
              }

              const s3Client = createObjectStorageClient();
              const signedUrl = await s3Client.getSignedUrlPromise('getObject', {
                Bucket: bucket,
                Key: objectKey,
                Expires: expiresIn,
              });

              ctx.body = {
                data: {
                  signedUrl,
                  objectUrl: buildObjectStoragePublicUrl(bucket, region, objectKey),
                  key: objectKey,
                },
                meta: {
                  hasImage: true,
                  expiresIn,
                },
              };
            },
            config: {
              policies: ['admin::isAuthenticatedAdmin'],
            },
          },
        ],
      });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    await ensureAdminLeaderContentManagerPermissions(strapi);
    await backfillAdminLeaderTenants(strapi);
    await syncAdminLeaderListConfiguration(strapi);
    await syncTenantAdminListConfiguration(strapi);
    await syncAppUserListConfiguration(strapi);
    await syncContactListConfiguration(strapi);
    await backfillContactTenantAdminNames(strapi);
  },
};





