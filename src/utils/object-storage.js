'use strict';

const AWS = require('aws-sdk');

const trimTrailingSlashes = (value) => String(value || '').replace(/\/+$/, '');

const encodeObjectKey = (key) =>
  String(key || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const getObjectStorageConfig = () => {
  const bucket = String(process.env.R2_BUCKET_NAME || process.env.S3_BUCKET_NAME || '').trim();
  const region = String(process.env.AWS_REGION || 'auto').trim() || 'auto';
  const endpoint = trimTrailingSlashes(process.env.R2_ENDPOINT || '');
  const publicBaseUrl = trimTrailingSlashes(process.env.R2_PUBLIC_BASE_URL || '');
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const provider = endpoint ? 'r2' : 's3';

  return {
    bucket,
    region,
    endpoint,
    publicBaseUrl,
    accessKeyId,
    secretAccessKey,
    provider,
  };
};

const createObjectStorageClient = () => {
  const config = getObjectStorageConfig();
  const clientOptions = {
    region: config.region,
    signatureVersion: 'v4',
  };

  if (config.endpoint) {
    clientOptions.endpoint = config.endpoint;
    clientOptions.s3ForcePathStyle = true;
  }

  if (config.accessKeyId && config.secretAccessKey) {
    clientOptions.accessKeyId = config.accessKeyId;
    clientOptions.secretAccessKey = config.secretAccessKey;
  }

  return new AWS.S3(clientOptions);
};

const buildObjectStoragePublicUrl = (bucket, region, key) => {
  const encodedKey = encodeObjectKey(key);
  const { publicBaseUrl, endpoint } = getObjectStorageConfig();

  if (publicBaseUrl) {
    return `${publicBaseUrl}/${encodedKey}`;
  }

  if (endpoint) {
    return `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
  }

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

const extractObjectStorageKeyFromUrl = (url, bucket, region) => {
  const value = String(url || '').trim();
  if (!value) {
    return null;
  }

  const { publicBaseUrl, endpoint } = getObjectStorageConfig();
  const candidates = [];

  if (publicBaseUrl) {
    candidates.push(`${publicBaseUrl}/`);
  }

  if (endpoint) {
    candidates.push(`${endpoint}/${encodeURIComponent(bucket)}/`);
    candidates.push(`${endpoint}/${bucket}/`);
  }

  candidates.push(`https://${bucket}.s3.${region}.amazonaws.com/`);

  for (const prefix of candidates) {
    if (value.startsWith(prefix)) {
      return decodeURIComponent(value.slice(prefix.length));
    }
  }

  return null;
};

const buildObjectStorageConsoleFolderUrl = (bucket, region, prefix) => {
  const { provider, publicBaseUrl } = getObjectStorageConfig();

  if (provider === 'r2') {
    if (!publicBaseUrl) {
      return null;
    }

    const normalizedPrefix = String(prefix || '').replace(/^\/+/, '');
    return `${trimTrailingSlashes(publicBaseUrl)}/${encodeObjectKey(normalizedPrefix)}`;
  }

  return (
    `https://s3.console.aws.amazon.com/s3/buckets/${bucket}` +
    `?region=${encodeURIComponent(region)}` +
    `&prefix=${encodeURIComponent(prefix)}` +
    '&showversions=false'
  );
};

module.exports = {
  buildObjectStorageConsoleFolderUrl,
  buildObjectStoragePublicUrl,
  createObjectStorageClient,
  extractObjectStorageKeyFromUrl,
  getObjectStorageConfig,
};
