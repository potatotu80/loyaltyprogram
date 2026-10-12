module.exports = {
  apps: [
    {
      name: 'contact-strapi',
      cwd: '/var/www/contact',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
