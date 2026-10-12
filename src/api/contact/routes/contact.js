'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::contact.contact', {
  config: {
    find: {
      auth: false,
      policies: ['global::app-api-key'],
    },
    findOne: {
      auth: false,
      policies: ['global::app-api-key'],
    },
    create: {
      auth: false,
      policies: ['global::app-api-key'],
    },
    update: {
      auth: false,
      policies: ['global::app-api-key'],
    },
    delete: {
      auth: false,
      policies: ['global::app-api-key'],
    },
  },
});
