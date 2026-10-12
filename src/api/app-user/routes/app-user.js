'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

const defaultRouter = createCoreRouter('api::app-user.app-user', {
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

const customRouter = {
  routes: [
    {
      method: 'POST',
      path: '/phone-verification/send-otp',
      handler: 'app-user.sendOtp',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/phone-verification/verify-otp',
      handler: 'app-user.verifyOtp',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/phone-verification/register-user',
      handler: 'app-user.registerVerifiedUser',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/app-users/:id/contacts',
      handler: 'app-user.contacts',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/app-users/:id/profile-image',
      handler: 'app-user.uploadProfileImage',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/client-events',
      handler: 'app-user.clientEvent',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
  ],
};

module.exports = {
  get prefix() {
    return defaultRouter.prefix;
  },
  get routes() {
    return customRouter.routes.concat(defaultRouter.routes);
  },
};
