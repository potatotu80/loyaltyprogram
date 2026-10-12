'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/twilio/voice',
      handler: 'twilio.voice',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/twilio/voice',
      handler: 'twilio.voice',
      config: {
        auth: false,
      },
    },
  ],
};
