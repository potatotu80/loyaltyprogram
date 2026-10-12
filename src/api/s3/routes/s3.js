'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/s3/presign',
      handler: 's3.presign',
      config: {
        auth: false,
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
  ],
};
