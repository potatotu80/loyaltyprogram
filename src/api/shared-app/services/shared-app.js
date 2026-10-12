'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::shared-app.shared-app');
