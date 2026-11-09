'use strict';

// Some deployed databases use Strapi relation link tables only, while newer
// ones also retain direct relation columns from a legacy migration.
const getTenantAdminDirectRelationColumns = async (connection) => {
  const [hasTenantColumn, hasAdminLeaderColumn] = await Promise.all([
    connection.schema.hasColumn('tenant_admins', 'tenant'),
    connection.schema.hasColumn('tenant_admins', 'admin_leader'),
  ]);

  return {
    hasTenantColumn,
    hasAdminLeaderColumn,
  };
};

const addTenantAdminDirectRelations = ({
  data,
  tenantId,
  adminLeaderId,
  directRelationColumns,
}) => ({
  ...data,
  ...(directRelationColumns.hasTenantColumn ? { tenant: tenantId } : {}),
  ...(directRelationColumns.hasAdminLeaderColumn ? { admin_leader: adminLeaderId || null } : {}),
});

module.exports = {
  addTenantAdminDirectRelations,
  getTenantAdminDirectRelationColumns,
};
