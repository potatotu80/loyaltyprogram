'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::tenant.tenant');
