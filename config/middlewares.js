const parseOrigins = (value) =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const productionOrigins = ['https://cmsportal.yengsang.com', 'https://api.yengsang.com'];
const localOrigins = [
  'http://localhost:1337',
  'http://127.0.0.1:1337',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const configuredOrigins = process.env.CORS_ORIGIN ? parseOrigins(process.env.CORS_ORIGIN) : [];
const corsOrigins =
  process.env.NODE_ENV === 'production'
    ? (configuredOrigins.length ? configuredOrigins : productionOrigins)
    : Array.from(new Set([...configuredOrigins, ...productionOrigins, ...localOrigins]));

module.exports = [
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:', 'http:', 'wss:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'media-src': ["'self'", 'data:', 'blob:', 'https:', 'mediastream:'],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  {
    name: 'strapi::cors',
    config: {
      origin: corsOrigins,
      credentials: true,
    },
  },
  'strapi::poweredBy',
  'strapi::logger',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
