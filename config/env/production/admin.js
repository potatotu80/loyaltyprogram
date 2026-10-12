module.exports = ({ env }) => ({
  auth: {
    secret: env('ADMIN_JWT_SECRET'),
  },
  apiToken: {
    salt: env('API_TOKEN_SALT'),
  },
  transfer: {
    token: {
      salt: env('TRANSFER_TOKEN_SALT'),
    },
  },
  flags: {
    nps: env.bool('FLAG_NPS', false),
  },
  url: env('ADMIN_URL', 'https://cmsportal.yengsang.com/admin'),
  serveAdminPanel: env.bool('SERVE_ADMIN_PANEL', true),
});
