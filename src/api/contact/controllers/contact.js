'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const {
  APP_USER_UID,
  CONTACT_UID,
  assertTenantScopeForContact,
  assertTenantScopeForUser,
  getTenantFilter,
} = require('../../../utils/tenant-access');

const normalizeRelationId = (value) => {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.id === 'number' && Number.isInteger(value.id)) {
    return value.id;
  }

  if (value.data && typeof value.data === 'object') {
    return normalizeRelationId(value.data);
  }

  if (Array.isArray(value.connect) && value.connect.length > 0) {
    return normalizeRelationId(value.connect[0]);
  }

  if (Array.isArray(value.set) && value.set.length > 0) {
    return normalizeRelationId(value.set[0]);
  }

  return null;
};

const normalizeContactUserRelation = (ctx) => {
  const data = ctx.request.body?.data;
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'user')) {
    return null;
  }

  return normalizeRelationId(data.user);
};

const withTenantFilters = (tenantId, extraFilters = null) => {
  if (!extraFilters || Object.keys(extraFilters).length === 0) {
    return getTenantFilter(tenantId);
  }

  return {
    $and: [getTenantFilter(tenantId), extraFilters],
  };
};

const getRequestTraceId = (ctx) =>
  String(ctx.state?.requestTraceId || ctx.request?.headers?.['x-trace-id'] || 'no-trace').trim() || 'no-trace';

module.exports = createCoreController(CONTACT_UID, ({ strapi }) => ({
  async find(ctx) {
    const tenant = ctx.state.appTenant;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['name:asc'];
    const filters = withTenantFilters(tenant.id, ctx.query.filters);

    const [contacts, total] = await Promise.all([
      strapi.entityService.findMany(CONTACT_UID, {
        filters,
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
      strapi.db.query(CONTACT_UID).count({
        where: filters,
      }),
    ]);

    const sanitizedContacts = await this.sanitizeOutput(contacts, ctx);
    return this.transformResponse(sanitizedContacts, {
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
    const contactId = Number(ctx.params.id);
    if (Number.isNaN(contactId)) {
      return ctx.badRequest('Contact id must be a valid number.');
    }

    const contact = await assertTenantScopeForContact(strapi, tenant.id, contactId);
    if (!contact) {
      return ctx.notFound('Contact not found.');
    }

    const fullContact = await strapi.entityService.findOne(CONTACT_UID, contactId, {
      populate: {
        user: true,
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedContact = await this.sanitizeOutput(fullContact, ctx);
    return this.transformResponse(sanitizedContact);
  },

  async create(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const userId = normalizeContactUserRelation(ctx);
    if (!userId) {
      return ctx.badRequest('User must be defined.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.badRequest('User must reference an existing app user in this tenant.');
    }

    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contact_create_started userId=${userId} tenantId=${tenant.id}` +
        ` phone=${String(data?.phone || '').trim() || '-'} name=${String(data?.name || '').trim() || '-'}`
    );

    const payload = {
      ...data,
      user: userId,
      tenant: tenant.id,
    };

    const created = await strapi.entityService.create(CONTACT_UID, {
      data: payload,
      populate: {
        user: true,
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitized = await this.sanitizeOutput(created, ctx);
    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contact_create_completed userId=${userId} tenantId=${tenant.id}` +
        ` contactId=${created?.id || 'null'} phone=${String(created?.phone || '').trim() || '-'}`
    );
    return this.transformResponse(sanitized);
  },

  async update(ctx) {
    const tenant = ctx.state.appTenant;
    const traceId = getRequestTraceId(ctx);
    const contactId = Number(ctx.params.id);
    if (Number.isNaN(contactId)) {
      return ctx.badRequest('Contact id must be a valid number.');
    }

    const existingContact = await assertTenantScopeForContact(strapi, tenant.id, contactId);
    if (!existingContact) {
      return ctx.notFound('Contact not found.');
    }

    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const payload = {
      ...data,
      tenant: tenant.id,
    };

    if (Object.prototype.hasOwnProperty.call(data, 'user')) {
      const userId = normalizeContactUserRelation(ctx);
      if (!userId) {
        return ctx.badRequest('User must be defined.');
      }

      const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
      if (!user) {
        return ctx.badRequest('User must reference an existing app user in this tenant.');
      }

      payload.user = userId;
    }

    const resolvedUserId = normalizeRelationId(payload.user) || existingContact?.user?.id || null;
    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contact_update_started userId=${resolvedUserId || 'null'} tenantId=${tenant.id}` +
        ` contactId=${contactId} phone=${String(payload?.phone || existingContact?.phone || '').trim() || '-'}`
    );

    const updated = await strapi.entityService.update(CONTACT_UID, contactId, {
      data: payload,
      populate: {
        user: true,
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitized = await this.sanitizeOutput(updated, ctx);
    strapi.log.info(
      `[trace=${traceId}] [submission] stage=contact_update_completed userId=${updated?.user?.id || resolvedUserId || 'null'} tenantId=${tenant.id}` +
        ` contactId=${updated?.id || contactId} phone=${String(updated?.phone || '').trim() || '-'}`
    );
    return this.transformResponse(sanitized);
  },

  async delete(ctx) {
    const tenant = ctx.state.appTenant;
    const contactId = Number(ctx.params.id);
    if (Number.isNaN(contactId)) {
      return ctx.badRequest('Contact id must be a valid number.');
    }

    const existingContact = await assertTenantScopeForContact(strapi, tenant.id, contactId);
    if (!existingContact) {
      return ctx.notFound('Contact not found.');
    }

    const deleted = await strapi.entityService.delete(CONTACT_UID, contactId, {
      populate: {
        user: true,
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitized = await this.sanitizeOutput(deleted, ctx);
    return this.transformResponse(sanitized);
  },
}));
