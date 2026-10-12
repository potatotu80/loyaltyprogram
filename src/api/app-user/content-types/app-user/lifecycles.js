'use strict';

const fs = require('fs/promises');
const path = require('path');
const {
  buildTenantLocalImagePath,
  buildTenantUserImagePrefix,
} = require('../../../../utils/tenant-access');
const {
  createObjectStorageClient,
  getObjectStorageConfig,
} = require('../../../../utils/object-storage');

const CONTACT_UID = 'api::contact.contact';

const extractEntityId = (where) => {
  if (!where) return null;

  if (typeof where.id === 'number') return where.id;
  if (typeof where.id === 'string') {
    const parsed = Number(where.id);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof where.id === 'object') {
    if (typeof where.id.$eq === 'number') return where.id.$eq;
    if (typeof where.id.$eq === 'string') {
      const parsed = Number(where.id.$eq);
      return Number.isNaN(parsed) ? null : parsed;
    }
  }

  return null;
};

const extractDeleteId = (where) => {
  return extractEntityId(where);
};

const deleteS3Prefix = async (tenant, userId) => {
  const storageConfig = getObjectStorageConfig();
  const bucket = storageConfig.bucket;
  const region = storageConfig.region;
  const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
  const prefix = `${buildTenantUserImagePrefix(tenant, userId, prefixBase)}/`;

  if (!bucket || !region) {
    return;
  }

  const s3Client = createObjectStorageClient();

  let continuationToken;

  do {
    const listed = await s3Client.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }).promise();

    const objects = (listed.Contents || [])
      .map((item) => ({ Key: item.Key }))
      .filter((item) => item.Key);

    if (objects.length > 0) {
      await s3Client.deleteObjects({
        Bucket: bucket,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      }).promise();
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
};

const deleteLocalUserImages = async (tenant, userId) => {
  const targetDir = path.join(
    strapi.dirs.static.public,
    'uploads',
    'user-images',
    buildTenantLocalImagePath(tenant, userId)
  );

  await fs.rm(targetDir, { recursive: true, force: true });
};

const deleteRelatedContacts = async (userId) => {
  const contacts = await strapi.entityService.findMany(CONTACT_UID, {
    filters: {
      user: {
        id: userId,
      },
    },
    fields: ['id'],
    limit: 10000,
  });

  for (const contact of contacts) {
    await strapi.entityService.delete(CONTACT_UID, contact.id);
  }
};

module.exports = {
  async beforeCreate(event) {
    const data = event.params?.data;
    if (!data) return;

    if (Object.prototype.hasOwnProperty.call(data, 'phone') &&
        !Object.prototype.hasOwnProperty.call(data, 'phoneVerified')) {
      data.phoneVerified = false;
    }
  },

  async beforeUpdate(event) {
    const data = event.params?.data;
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'phone')) {
      return;
    }

    if (data.phoneVerified === true) {
      return;
    }

    const userId = extractEntityId(event.params?.where);
    if (!userId) {
      return;
    }

    const existingUser = await strapi.entityService.findOne('api::app-user.app-user', userId, {
      fields: ['phone'],
    });

    const nextPhone = typeof data.phone === 'string' ? data.phone.trim() : data.phone;
    const currentPhone = typeof existingUser?.phone === 'string' ? existingUser.phone.trim() : existingUser?.phone;

    if (nextPhone !== currentPhone) {
      data.phoneVerified = false;
    }
  },

  async beforeDelete(event) {
    const userId = extractDeleteId(event.params?.where);
    if (!userId) return;

    const existingUser = await strapi.entityService.findOne('api::app-user.app-user', userId, {
      fields: ['id'],
      populate: {
        tenant: {
          fields: ['id', 'slug', 'name'],
        },
      },
    });

    await deleteS3Prefix(existingUser?.tenant, userId);
    await deleteLocalUserImages(existingUser?.tenant, userId);
    await deleteRelatedContacts(userId);
  },
};
