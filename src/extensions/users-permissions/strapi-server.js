'use strict';

module.exports = (plugin) => {
  if (plugin.contentTypes?.user?.info) {
    plugin.contentTypes.user.info.displayName = 'Auth User';
    plugin.contentTypes.user.info.description = 'Users managed by the users-permissions plugin';
  }

  return plugin;
};
