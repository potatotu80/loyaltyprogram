import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager, useFetchClient, useNotification } from '@strapi/helper-plugin';
import { useRouteMatch } from 'react-router-dom';
import { Device } from '@twilio/voice-sdk';

const APP_USER_UID = 'api::app-user.app-user';
const CONTACT_UID = 'api::contact.contact';
const TENANT_UID = 'api::tenant.tenant';
const TENANT_ADMIN_UID = 'api::tenant-admin.tenant-admin';
const SHARED_APP_UID = 'api::shared-app.shared-app';
const S3_BUCKET = process.env.STRAPI_ADMIN_R2_BUCKET || process.env.STRAPI_ADMIN_S3_BUCKET || 'yengtesting';
const S3_REGION = process.env.STRAPI_ADMIN_R2_REGION || process.env.STRAPI_ADMIN_S3_REGION || 'auto';
const S3_IMAGES_PREFIX = process.env.STRAPI_ADMIN_S3_IMAGES_PREFIX || 'users';
const R2_PUBLIC_BASE_URL = String(process.env.STRAPI_ADMIN_R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const formatDateTime = (value) => {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleString();
};

const buildS3ConsoleFolderUrl = (tenantSlug, userId) => {
  if (!tenantSlug || !userId || !S3_BUCKET || !S3_REGION) return null;

  const prefix = `${S3_IMAGES_PREFIX}/${tenantSlug}/${userId}/images/`;
  if (R2_PUBLIC_BASE_URL) {
    return `${R2_PUBLIC_BASE_URL}/${prefix}`;
  }
  return (
    `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET}` +
    `?region=${encodeURIComponent(S3_REGION)}` +
    `&prefix=${encodeURIComponent(prefix)}` +
    '&showversions=false'
  );
};

const buildCollectionTypeListUrl = (slug, queryParams = {}) => {
  const url = new URL(
    `/admin/content-manager/collectionType/${slug}`,
    window.location.origin
  );

  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
};

const normalizePhone = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const compact = trimmed.replace(/[\s()-]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
};

const extractTenantRecord = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (Array.isArray(value?.connect)) {
    return value.connect[0] || null;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Object.prototype.hasOwnProperty.call(value, 'id') &&
    !Object.prototype.hasOwnProperty.call(value, 'name') &&
    !Object.prototype.hasOwnProperty.call(value, 'slug')
  ) {
    return null;
  }
  return value;
};

const resolveTenantIdsFromValue = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => Number(entry?.id || entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0);
  }
  if (Array.isArray(value?.connect)) {
    return value.connect
      .map((entry) => Number(entry?.id || entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0);
  }
  const directId = Number(value?.id || value);
  return Number.isInteger(directId) && directId > 0 ? [directId] : [];
};

const formatCallDuration = (seconds) => {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
  }

  return [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
};

const extractSharedAppVoiceEnabled = (response) => {
  const payload = response?.data?.data || response?.data || {};
  if (typeof payload?.enabled === 'boolean') {
    return payload.enabled;
  }

  return true;
};

const GalleryPreview = ({ items }) => {
  if (!items.length) {
    return (
      <Typography variant="omega" textColor="neutral500">
        No S3 gallery images found for this user yet.
      </Typography>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: '12px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
      }}
    >
      {items.map((item) => (
        <a
          key={item.key}
          href={item.signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none' }}
        >
          <div
            style={{
              border: '1px solid #dcdce4',
              borderRadius: '8px',
              overflow: 'hidden',
              background: '#ffffff',
            }}
          >
            <img
              src={item.signedUrl}
              alt={item.key}
              style={{
                width: '100%',
                height: '92px',
                objectFit: 'cover',
                display: 'block',
                background: '#f6f6f9',
              }}
            />
          </div>
        </a>
      ))}
    </div>
  );
};

const normalizeGalleryItems = (response) => {
  if (Array.isArray(response?.data?.data)) return response.data.data;
  if (Array.isArray(response?.data)) return response.data;
  return [];
};

const fetchAllEntryIds = async (get, slug) => {
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  const ids = [];

  do {
    const response = await get(`/content-manager/collection-types/${slug}`, {
      params: {
        page,
        pageSize,
      },
    });

    const items = response?.data?.results || response?.data || [];
    items.forEach((item) => {
      if (item?.id) {
        ids.push(item.id);
      }
    });

    const pagination = response?.pagination || response?.data?.pagination;
    pageCount = pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  return ids;
};

const AppUserPanel = () => {
  const { slug, initialData, modifiedData } = useCMEditViewDataManager();
  const { get } = useFetchClient();
  const toggleNotification = useNotification();
  const [galleryItems, setGalleryItems] = useState([]);
  const [isGalleryLoading, setIsGalleryLoading] = useState(false);
  const [canViewUserImages, setCanViewUserImages] = useState(false);
  const [isCapabilitiesLoading, setIsCapabilitiesLoading] = useState(true);

  const isAppUser = slug === APP_USER_UID;
  const userId = initialData?.id;

  const createdAtText = useMemo(
    () => formatDateTime(initialData?.createdAt),
    [initialData?.createdAt]
  );
  const updatedAtText = useMemo(
    () => formatDateTime(initialData?.updatedAt),
    [initialData?.updatedAt]
  );
  const tenantRecord = extractTenantRecord(modifiedData?.tenant) || extractTenantRecord(initialData?.tenant);
  const tenantSlug = tenantRecord?.slug;
  const userImagesUrl = useMemo(() => buildS3ConsoleFolderUrl(tenantSlug, userId), [tenantSlug, userId]);

  useEffect(() => {
    let isMounted = true;

    const loadCapabilities = async () => {
      try {
        setIsCapabilitiesLoading(true);
        const capabilities = await fetchTenantAdminCapabilities();
        if (!isMounted) return;
        setCanViewUserImages(canCurrentAdminViewUserImages(capabilities));
      } catch (_error) {
        if (!isMounted) return;
        // The backend still protects image endpoints. Do not hide images from
        // privileged admins solely because this auxiliary capability call fails.
        setCanViewUserImages(true);
      } finally {
        if (isMounted) {
          setIsCapabilitiesLoading(false);
        }
      }
    };

    void loadCapabilities();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadGallery = async () => {
      if (!isAppUser || !userId || !canViewUserImages) {
        setGalleryItems([]);
        setIsGalleryLoading(false);
        return;
      }

      try {
        setIsGalleryLoading(true);
        const response = await get(`/app-user-gallery/${userId}`);
        if (!isMounted) return;

        setGalleryItems(normalizeGalleryItems(response));
      } catch (error) {
        if (!isMounted) return;

        setGalleryItems([]);
        const status = error?.response?.status || error?.status;
        if (status === 403 || status === 404) {
          return;
        }

        toggleNotification({
          type: 'warning',
          message: error?.message || 'Failed to load signed gallery images.',
        });
      } finally {
        if (isMounted) {
          setIsGalleryLoading(false);
        }
      }
    };

    loadGallery();

    return () => {
      isMounted = false;
    };
  }, [canViewUserImages, get, isAppUser, toggleNotification, userId]);

  if (!isAppUser || isCapabilitiesLoading) return null;

  const openUserContacts = () => {
    if (!userId) return;

    window.location.assign(
      buildCollectionTypeListUrl(CONTACT_UID, {
        page: '1',
        pageSize: '25',
        sort: 'name:asc',
        'filters[user][id][$eq]': String(userId),
      })
    );
  };

  const openUserImages = () => {
    if (!userImagesUrl) return;
    window.open(userImagesUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          User Timeline
        </Typography>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Tenant
          </Typography>
          <Typography variant="pi">{tenantRecord?.name || tenantRecord?.slug || 'Not assigned'}</Typography>
        </Box>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Created At
          </Typography>
          <Typography variant="pi">{createdAtText}</Typography>
        </Box>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Updated At
          </Typography>
          <Typography variant="pi">{updatedAtText}</Typography>
        </Box>

        <Button
          variant="secondary"
          size="S"
          endIcon={<ExternalLink />}
          onClick={openUserContacts}
          disabled={!userId}
          fullWidth
        >
          Open User Contacts
        </Button>

        {canViewUserImages ? (
          <>
            <Button
              variant="secondary"
              size="S"
              endIcon={<ExternalLink />}
              onClick={openUserImages}
              disabled={!userImagesUrl}
              fullWidth
            >
              Open User Images (S3)
            </Button>

            <Box>
              <Typography variant="omega" textColor="neutral600">
                Signed Gallery Preview
              </Typography>
              {isGalleryLoading ? (
                <Typography variant="omega" textColor="neutral500">
                  Loading gallery images...
                </Typography>
              ) : (
                <GalleryPreview items={galleryItems} />
              )}
            </Box>

            <Typography variant="omega" textColor="neutral500">
              Opens Contacts filtered by this user, the user's S3 image folder, and shows signed gallery previews.
            </Typography>
          </>
        ) : (
          <Typography variant="omega" textColor="neutral500">
            Your role does not include user image viewing.
          </Typography>
        )}
      </Flex>
    </Box>
  );
};

const VoiceCallPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const { get } = useFetchClient();
  const toggleNotification = useNotification();
  const deviceRef = useRef(null);
  const callRef = useRef(null);
  const acceptedAtRef = useRef(null);
  const timerRef = useRef(null);
  const [isVoicePanelEnabled, setIsVoicePanelEnabled] = useState(true);
  const [isVoicePanelLoading, setIsVoicePanelLoading] = useState(true);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);
  const [callStatus, setCallStatus] = useState('Ready to call');

  const supportedSlug = slug === CONTACT_UID || slug === APP_USER_UID;
  const phone = normalizePhone(initialData?.phone);

  useEffect(() => () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
    }
    callRef.current?.disconnect?.();
    deviceRef.current?.destroy?.();
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadSharedAppConfig = async () => {
      try {
        setIsVoicePanelLoading(true);
        const response = await get('/shared-app/voice-panel-state');
        if (!isMounted) return;

        setIsVoicePanelEnabled(extractSharedAppVoiceEnabled(response));
      } catch (_error) {
        if (!isMounted) return;
        setIsVoicePanelEnabled(false);
      } finally {
        if (isMounted) {
          setIsVoicePanelLoading(false);
        }
      }
    };

    loadSharedAppConfig();

    return () => {
      isMounted = false;
    };
  }, [get]);

  if (!supportedSlug || !phone || isVoicePanelLoading || !isVoicePanelEnabled) return null;

  const stopDurationTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const resetCallUiState = (nextStatus) => {
    stopDurationTimer();
    callRef.current = null;
    acceptedAtRef.current = null;
    setIsCalling(false);
    setIsPreparing(false);
    setIsMuted(false);
    setCallDurationSeconds(0);
    setCallStatus(nextStatus);
  };

  const startDurationTimer = () => {
    stopDurationTimer();
    acceptedAtRef.current = Date.now();
    setCallDurationSeconds(0);
    timerRef.current = window.setInterval(() => {
      if (!acceptedAtRef.current) return;
      const elapsed = Math.floor((Date.now() - acceptedAtRef.current) / 1000);
      setCallDurationSeconds(elapsed);
    }, 1000);
  };

  const fetchVoiceToken = async () => {
    const response = await get('/twilio/voice/token');
    const payload = response?.data?.data || response?.data;
    if (!payload?.token) {
      throw new Error('Voice token response was missing a token.');
    }

    return payload.token;
  };

  const ensureDevice = async () => {
    if (deviceRef.current) {
      return deviceRef.current;
    }

    const token = await fetchVoiceToken();
    const device = new Device(token, {
      logLevel: 1,
    });

    device.on('registered', () => {
      setCallStatus('Phone ready');
    });

    device.on('error', (error) => {
      const message = error?.message || 'Twilio voice error';
      resetCallUiState(message);
      toggleNotification({
        type: 'warning',
        message,
      });
    });

    device.on('tokenWillExpire', async () => {
      try {
        const nextToken = await fetchVoiceToken();
        await device.updateToken(nextToken);
      } catch (error) {
        toggleNotification({
          type: 'warning',
          message: error?.message || 'Failed to refresh the Twilio voice token.',
        });
      }
    });

    await device.register();
    deviceRef.current = device;
    return device;
  };

  const startCall = async () => {
    if (isPreparing || isCalling) return;

    try {
      setIsPreparing(true);
      setCallStatus(`Preparing call to ${phone}...`);

      const device = await ensureDevice();
      const call = await device.connect({
        params: {
          To: phone,
        },
      });

      callRef.current = call;
      setIsCalling(true);
      setIsMuted(false);
      setCallDurationSeconds(0);
      setCallStatus(`Calling ${phone}...`);

      call.on('accept', () => {
        startDurationTimer();
        setCallStatus(`Connected to ${phone}`);
      });

      call.on('disconnect', () => {
        resetCallUiState('Call ended');
      });

      call.on('cancel', () => {
        resetCallUiState('Call cancelled');
      });

      call.on('error', (error) => {
        const message = error?.message || 'Call failed';
        resetCallUiState(message);
        toggleNotification({
          type: 'warning',
          message,
        });
      });
    } catch (error) {
      const message = error?.message || 'Failed to start the call.';
      setCallStatus(message);
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsPreparing(false);
    }
  };

  const hangUp = () => {
    callRef.current?.disconnect?.();
  };

  const toggleMute = () => {
    const activeCall = callRef.current;
    if (!activeCall || !isCalling) return;

    const nextMutedState = !isMuted;
    activeCall.mute(nextMutedState);
    setIsMuted(nextMutedState);
    setCallStatus(nextMutedState ? 'Call muted' : `Connected to ${phone}`);
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Twilio Voice
        </Typography>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Target Number
          </Typography>
          <Typography variant="pi">{phone}</Typography>
        </Box>

        <Flex justifyContent="space-between" alignItems="center" gap={2}>
          <Typography variant="omega" textColor="neutral600">
            Duration
          </Typography>
          <Typography variant="pi">
            {isCalling ? formatCallDuration(callDurationSeconds) : '00:00'}
          </Typography>
        </Flex>

        <Typography variant="omega" textColor="neutral500">
          {callStatus}
        </Typography>

        <Flex gap={2} wrap="wrap">
          <Button
            variant="success"
            size="S"
            onClick={startCall}
            disabled={isPreparing || isCalling}
          >
            {isPreparing ? 'Preparing...' : isCalling ? 'Calling...' : 'Call'}
          </Button>

          <Button
            variant="secondary"
            size="S"
            onClick={toggleMute}
            disabled={!isCalling}
          >
            {isMuted ? 'Unmute' : 'Mute'}
          </Button>

          <Button
            variant="danger-light"
            size="S"
            onClick={hangUp}
            disabled={!isCalling}
          >
            Hang Up
          </Button>
        </Flex>

        <Typography variant="omega" textColor="neutral500">
          Quick call controls for the current record. Uses the Twilio Voice JavaScript SDK inside the Strapi admin UI.
        </Typography>
      </Flex>
    </Box>
  );
};

const normalizeHexColor = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'Not set';

  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : trimmed;
};

const DEFAULT_TENANT_COLOR = '#4D2C91';
const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';

const findTenantFieldInput = (fieldName) =>
  document.querySelector(
    `input[name="${fieldName}"], textarea[name="${fieldName}"], [name="${fieldName}"] input`
  );

const findTenantFieldContainer = (fieldName) => {
  const input = findTenantFieldInput(fieldName);
  if (!input) return null;

  return (
    input.closest('[data-strapi-field]') ||
    input.closest('[class*="Field"]') ||
    input.parentElement?.parentElement ||
    input.parentElement
  );
};

const findFieldInput = (fieldName) =>
  document.querySelector(
    `input[name="${fieldName}"], textarea[name="${fieldName}"], select[name="${fieldName}"], [name="${fieldName}"] input`
  );

const findFieldContainer = (fieldName) => {
  const input = findFieldInput(fieldName);
  if (!input) return null;

  return (
    input.closest('[data-strapi-field]') ||
    input.closest('[class*="Field"]') ||
    input.parentElement?.parentElement ||
    input.parentElement
  );
};

const findTopLevelFieldBlock = (fieldName, labelCandidates = []) => {
  const baseContainer =
    findFieldContainer(fieldName) ||
    (labelCandidates.length ? findFieldContainerByLabel(labelCandidates) : null);

  if (!baseContainer) {
    return null;
  }

  let current = baseContainer;
  while (current?.parentElement) {
    const parent = current.parentElement;
    if (
      parent === document.body ||
      parent.id === 'root' ||
      parent.getAttribute?.('role') === 'main'
    ) {
      break;
    }

    const parentStyle = window.getComputedStyle(parent);
    const isLayoutCell =
      parentStyle.display === 'grid' ||
      parentStyle.display === 'inline-grid' ||
      parentStyle.display === 'flex' ||
      parentStyle.display === 'block';

    if (parent.childElementCount > 1 && isLayoutCell) {
      current = parent;
      break;
    }

    current = parent;
  }

  return current;
};

const normalizeFieldLabel = (value) => String(value || '').replace(/\*/g, '').trim().toLowerCase();

const findFieldContainerByLabel = (labelCandidates) => {
  const normalizedCandidates = labelCandidates.map(normalizeFieldLabel);
  const labels = Array.from(document.querySelectorAll('label, [role="label"]'));
  const matchingLabel = labels.find((label) => normalizedCandidates.includes(normalizeFieldLabel(label.textContent)));

  if (!matchingLabel) {
    return null;
  }

  return (
    matchingLabel.closest('[data-strapi-field]') ||
    matchingLabel.closest('[class*="Field"]') ||
    matchingLabel.parentElement?.parentElement ||
    matchingLabel.parentElement
  );
};

const useTenantFormEnhancements = ({
  slug,
  initialData,
  modifiedData,
  onChange,
}) => {
  useEffect(() => {
    const isTenantScreen = slug === TENANT_UID;
    if (!isTenantScreen) {
      return undefined;
    }

    if (!initialData?.id && !String(modifiedData?.app_api_key || '').trim()) {
      onChange({
        target: {
          name: 'app_api_key',
          value: MANAGED_API_KEY_PLACEHOLDER,
          type: 'string',
        },
      });
    }

    if (!String(modifiedData?.primary_color || '').trim()) {
      onChange({
        target: {
          name: 'primary_color',
          value: DEFAULT_TENANT_COLOR,
          type: 'string',
        },
      });
    }

    const applyEnhancements = () => {
      const apiKeyInput = findTenantFieldInput('app_api_key');
      const apiKeyContainer = findTenantFieldContainer('app_api_key');
      if (apiKeyContainer) {
        apiKeyContainer.style.display = 'none';
      }

      if (apiKeyInput) {
        apiKeyInput.readOnly = true;
        apiKeyInput.setAttribute('aria-readonly', 'true');
        apiKeyInput.setAttribute('title', 'Use the Tenant Security panel to copy or rotate this key.');
        apiKeyInput.style.backgroundColor = '#f6f6f9';
        apiKeyInput.style.cursor = 'not-allowed';
      }

      const primaryColorInput = findTenantFieldInput('primary_color');
      if (primaryColorInput) {
        const normalized = normalizeHexColor(primaryColorInput.value || primaryColorInput.defaultValue);
        primaryColorInput.type = 'color';
        primaryColorInput.value = normalized === 'Not set' ? DEFAULT_TENANT_COLOR : normalized;
        primaryColorInput.style.padding = '2px';
        primaryColorInput.style.minHeight = '40px';
        primaryColorInput.style.cursor = 'pointer';
      }
    };

    const intervalId = window.setInterval(applyEnhancements, 600);
    applyEnhancements();

    return () => window.clearInterval(intervalId);
  }, [slug, initialData?.id, modifiedData?.app_api_key, modifiedData?.primary_color, onChange]);
};

const useTenantAdminFormEnhancements = ({ slug }) => {
  useEffect(() => {
    if (slug !== TENANT_ADMIN_UID) {
      return undefined;
    }

    const applyEnhancements = () => {
      const isCreatePage = window.location.pathname.endsWith('/create');
      const adminUserIdContainer = findFieldContainer('admin_user_id');
      if (adminUserIdContainer) {
        adminUserIdContainer.style.display = 'none';
      }

      const adminEmailInput = findFieldInput('admin_email');
      if (adminEmailInput) {
        adminEmailInput.type = 'email';
        adminEmailInput.placeholder = 'Enter a Strapi admin email (new or existing)';
        adminEmailInput.autocomplete = 'email';
      }
      const adminEmailContainer = findFieldContainer('admin_email');
      if (adminEmailContainer && !adminEmailContainer.querySelector('[data-tenant-admin-admin-email-hint="true"]')) {
        const hint = document.createElement('div');
        hint.dataset.tenantAdminAdminEmailHint = 'true';
        hint.textContent = 'Use an existing Strapi admin email, or enter a temporary password below to create one.';
        hint.style.marginTop = '6px';
        hint.style.fontSize = '12px';
        hint.style.color = '#666687';
        adminEmailContainer.appendChild(hint);
      }

      const tenantNameInput = findFieldInput('tenant_name');
      if (tenantNameInput) {
        tenantNameInput.placeholder = 'Enter the customer-facing tenant name for this admin QR';
      }

      const tenantContainer =
        findFieldContainer('tenant') ||
        findFieldContainerByLabel(['Linked Tenant', 'Tenant']);
      if (tenantContainer) {
        if (isCreatePage) {
          tenantContainer.style.display = 'none';
        } else if (!tenantContainer.querySelector('[data-tenant-admin-tenant-hint="true"]')) {
          const hint = document.createElement('div');
          hint.dataset.tenantAdminTenantHint = 'true';
          hint.textContent = 'This edit page stays single-tenant. Delete the record if you want to remove this tenant assignment.';
          hint.style.marginTop = '6px';
          hint.style.fontSize = '12px';
          hint.style.color = '#666687';
          tenantContainer.appendChild(hint);
        }
      }

      if (isCreatePage) {
        // Tenant Admin creation uses the custom multi-tenant action below.
        // The native Save submits an empty relation payload before that action.
        document.querySelectorAll('button[type="submit"]').forEach((button) => {
          if (/^save$/i.test(String(button.textContent || '').trim())) {
            button.style.display = 'none';
          }
        });

        const qrTokenContainer = findFieldContainer('qr_token');
        if (qrTokenContainer) {
          qrTokenContainer.style.display = 'none';
        }

        const qrUrlContainer = findFieldContainer('qr_code_url');
        if (qrUrlContainer) {
          qrUrlContainer.style.display = 'none';
        }
      }
    };

    const intervalId = window.setInterval(applyEnhancements, 600);
    applyEnhancements();

    return () => window.clearInterval(intervalId);
  }, [slug]);
};

const TenantAdminCreateTenantSelector = () => {
  const { slug, initialData, modifiedData } = useCMEditViewDataManager();
  const { get, post } = useFetchClient();
  const toggleNotification = useNotification();
  const [options, setOptions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingTenantId, setPendingTenantId] = useState('');
  const [mountNode, setMountNode] = useState(null);
  const [actionMountNode, setActionMountNode] = useState(null);
  const isCreatePage = slug === TENANT_ADMIN_UID;
  const [selectedTenantIds, setSelectedTenantIds] = useState([]);
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [confirmNewAccountPassword, setConfirmNewAccountPassword] = useState('');

  useEffect(() => {
    if (!isCreatePage) {
      return undefined;
    }

    let isMounted = true;

    const loadTenants = async () => {
      try {
        setIsLoading(true);
        const response = await get('/tenant-admin/available-tenants');
        if (!isMounted) return;

        const results = response?.data?.data || response?.data || [];
        setOptions(
          results.map((tenant) => ({
            id: tenant.id,
            label: tenant.name || tenant.slug || String(tenant.id),
          }))
        );
      } catch (error) {
        if (!isMounted) return;
        toggleNotification({
          type: 'warning',
          message: 'Failed to load tenants for bulk Tenant Admin creation.',
        });
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadTenants();

    return () => {
      isMounted = false;
    };
  }, [get, isCreatePage, toggleNotification]);

  useEffect(() => {
    if (!isCreatePage) {
      setMountNode(null);
      setActionMountNode(null);
      return undefined;
    }

    let disposed = false;
    let hostNode = null;
    let actionHostNode = null;
    let targetContainer = null;
    let tenantNameContainer = null;
    let restoreDisplay = null;

    const attach = () => {
      if (disposed) {
        return;
      }

      targetContainer =
        findFieldContainer('tenant') ||
        findFieldContainerByLabel(['Linked Tenant', 'Tenant']);

      if (!targetContainer || !targetContainer.parentElement) {
        return;
      }

      if (!hostNode) {
        hostNode = document.createElement('div');
        hostNode.dataset.tenantAdminBulkCreateHost = 'true';
        hostNode.style.marginTop = '8px';
      }

      if (!hostNode.parentElement) {
        targetContainer.parentElement.insertBefore(hostNode, targetContainer.nextSibling);
      }

      if (restoreDisplay === null) {
        restoreDisplay = targetContainer.style.display;
      }
      targetContainer.style.display = 'none';
      setMountNode(hostNode);

      tenantNameContainer = findFieldContainer('tenant_name') || findFieldContainerByLabel(['Tenant Name']);
      if (tenantNameContainer?.parentElement) {
        const tenantNameRow = tenantNameContainer.parentElement.parentElement || tenantNameContainer.parentElement;
        tenantNameRow.style.position = 'relative';
        tenantNameRow.style.paddingRight = '220px';

        if (!actionHostNode) {
          actionHostNode = document.createElement('div');
          actionHostNode.dataset.tenantAdminBulkCreateActionHost = 'true';
          actionHostNode.style.position = 'absolute';
          actionHostNode.style.right = '16px';
          actionHostNode.style.bottom = '0';
          actionHostNode.style.display = 'flex';
          actionHostNode.style.justifyContent = 'flex-end';
          actionHostNode.style.alignItems = 'center';
        }

        if (!actionHostNode.parentElement) {
          tenantNameRow.appendChild(actionHostNode);
        }

        setActionMountNode(actionHostNode);
      }
    };

    const timer = window.setInterval(attach, 500);
    attach();

    return () => {
      disposed = true;
      window.clearInterval(timer);
      setMountNode(null);
      setActionMountNode(null);

      if (targetContainer) {
        targetContainer.style.display = restoreDisplay ?? '';
      }

      if (hostNode?.parentElement) {
        hostNode.parentElement.removeChild(hostNode);
      }

      if (actionHostNode?.parentElement) {
        actionHostNode.parentElement.removeChild(actionHostNode);
      }
    };
  }, [isCreatePage]);

  const submitCreate = async (event) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    if (event?.stopPropagation) {
      event.stopPropagation();
    }

    if (isSubmitting) {
      return;
    }

    const adminEmail = String(modifiedData?.admin_email || '').trim();
    if (!adminEmail) {
      toggleNotification({
        type: 'warning',
        message: 'Admin Email is required.',
      });
      return;
    }

    if (!selectedTenantIds.length) {
      toggleNotification({
        type: 'warning',
        message: 'Please select at least one tenant.',
      });
      return;
    }

    if (newAccountPassword !== confirmNewAccountPassword) {
      toggleNotification({
        type: 'warning',
        message: 'Temporary password and confirmation do not match.',
      });
      return;
    }

    try {
      setIsSubmitting(true);
      await post('/tenant-admin/bulk-create', {
        admin_email: adminEmail,
        role: modifiedData?.role || 'tenant_admin',
        tenant_name: String(modifiedData?.tenant_name || '').trim() || null,
        tenantIds: selectedTenantIds,
        adminLeaderId: resolveTenantIdsFromValue(modifiedData?.admin_leader)[0] || null,
        newAccountPassword: newAccountPassword || null,
      });
      toggleNotification({
        type: 'success',
        message: selectedTenantIds.length > 1
          ? 'Tenant Admin records created.'
          : 'Tenant Admin record created.',
      });
      window.location.assign(
        buildCollectionTypeListUrl(TENANT_ADMIN_UID, {
          page: '1',
          pageSize: '10',
          sort: 'id:ASC',
        })
      );
    } catch (error) {
      const message =
        error?.response?.data?.error?.message ||
        error?.message ||
        'Failed to create Tenant Admin records.';
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isCreatePage) {
    return null;
  }

  const selectedOptions = selectedTenantIds
    .map((id) => options.find((tenant) => tenant.id === id))
    .filter(Boolean);

  const availableOptions = options.filter((tenant) => !selectedTenantIds.includes(tenant.id));

  const addSelectedTenant = (event) => {
    if (event?.preventDefault) {
      event.preventDefault();
    }
    if (event?.stopPropagation) {
      event.stopPropagation();
    }

    const nextId = Number(pendingTenantId);
    if (!Number.isInteger(nextId) || nextId <= 0 || selectedTenantIds.includes(nextId)) {
      return;
    }

    setSelectedTenantIds((current) => [...current, nextId]);
    setPendingTenantId('');
  };

  const removeTenant = (tenantId) => {
    setSelectedTenantIds((current) => current.filter((id) => id !== tenantId));
  };

  const content = (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3} alignItems="stretch">
        <Typography variant="pi" textColor="neutral600">
          Tenant Admin QR
        </Typography>

        <Typography variant="omega" textColor="neutral500">
          One QR record will be created per selected tenant.
        </Typography>

        <Box>
          <Typography
            variant="omega"
            textColor="neutral700"
            style={{ display: 'block', marginBottom: '6px' }}
          >
            Temporary password for a new admin account
          </Typography>
          <input
            type="password"
            value={newAccountPassword}
            onChange={(event) => setNewAccountPassword(event.target.value)}
            disabled={isSubmitting}
            autoComplete="new-password"
            placeholder="Leave blank when the admin email already exists"
            style={{
              width: '100%',
              minHeight: '40px',
              border: '1px solid #dcdce4',
              borderRadius: '4px',
              padding: '0 12px',
              background: '#ffffff',
              color: '#32324d',
            }}
          />
        </Box>

        <Box>
          <Typography
            variant="omega"
            textColor="neutral700"
            style={{ display: 'block', marginBottom: '6px' }}
          >
            Confirm temporary password
          </Typography>
          <input
            type="password"
            value={confirmNewAccountPassword}
            onChange={(event) => setConfirmNewAccountPassword(event.target.value)}
            disabled={isSubmitting}
            autoComplete="new-password"
            placeholder="Required only when creating a new admin account"
            style={{
              width: '100%',
              minHeight: '40px',
              border: '1px solid #dcdce4',
              borderRadius: '4px',
              padding: '0 12px',
              background: '#ffffff',
              color: '#32324d',
            }}
          />
          <Typography variant="omega" textColor="neutral600" style={{ display: 'block', marginTop: '6px' }}>
            The password must contain uppercase, lowercase, and a number. Ask the new admin to change it after signing in.
          </Typography>
        </Box>

        <Flex gap={2} alignItems="flex-end">
          <Box style={{ flex: 1 }}>
            <Typography
              variant="omega"
              textColor="neutral700"
              style={{ display: 'block', marginBottom: '6px' }}
            >
              Add Tenant
            </Typography>
            <select
              value={pendingTenantId}
              onChange={(event) => setPendingTenantId(event.target.value)}
              disabled={isLoading || isSubmitting || !availableOptions.length}
              style={{
                width: '100%',
                minHeight: '40px',
                border: '1px solid #dcdce4',
                borderRadius: '4px',
                padding: '0 12px',
                background: '#ffffff',
                color: '#32324d',
              }}
            >
              <option value="">
                {isLoading
                  ? 'Loading tenants...'
                  : availableOptions.length
                    ? 'Select a tenant to add'
                    : 'All tenants selected'}
              </option>
              {availableOptions.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.label}
                </option>
              ))}
            </select>
          </Box>
          <Button
            variant="secondary"
            size="S"
            type="button"
            disabled={!pendingTenantId || isSubmitting}
            onClick={addSelectedTenant}
          >
            Add
          </Button>
        </Flex>

        <Box
          background="neutral0"
          borderColor="neutral200"
          hasRadius
          padding={2}
        >
          {selectedOptions.length ? (
            <Flex gap={2} wrap="wrap">
              {selectedOptions.map((tenant) => (
                <Box
                  key={tenant.id}
                  background="primary100"
                  borderColor="primary200"
                  hasRadius
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <Flex gap={2} alignItems="center">
                    <Typography variant="pi" textColor="primary700">
                      {tenant.label}
                    </Typography>
                    <button
                      type="button"
                      onClick={() => removeTenant(tenant.id)}
                      disabled={isSubmitting}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: '#4945ff',
                        cursor: isSubmitting ? 'default' : 'pointer',
                        fontSize: '14px',
                        lineHeight: 1,
                        padding: 0,
                      }}
                      aria-label={`Remove ${tenant.label}`}
                    >
                      ×
                    </button>
                  </Flex>
                </Box>
              ))}
            </Flex>
          ) : (
            <Typography variant="omega" textColor="neutral600">
              No tenants selected yet.
            </Typography>
          )}
        </Box>
      </Flex>
    </Box>
  );

  const actionContent = (
    <Button
      type="button"
      onClick={submitCreate}
      loading={isSubmitting}
      disabled={isLoading}
    >
      Create tenant admin records
    </Button>
  );

  if (mountNode || actionMountNode) {
    return (
      <>
        {mountNode ? createPortal(content, mountNode) : null}
        {actionMountNode ? createPortal(actionContent, actionMountNode) : null}
      </>
    );
  }

  return (
    <>
      {content}
      <Flex justifyContent="flex-end" marginTop={3}>
        {actionContent}
      </Flex>
    </>
  );
};

const ReadOnlyField = ({ label, value, monospace = false }) => (
  <Box
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '4px',
    }}
  >
    <Typography
      variant="omega"
      textColor="neutral600"
      style={{
        display: 'block',
        width: '100%',
      }}
    >
      {label}
    </Typography>
    <Typography
      variant="pi"
      style={{
        display: 'block',
        width: '100%',
        fontFamily: monospace ? 'monospace' : undefined,
        wordBreak: monospace ? 'break-all' : 'normal',
        lineHeight: 1.5,
      }}
    >
      {value || 'Not set'}
    </Typography>
  </Box>
);

const AppUserSelfiePreview = () => {
  const { slug, initialData, modifiedData } = useCMEditViewDataManager();
  const { get } = useFetchClient();
  const toggleNotification = useNotification();
  const [mountNode, setMountNode] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [canViewUserImages, setCanViewUserImages] = useState(false);
  const [isCapabilitiesLoading, setIsCapabilitiesLoading] = useState(true);
  const isAppUser = slug === APP_USER_UID;
  const selfieUrl = String(modifiedData?.image_url || initialData?.image_url || '').trim();
  const userId = initialData?.id;

  useEffect(() => {
    let isMounted = true;

    const loadCapabilities = async () => {
      try {
        setIsCapabilitiesLoading(true);
        const capabilities = await fetchTenantAdminCapabilities();
        if (!isMounted) return;
        setCanViewUserImages(canCurrentAdminViewUserImages(capabilities));
      } catch (_error) {
        if (!isMounted) return;
        setCanViewUserImages(true);
      } finally {
        if (isMounted) {
          setIsCapabilitiesLoading(false);
        }
      }
    };

    void loadCapabilities();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const imageUrlContainer =
      findFieldContainer('image_url') ||
      findFieldContainerByLabel(['image_url', 'Image Url']);
    const existingPreviewHost =
      imageUrlContainer?.parentElement?.querySelector('[data-app-user-selfie-preview="true"]');

    if (!isAppUser || !canViewUserImages) {
      if (existingPreviewHost) {
        existingPreviewHost.remove();
      }
      setMountNode(null);
      return undefined;
    }

    let disposed = false;

    const attachPreviewHost = () => {
      const imageUrlContainer =
        findFieldContainer('image_url') ||
        findFieldContainerByLabel(['image_url', 'Image Url']);

      if (!imageUrlContainer) {
        return;
      }

      imageUrlContainer.style.display = 'none';

      let previewHost = imageUrlContainer.parentElement?.querySelector('[data-app-user-selfie-preview="true"]');
      if (!previewHost) {
        previewHost = document.createElement('div');
        previewHost.dataset.appUserSelfiePreview = 'true';
        previewHost.style.width = '100%';
        previewHost.style.marginTop = '8px';
        imageUrlContainer.insertAdjacentElement('afterend', previewHost);
      }

      if (!disposed) {
        setMountNode(previewHost);
      }
    };

    const intervalId = window.setInterval(attachPreviewHost, 600);
    attachPreviewHost();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [canViewUserImages, isAppUser, initialData?.id]);

  useEffect(() => {
    let isMounted = true;

    const loadPreview = async () => {
      if (!isAppUser || !userId || !selfieUrl || !canViewUserImages) {
        setPreviewUrl('');
        return;
      }

      try {
        const response = await get(`/app-user-selfie/${userId}`);
        if (!isMounted) return;

        setPreviewUrl(String(response?.data?.data?.signedUrl || selfieUrl).trim());
      } catch (error) {
        if (!isMounted) return;

        const status = error?.response?.status || error?.status;
        if (status === 403 || status === 404) {
          setPreviewUrl('');
          return;
        }

        setPreviewUrl(selfieUrl);
        toggleNotification({
          type: 'warning',
          message: 'Failed to load signed selfie preview. Falling back to the stored URL.',
        });
      }
    };

    loadPreview();

    return () => {
      isMounted = false;
    };
  }, [canViewUserImages, get, isAppUser, selfieUrl, toggleNotification, userId]);

  if (!isAppUser || isCapabilitiesLoading || !canViewUserImages || !mountNode) {
    return null;
  }

  return createPortal(
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="filterShadow"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <Typography variant="omega" textColor="neutral600">
        Selfie
      </Typography>

      {previewUrl || selfieUrl ? (
        <>
          <Box
            style={{
              maxWidth: '280px',
              border: '1px solid #dcdce4',
              borderRadius: '12px',
              overflow: 'hidden',
              background: '#ffffff',
            }}
          >
            <img
              src={previewUrl || selfieUrl}
              alt="User selfie"
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                objectFit: 'cover',
                background: '#f6f6f9',
              }}
            />
          </Box>
          <a
            href={previewUrl || selfieUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: '#4945ff',
              fontSize: '12px',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Open full image
          </a>
        </>
      ) : (
        <Typography variant="pi" textColor="neutral500">
          No selfie uploaded yet.
        </Typography>
      )}
    </Box>,
    mountNode
  );
};

const AppUserFieldLayout = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const isAppUser = slug === APP_USER_UID;

  useEffect(() => {
    if (!isAppUser || !initialData?.id) {
      return undefined;
    }

    let disposed = false;

    const moveUserIdField = () => {
      const userIdContainer =
        findFieldContainer('user_id') ||
        findFieldContainerByLabel(['user_id', 'User ID']);
      const phoneVerifiedContainer =
        findFieldContainer('phoneVerified') ||
        findFieldContainerByLabel(['phoneVerified', 'Phone Verified']);

      if (!userIdContainer || !phoneVerifiedContainer) {
        return;
      }

      const targetParent = phoneVerifiedContainer.parentElement;
      if (!targetParent) {
        return;
      }

      userIdContainer.style.width = '100%';
      userIdContainer.style.marginBottom = '16px';
      userIdContainer.style.maxWidth = '100%';

      if (userIdContainer.parentElement !== targetParent || userIdContainer.nextSibling !== phoneVerifiedContainer) {
        targetParent.insertBefore(userIdContainer, phoneVerifiedContainer);
      }
    };

    const intervalId = window.setInterval(() => {
      if (!disposed) {
        moveUserIdField();
      }
    }, 600);

    moveUserIdField();

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [initialData?.id, isAppUser]);

  return null;
};

const TenantColorPanel = () => {
  const { slug, initialData, modifiedData, onChange } = useCMEditViewDataManager();
  const isTenantScreen = slug === TENANT_UID;
  useTenantFormEnhancements({ slug, initialData, modifiedData, onChange });
  if (!isTenantScreen) return null;
  if (!initialData?.id) return null;

  const primaryColor = normalizeHexColor(modifiedData?.primary_color || initialData?.primary_color || DEFAULT_TENANT_COLOR);

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Tenant Branding
        </Typography>

        <ReadOnlyField label="Primary Color Hex" value={primaryColor} monospace />
      </Flex>
    </Box>
  );
};

const TenantKeyPanel = () => {
  const { slug, initialData, modifiedData, onChange } = useCMEditViewDataManager();
  const { post } = useFetchClient();
  const toggleNotification = useNotification();
  const [apiKey, setApiKey] = useState(initialData?.app_api_key || '');
  const [isRotating, setIsRotating] = useState(false);
  const isTenantScreen = slug === TENANT_UID;

  useTenantFormEnhancements({ slug, initialData, modifiedData, onChange });

  useEffect(() => {
    setApiKey(initialData?.app_api_key || '');
  }, [initialData?.app_api_key, initialData?.id]);

  if (!isTenantScreen) return null;
  if (!initialData?.id) return null;

  const qrCodeUrl = String(modifiedData?.qr_code_url || initialData?.qr_code_url || '').trim();
  const apkUrl = String(modifiedData?.android_apk_url || initialData?.android_apk_url || '').trim();
  const deepLinkScheme = String(
    modifiedData?.android_deep_link_scheme || initialData?.android_deep_link_scheme || ''
  ).trim();
  const qrPreviewUrl = qrCodeUrl
    ? `${window.location.origin}/qr-code.svg?value=${encodeURIComponent(qrCodeUrl)}`
    : '';

  const copyApiKey = async () => {
    if (!apiKey) {
      toggleNotification({
        type: 'warning',
        message: 'No tenant API key is available to copy.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(apiKey);
      toggleNotification({
        type: 'success',
        message: 'Tenant API key copied.',
      });
    } catch (error) {
      toggleNotification({
        type: 'warning',
        message: 'Unable to copy the tenant API key.',
      });
    }
  };

  const copyQrCodeUrl = async () => {
    if (!qrCodeUrl) {
      toggleNotification({
        type: 'warning',
        message: 'No QR code URL is configured for this tenant.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(qrCodeUrl);
      toggleNotification({
        type: 'success',
        message: 'QR code URL copied.',
      });
    } catch (error) {
      toggleNotification({
        type: 'warning',
        message: 'Unable to copy the QR code URL.',
      });
    }
  };

  const rotateApiKey = async () => {
    const confirmed = window.confirm(
      'Rotate this tenant API key? Existing installed apps using the old key will stop working until rebuilt.'
    );
    if (!confirmed) return;

    try {
      setIsRotating(true);
      const response = await post(`/tenant-api-key/${initialData.id}/rotate`);
      const nextKey = response?.data?.data?.appApiKey || '';
      if (nextKey) {
        setApiKey(nextKey);
      }

      toggleNotification({
        type: 'success',
        message: 'Tenant API key rotated.',
      });
    } catch (error) {
      toggleNotification({
        type: 'warning',
        message: error?.message || 'Failed to rotate the tenant API key.',
      });
    } finally {
      setIsRotating(false);
    }
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Tenant Security
        </Typography>

        <Typography variant="omega" textColor="neutral500">
          Customer QR links are now generated per Tenant Admin. Open a Tenant Admin record to copy the unique QR URL.
        </Typography>

        <ReadOnlyField label="Tenant Slug" value={initialData?.slug} />
        <ReadOnlyField label="Android Application Id" value={initialData?.android_application_id} />
        <ReadOnlyField label="Deep Link Scheme" value={deepLinkScheme} monospace />
        <ReadOnlyField label="QR Code URL" value={qrCodeUrl} monospace />
        <ReadOnlyField label="Android APK URL" value={apkUrl} monospace />
        <ReadOnlyField label="Active API Key" value={apiKey} monospace />

        {qrPreviewUrl ? (
          <Box>
            <Typography variant="omega" textColor="neutral600">
              QR Code Preview
            </Typography>
            <Box
              style={{
                marginTop: '8px',
                padding: '12px',
                border: '1px solid #dcdce4',
                borderRadius: '12px',
                background: '#ffffff',
                display: 'inline-flex',
              }}
            >
              <img
                src={qrPreviewUrl}
                alt="Tenant QR code"
                style={{
                  width: '180px',
                  height: '180px',
                  display: 'block',
                }}
              />
            </Box>
          </Box>
        ) : null}

        <Flex gap={2} wrap="wrap">
          <Button
            variant="secondary"
            size="S"
            onClick={copyQrCodeUrl}
            disabled={!qrCodeUrl}
          >
            Copy QR URL
          </Button>

          <Button
            variant="secondary"
            size="S"
            onClick={copyApiKey}
            disabled={!apiKey}
          >
            Copy API Key
          </Button>

          <Button
            variant="danger-light"
            size="S"
            onClick={rotateApiKey}
            disabled={isRotating}
          >
            {isRotating ? 'Rotating...' : 'Rotate API Key'}
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
};

const BulkClearActions = () => {
  const [isClearing, setIsClearing] = useState(false);
  const [canRenderClearAction, setCanRenderClearAction] = useState(false);
  const [isCapabilityLoading, setIsCapabilityLoading] = useState(true);
  const { get, del } = useFetchClient();
  const toggleNotification = useNotification();
  const match = useRouteMatch('/content-manager/collectionType/:slug');
  const slug = match?.params?.slug;
  const isSupportedList =
    slug === APP_USER_UID || slug === CONTACT_UID || slug === TENANT_UID || slug === TENANT_ADMIN_UID;
  if (!isSupportedList) return null;

  const isUserList = slug === APP_USER_UID;
  const isContactList = slug === CONTACT_UID;
  const label = isUserList
    ? 'Clear All Users'
    : isContactList
      ? 'Clear All Contacts'
      : 'Not Allowed';
  const confirmText = isUserList
    ? 'Clear ALL Users? This will also delete all related Contacts, local profile images, and the users\' S3 gallery images.'
    : isContactList
      ? 'Clear ALL Contacts?'
      : '';

  useEffect(() => {
    let isMounted = true;

    const loadCapabilities = async () => {
      if (!isUserList && !isContactList) {
        if (isMounted) {
          setCanRenderClearAction(false);
          setIsCapabilityLoading(false);
        }
        return;
      }

      try {
        setIsCapabilityLoading(true);
        const response = await get('/tenant-admin/capabilities');
        if (!isMounted) return;

        const payload = response?.data?.data || {};
        setCanRenderClearAction(payload?.canDeleteManagedRecords !== false);
      } catch (_error) {
        if (!isMounted) return;
        setCanRenderClearAction(false);
      } finally {
        if (isMounted) {
          setIsCapabilityLoading(false);
        }
      }
    };

    void loadCapabilities();

    return () => {
      isMounted = false;
    };
  }, [get, isContactList, isUserList]);

  if (!isUserList && !isContactList) return null;
  if (isCapabilityLoading || !canRenderClearAction) return null;

  const clearAllEntries = async () => {
    if (isClearing) return;

    const confirmed = window.confirm(confirmText);
    if (!confirmed) return;

    try {
      setIsClearing(true);
      const ids = await fetchAllEntryIds(get, slug);

      for (const id of ids) {
        await del(`/content-manager/collection-types/${slug}/${id}`);
      }

      toggleNotification({
        type: 'success',
        message: `${label} completed.`,
      });
      window.location.assign(buildCollectionTypeListUrl(slug));
    } catch (error) {
      const message = error?.message || `Failed to run ${label}.`;
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Button
      variant="danger-light"
      size="S"
      onClick={clearAllEntries}
      disabled={isClearing}
    >
      {isClearing ? `${label}...` : label}
    </Button>
  );
};

const extractSelectedContactIds = () => {
  const selectedCheckboxes = Array.from(
    document.querySelectorAll('tbody input[type="checkbox"]:checked')
  );

  const ids = selectedCheckboxes
    .map((checkbox) => {
      const row = checkbox.closest('tr');
      if (!row) return null;

      const recordLink = row.querySelector(`a[href*="/content-manager/collectionType/${CONTACT_UID}/"]`);
      const href = recordLink?.getAttribute('href') || '';
      const match = href.match(/\/content-manager\/collectionType\/api::contact\.contact\/(\d+)(?:\?.*)?$/);
      return match?.[1] ? Number(match[1]) : null;
    })
    .filter((value) => Number.isInteger(value) && value > 0);

  return [...new Set(ids)];
};

const ContactExportAction = () => {
  const [canExportContacts, setCanExportContacts] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const toggleNotification = useNotification();
  const { get } = useFetchClient();
  const match = useRouteMatch('/content-manager/collectionType/:slug');
  const slug = match?.params?.slug;
  const isContactList = slug === CONTACT_UID;

  useEffect(() => {
    let isMounted = true;

    const loadCapabilities = async () => {
      if (!isContactList) {
        if (isMounted) {
          setCanExportContacts(true);
        }
        return;
      }

      try {
        const capabilities = await fetchTenantAdminCapabilities();
        if (!isMounted) return;
        setCanExportContacts(capabilities?.canExportContacts !== false);
      } catch (_error) {
        if (!isMounted) return;
        setCanExportContacts(true);
      }
    };

    void loadCapabilities();

    return () => {
      isMounted = false;
    };
  }, [isContactList]);

  if (!isContactList || !canExportContacts) {
    return null;
  }

  const exportContacts = async () => {
    if (isExporting) return;

    try {
      setIsExporting(true);
      const currentUrl = new URL(window.location.href);
      const exportUrl = new URL('/admin/contact-export', window.location.origin);
      currentUrl.searchParams.forEach((value, key) => {
        exportUrl.searchParams.append(key, value);
      });

      const selectedIds = extractSelectedContactIds();
      if (selectedIds.length) {
        exportUrl.searchParams.set('selectedIds', selectedIds.join(','));
      }

      const response = await get('/contact-export', {
        params: Object.fromEntries(exportUrl.searchParams.entries()),
        responseType: 'blob',
      });

      const contentDisposition = response?.headers?.['content-disposition'] || '';
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/i);
      const filename = filenameMatch?.[1] || 'contacts-export.csv';
      const blob = response?.data instanceof Blob
        ? response.data
        : new Blob([response?.data], { type: 'text/csv;charset=utf-8' });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      toggleNotification({
        type: 'success',
        message: selectedIds.length
          ? `Exporting ${selectedIds.length} selected contact(s).`
          : 'Contact export started.',
      });
    } catch (_error) {
      toggleNotification({
        type: 'warning',
        message: 'Failed to start contact export.',
      });
    } finally {
      window.setTimeout(() => {
        setIsExporting(false);
      }, 1000);
    }
  };

  return (
    <Button
      variant="secondary"
      size="S"
      onClick={() => {
        void exportContacts();
      }}
      disabled={isExporting}
    >
      {isExporting ? 'Exporting...' : 'Export Contacts'}
    </Button>
  );
};

const TenantAdminQrListCopyButtons = () => {
  const match = useRouteMatch('/content-manager/collectionType/:slug');
  const slug = match?.params?.slug;
  const toggleNotification = useNotification();

  useEffect(() => {
    if (slug !== TENANT_ADMIN_UID) {
      return undefined;
    }

    let isDisposed = false;
    let observer = null;

    const copyText = async (value) => {
      if (!value) return;

      try {
        await navigator.clipboard.writeText(value);
        toggleNotification({
          type: 'success',
          message: 'QR URL copied.',
        });
      } catch (error) {
        toggleNotification({
          type: 'warning',
          message: 'Failed to copy QR URL.',
        });
      }
    };

    const buildButton = (value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Copy QR URL';
      button.dataset.qrCopyButton = 'true';
      button.style.marginLeft = '12px';
      button.style.padding = '4px 10px';
      button.style.border = '1px solid #c0c0cf';
      button.style.borderRadius = '6px';
      button.style.background = '#f6f6f9';
      button.style.color = '#4945ff';
      button.style.cursor = 'pointer';
      button.style.fontSize = '12px';
      button.style.fontWeight = '600';
      button.style.flexShrink = '0';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(value);
      });
      return button;
    };

    const enhanceQrCells = () => {
      if (isDisposed) return;

      const tables = Array.from(document.querySelectorAll('table'));
      tables.forEach((table) => {
        const headerCells = Array.from(table.querySelectorAll('thead th'));
        const qrHeaderIndex = headerCells.findIndex((cell) =>
          String(cell.textContent || '').trim().toUpperCase() === 'QR URL'
        );

        if (qrHeaderIndex === -1) {
          return;
        }

        const rows = Array.from(table.querySelectorAll('tbody tr'));
        rows.forEach((row) => {
          const cells = Array.from(row.querySelectorAll('td'));
          const qrCell = cells[qrHeaderIndex];
          if (!qrCell || qrCell.querySelector('[data-qr-copy-button="true"]')) {
            return;
          }

          const urlText = String(qrCell.textContent || '').trim();
          if (!urlText || urlText === '-') {
            return;
          }

          qrCell.style.whiteSpace = 'nowrap';
          const wrapper = document.createElement('div');
          wrapper.style.display = 'flex';
          wrapper.style.alignItems = 'center';
          wrapper.style.justifyContent = 'space-between';
          wrapper.style.gap = '8px';
          wrapper.style.width = '100%';

          const text = document.createElement('span');
          text.textContent = 'Ready';
          text.style.overflow = 'hidden';
          text.style.color = '#666687';
          text.style.fontSize = '12px';
          text.style.fontWeight = '600';
          text.style.textOverflow = 'ellipsis';
          text.style.whiteSpace = 'nowrap';
          text.style.display = 'block';
          text.style.flex = '1';

          wrapper.appendChild(text);
          wrapper.appendChild(buildButton(urlText));

          qrCell.textContent = '';
          qrCell.appendChild(wrapper);
        });
      });
    };

    const start = () => {
      enhanceQrCells();
      observer = new MutationObserver(() => {
        enhanceQrCells();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    };

    const timer = window.setTimeout(start, 0);

    return () => {
      isDisposed = true;
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [slug, toggleNotification]);

  return null;
};

const TenantAdminPanel = () => {
  const { slug, initialData, modifiedData } = useCMEditViewDataManager();
  useTenantAdminFormEnhancements({ slug });

  if (slug !== TENANT_ADMIN_UID) return null;

  const isCreatePage = !initialData?.id;

  if (isCreatePage) {
    return <TenantAdminCreateTenantSelector />;
  }

  const qrCodeUrl = String(modifiedData?.qr_code_url || initialData?.qr_code_url || '').trim();
  const qrToken = String(modifiedData?.qr_token || initialData?.qr_token || '').trim();
  const tenantName = String(modifiedData?.tenant_name || initialData?.tenant_name || '').trim();
  const tenantRecord = extractTenantRecord(modifiedData?.tenant) || extractTenantRecord(initialData?.tenant);
  const qrPreviewUrl = qrCodeUrl
    ? `${window.location.origin}/qr-code.svg?value=${encodeURIComponent(qrCodeUrl)}`
    : '';

  const copyQrCodeUrl = async () => {
    if (!qrCodeUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(qrCodeUrl);
    } catch (error) {
      // Ignore clipboard failures in the lightweight panel.
    }
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Tenant Admin QR
        </Typography>

        <ReadOnlyField label="Tenant Name" value={tenantName} />
        <ReadOnlyField label="Linked Tenant" value={tenantRecord?.name || tenantRecord?.slug || 'Not set'} />
        <ReadOnlyField label="QR URL" value={qrCodeUrl} monospace />
        <ReadOnlyField label="QR Token" value={qrToken} monospace />

        {qrPreviewUrl ? (
          <Box>
            <Typography variant="omega" textColor="neutral600">
              QR Code Preview
            </Typography>
            <Box
              style={{
                marginTop: '8px',
                padding: '12px',
                border: '1px solid #dcdce4',
                borderRadius: '12px',
                background: '#ffffff',
                display: 'inline-flex',
              }}
            >
              <img
                src={qrPreviewUrl}
                alt="Tenant admin QR code"
                style={{
                  width: '180px',
                  height: '180px',
                  display: 'block',
                }}
              />
            </Box>
          </Box>
        ) : null}

        <Button
          variant="secondary"
          size="S"
          onClick={copyQrCodeUrl}
          disabled={!qrCodeUrl}
        >
          Copy QR URL
        </Button>
      </Flex>
    </Box>
  );
};

const config = {
  locales: [],
};

const SETTINGS_USERS_PATH = '/admin/settings/users';
const APP_USERS_COLLECTION_PATH = '/admin/content-manager/collectionType/api::app-user.app-user';
const COLLECTION_LIST_STATE_KEY_PREFIX = 'contentManagerListState:';

const getCollectionRouteMatch = () => {
  const match = window.location.pathname.match(
    /^\/admin\/content-manager\/collectionType\/([^/]+)(?:\/([^/]+))?$/
  );

  if (!match) {
    return null;
  }

  return {
    slug: decodeURIComponent(match[1]),
    entitySegment: match[2] ? decodeURIComponent(match[2]) : '',
  };
};

const getCollectionListStateKey = (slug) => `${COLLECTION_LIST_STATE_KEY_PREFIX}${slug}`;

const persistCurrentCollectionListUrl = () => {
  if (typeof window === 'undefined') {
    return;
  }

  const routeMatch = getCollectionRouteMatch();
  if (!routeMatch || routeMatch.entitySegment) {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getCollectionListStateKey(routeMatch.slug),
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    );
  } catch (_error) {
    // Ignore storage failures.
  }
};

const restoreStoredCollectionBackLink = () => {
  if (typeof window === 'undefined') {
    return;
  }

  const routeMatch = getCollectionRouteMatch();
  if (!routeMatch || !routeMatch.entitySegment || routeMatch.entitySegment === 'create') {
    return;
  }

  let storedListUrl = '';
  try {
    storedListUrl = window.sessionStorage.getItem(getCollectionListStateKey(routeMatch.slug)) || '';
  } catch (_error) {
    storedListUrl = '';
  }

  if (!storedListUrl) {
    return;
  }

  const canonicalListPath = `/admin/content-manager/collectionType/${routeMatch.slug}`;
  const backLinks = Array.from(document.querySelectorAll('a[href], button'))
    .filter((node) => String(node.textContent || '').trim().toLowerCase() === 'back');

  backLinks.forEach((node) => {
    const href = node instanceof HTMLAnchorElement ? String(node.getAttribute('href') || '') : '';
    const isDefaultCollectionBackLink =
      node instanceof HTMLAnchorElement &&
      (href === canonicalListPath || href === `${canonicalListPath}?`);

    if (!(node instanceof HTMLAnchorElement) && !(node instanceof HTMLButtonElement)) {
      return;
    }

    if (node instanceof HTMLAnchorElement && !isDefaultCollectionBackLink) {
      return;
    }

    if (node.dataset.preservedListBound === 'true') {
      if (node instanceof HTMLAnchorElement) {
        node.setAttribute('href', storedListUrl);
      }
      return;
    }

    node.dataset.preservedListBound = 'true';

    if (node instanceof HTMLAnchorElement) {
      node.setAttribute('href', storedListUrl);
    }

    node.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.location.assign(storedListUrl);
      },
      true
    );
  });
};

const syncDescendingIdSort = (pathPrefix) => {
  if (!window.location.pathname.startsWith(pathPrefix)) {
    return;
  }

  const url = new URL(window.location.href);
  let changed = false;

  if (url.searchParams.get('sort') !== 'id:desc') {
    url.searchParams.set('sort', 'id:desc');
    changed = true;
  }

  if (changed) {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
};

const syncSettingsUsersQuery = () => {
  syncDescendingIdSort(SETTINGS_USERS_PATH);
};

const syncAppUsersQuery = () => {
  syncDescendingIdSort(APP_USERS_COLLECTION_PATH);
};

const syncCollectionListState = () => {
  persistCurrentCollectionListUrl();
  restoreStoredCollectionBackLink();
};

const installSettingsUsersSortGuard = () => {
  if (typeof window === 'undefined' || window.__settingsUsersSortGuardInstalled) {
    return;
  }

  window.__settingsUsersSortGuardInstalled = true;
  syncSettingsUsersQuery();

  const wrapHistoryMethod = (methodName) => {
    const original = window.history[methodName];
    window.history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.setTimeout(syncSettingsUsersQuery, 0);
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', syncSettingsUsersQuery);
};

const installAppUsersSortGuard = () => {
  if (typeof window === 'undefined' || window.__appUsersSortGuardInstalled) {
    return;
  }

  window.__appUsersSortGuardInstalled = true;
  syncAppUsersQuery();
  syncCollectionListState();

  const wrapHistoryMethod = (methodName) => {
    const original = window.history[methodName];
    window.history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.setTimeout(syncAppUsersQuery, 0);
      window.setTimeout(syncCollectionListState, 0);
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', syncAppUsersQuery);
  window.addEventListener('popstate', syncCollectionListState);

  const observer = new MutationObserver(() => {
    restoreStoredCollectionBackLink();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
};

const TENANT_ADMIN_CAPABILITIES_PATH = '/admin/tenant-admin/capabilities';
const SETTINGS_PATH_PREFIX = '/admin/settings';
const PROFILE_PATH_PREFIX = '/admin/me';
const TENANT_ADMIN_DEFAULT_PATH = '/admin/content-manager/collectionType/api::app-user.app-user';
const TENANT_ADMIN_COLLECTION_PATH = '/admin/content-manager/collectionType/api::tenant-admin.tenant-admin';
const TENANT_ADMIN_COLLECTION_API_PATH = '/content-manager/collection-types/api::tenant-admin.tenant-admin';
const TENANT_ADMIN_NAV_REDIRECT_KEY = 'tenantAdminNavRedirectRequested';
const TENANT_ADMIN_TARGET_PATH_KEY = 'tenantAdminTargetPath';
const ADMIN_ME_API_PATH = '/admin/users/me';
const ADMIN_LOGIN_PATH = '/admin/auth/login';
const ADMIN_LOGOUT_PATH = '/admin/logout';

const fetchTenantAdminCapabilities = async () => {
  const response = await fetch(TENANT_ADMIN_CAPABILITIES_PATH, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load tenant admin capabilities (${response.status})`);
  }

  const payload = await response.json();
  return payload?.data?.data || payload?.data || {};
};

const canCurrentAdminViewUserImages = (capabilities) => (
  // Tenant Admin is the only role deliberately excluded. The signed image
  // endpoints enforce this again, so a stale capability payload cannot expose data.
  capabilities?.isTenantAdminScoped !== true
);

const extractPasswordChangePayload = (body) => {
  if (!body) return null;

  let parsedBody = body;
  if (typeof body === 'string') {
    try {
      parsedBody = JSON.parse(body);
    } catch (_error) {
      return null;
    }
  }

  if (!parsedBody || typeof parsedBody !== 'object') {
    return null;
  }

  const candidates = [parsedBody, parsedBody.user, parsedBody.data].filter(
    (candidate) => candidate && typeof candidate === 'object'
  );

  return (
    candidates.find((candidate) =>
      ['currentPassword', 'password', 'confirmPassword'].some((key) =>
        Object.prototype.hasOwnProperty.call(candidate, key)
      )
    ) || null
  );
};

const extractTenantAdminPasswordErrorMessage = (payload) => {
  const error = payload?.error || {};
  const currentPasswordErrors = error?.details?.currentPassword;
  if (Array.isArray(currentPasswordErrors) && currentPasswordErrors.length) {
    const firstMessage = String(currentPasswordErrors[0] || '').trim();
    if (firstMessage) {
      return firstMessage === 'Invalid credentials'
        ? 'Current password is incorrect.'
        : firstMessage;
    }
  }

  const directMessage = String(error?.message || '').trim();
  if (directMessage && directMessage !== 'ValidationError') {
    return directMessage;
  }

  return 'Unable to change password. Please check your current password and try again.';
};

const replaceVisibleGenericAdminError = (message) => {
  const selectors = [
    '[role="alert"]',
    '[data-strapi-notification]',
    '[data-notification]',
    'div',
    'span',
    'p',
  ];

  selectors.forEach((selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    nodes.forEach((node) => {
      const text = String(node.textContent || '').trim();
      if (text === 'Warning: An error occurred' || text === 'An error occurred') {
        node.textContent = message;
      }
    });
  });
};

const replaceVisibleGenericAdminErrorWithRetries = (message) => {
  [0, 100, 300, 800].forEach((delay) => {
    window.setTimeout(() => {
      replaceVisibleGenericAdminError(message);
    }, delay);
  });
};

const forceTenantAdminLogoutAfterPasswordChange = () => {
  try {
    window.localStorage.clear();
  } catch (_error) {
    // Ignore storage cleanup failures.
  }

  try {
    window.sessionStorage.clear();
  } catch (_error) {
    // Ignore storage cleanup failures.
  }

  const loginUrl = `${ADMIN_LOGIN_PATH}?info=password-changed`;
  window.location.replace(ADMIN_LOGOUT_PATH);
  window.setTimeout(() => {
    window.location.replace(loginUrl);
  }, 400);
  window.setTimeout(() => {
    window.location.href = loginUrl;
  }, 1200);
};

const redirectTenantAdminToOwnRecord = async () => {
  if (typeof window === 'undefined' || window.__tenantAdminRecordRedirectInFlight) {
    return;
  }

  window.__tenantAdminRecordRedirectInFlight = true;

  try {
    const capabilities = await fetchTenantAdminCapabilities();
    const tenantAdminRecordId = capabilities?.tenantAdminRecordId || null;
    if (!tenantAdminRecordId) {
      return;
    }

    const detailPath = `${TENANT_ADMIN_COLLECTION_PATH}/${tenantAdminRecordId}`;
    try {
      window.sessionStorage.setItem(TENANT_ADMIN_TARGET_PATH_KEY, detailPath);
      window.sessionStorage.setItem(TENANT_ADMIN_NAV_REDIRECT_KEY, '1');
    } catch (_error) {
      // Ignore session storage failures.
    }

    if (window.location.pathname !== detailPath) {
      window.location.replace(detailPath);
      window.setTimeout(() => {
        if (window.location.pathname !== detailPath) {
          window.location.assign(detailPath);
        }
      }, 150);
      window.setTimeout(() => {
        if (window.location.pathname !== detailPath) {
          window.location.href = detailPath;
        }
      }, 600);
      return;
    }
  } catch (_error) {
    // Ignore redirect fallback failures.
  } finally {
    window.setTimeout(() => {
      window.__tenantAdminRecordRedirectInFlight = false;
    }, 1500);
  }
};

const hideTenantAdminNavigation = () => {
  const links = Array.from(document.querySelectorAll('a, button, [role="menuitem"]'));

  links.forEach((node) => {
    const rawHref = node instanceof HTMLAnchorElement ? node.getAttribute('href') || '' : '';
    const text = String(node.textContent || '').trim().toLowerCase();
    const href = rawHref.toLowerCase();
    const isSettingsLink = href === '/admin/settings' || href.startsWith('/admin/settings/');

    if (!isSettingsLink) {
      return;
    }

    const navItem = node.closest('a, button, li, [role="menuitem"], [role="treeitem"], [role="listitem"], div');
    if (navItem instanceof HTMLElement) {
      navItem.style.display = 'none';
    }
    if (node instanceof HTMLElement) {
      node.style.display = 'none';
    }
  });
};

const redirectTenantAdminAwayFromRestrictedPages = () => {
  const path = window.location.pathname;
  if (!path.startsWith(SETTINGS_PATH_PREFIX)) {
    return;
  }

  window.location.replace(TENANT_ADMIN_DEFAULT_PATH);
};

const installTenantAdminSettingsGuard = () => {
  if (typeof window === 'undefined' || window.__tenantAdminSettingsGuardInstalled) {
    return;
  }

  window.__tenantAdminSettingsGuardInstalled = true;

  let isTenantAdminScoped = false;
  let tenantAdminRecordId = null;
  let observer = null;

  const applyGuard = () => {
    if (!isTenantAdminScoped) {
      return;
    }

    hideTenantAdminNavigation();
    let persistedTenantAdminDetailPath = null;
    try {
      persistedTenantAdminDetailPath = window.sessionStorage.getItem(TENANT_ADMIN_TARGET_PATH_KEY) || null;
    } catch (_error) {
      persistedTenantAdminDetailPath = null;
    }

    const tenantAdminDetailPath = tenantAdminRecordId
      ? `${TENANT_ADMIN_COLLECTION_PATH}/${tenantAdminRecordId}`
      : persistedTenantAdminDetailPath;

    if (
      tenantAdminDetailPath &&
      window.location.pathname === TENANT_ADMIN_COLLECTION_PATH
    ) {
      window.location.replace(tenantAdminDetailPath);
      return;
    }

    if (
      tenantAdminDetailPath &&
      (window.location.pathname === '/admin/' || window.location.pathname === '/admin')
    ) {
      try {
        window.sessionStorage.removeItem(TENANT_ADMIN_NAV_REDIRECT_KEY);
      } catch (_error) {
        // Ignore session storage failures.
      }
      window.location.replace(tenantAdminDetailPath);
      window.setTimeout(() => {
        if (window.location.pathname !== tenantAdminDetailPath) {
          window.location.assign(tenantAdminDetailPath);
        }
      }, 150);
      return;
    }

    redirectTenantAdminAwayFromRestrictedPages();

    const links = Array.from(document.querySelectorAll('a, button, [role="menuitem"], [role="treeitem"]'));
    links.forEach((node) => {
      const rawHref = node instanceof HTMLAnchorElement ? node.getAttribute('href') || '' : '';
      const label = String(node.textContent || '').trim().toLowerCase();
      const isTenantAdminNavItem =
        label === 'tenant admin' ||
        rawHref === TENANT_ADMIN_COLLECTION_PATH ||
        rawHref.startsWith(`${TENANT_ADMIN_COLLECTION_PATH}?`);

      if (!isTenantAdminNavItem || node.dataset.tenantAdminDirectLinkBound === 'true') {
        return;
      }

      node.dataset.tenantAdminDirectLinkBound = 'true';
      if (tenantAdminDetailPath && node instanceof HTMLAnchorElement) {
        node.setAttribute('href', tenantAdminDetailPath);
      }

      node.addEventListener('click', (event) => {
        if (!isTenantAdminScoped || !tenantAdminDetailPath) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        try {
          window.sessionStorage.setItem(TENANT_ADMIN_NAV_REDIRECT_KEY, '1');
        } catch (_error) {
          // Ignore session storage failures.
        }
        window.location.assign(tenantAdminDetailPath);
      }, true);

      node.addEventListener('mousedown', (event) => {
        if (!isTenantAdminScoped || !tenantAdminDetailPath) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        try {
          window.sessionStorage.setItem(TENANT_ADMIN_NAV_REDIRECT_KEY, '1');
        } catch (_error) {
          // Ignore session storage failures.
        }
        window.location.assign(tenantAdminDetailPath);
      });
    });
  };

  const wrapHistoryMethod = (methodName) => {
    const original = window.history[methodName];
    window.history[methodName] = function wrappedHistoryMethod(...args) {
      const result = original.apply(this, args);
      window.setTimeout(applyGuard, 0);
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', applyGuard);

  observer = new MutationObserver(() => {
    applyGuard();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  void fetchTenantAdminCapabilities()
    .then((capabilities) => {
      isTenantAdminScoped = capabilities?.isTenantAdminScoped === true;
      tenantAdminRecordId = capabilities?.tenantAdminRecordId || null;
      applyGuard();
    })
    .catch(() => {});
};

const installTenantAdminProfilePasswordGuard = () => {
  if (typeof window === 'undefined' || window.__tenantAdminProfilePasswordGuardInstalled) {
    return;
  }

  window.__tenantAdminProfilePasswordGuardInstalled = true;

  let isTenantAdminScoped = false;
  const originalXhrOpen = window.XMLHttpRequest?.prototype?.open;
  const originalXhrSend = window.XMLHttpRequest?.prototype?.send;
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;

  if (originalFetch) {
    window.fetch = async (...args) => {
      const [input, init] = args;
      const requestUrl = typeof input === 'string' ? input : input?.url || '';
      const method = String(
        init?.method ||
        (typeof input === 'object' && input ? input.method : '') ||
        'GET'
      ).toUpperCase();
      const pathname = requestUrl
        ? new URL(requestUrl, window.location.origin).pathname
        : '';
      const passwordPayload = extractPasswordChangePayload(init?.body);

      if (pathname === ADMIN_ME_API_PATH) {
        console.info('[tenant-admin][profile-guard][fetch]', {
          method,
          pathname,
          bodyKeys:
            init?.body && typeof init.body === 'string'
              ? Object.keys(JSON.parse(init.body || '{}'))
              : Object.keys(init?.body || {}),
          hasPasswordPayload: Boolean(passwordPayload),
          hasCurrentPassword: Boolean(String(passwordPayload?.currentPassword || '').trim()),
          hasPassword: Boolean(String(passwordPayload?.password || '').trim()),
          hasConfirmPassword: Boolean(String(passwordPayload?.confirmPassword || '').trim()),
        });
      }

      const response = await originalFetch(...args);

      if (
        pathname === TENANT_ADMIN_COLLECTION_API_PATH &&
        method === 'GET' &&
        response.status === 403
      ) {
        window.setTimeout(() => {
          void redirectTenantAdminToOwnRecord();
        }, 0);
      }

      return response;
    };
  }

  if (originalXhrOpen && originalXhrSend) {
    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__tenantAdminMethod = String(method || 'GET').toUpperCase();
      this.__tenantAdminUrl = String(url || '');
      return originalXhrOpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function patchedSend(body) {
      const requestUrl = this.__tenantAdminUrl || '';
      const pathname = requestUrl
        ? new URL(requestUrl, window.location.origin).pathname
        : '';
      const passwordPayload = extractPasswordChangePayload(body);
      const isTenantAdminPasswordRequest =
        this.__tenantAdminMethod === 'PUT' &&
        pathname === ADMIN_ME_API_PATH &&
        passwordPayload &&
        String(passwordPayload.currentPassword || '').trim() &&
        String(passwordPayload.password || '').trim();

      if (pathname === ADMIN_ME_API_PATH) {
        console.info('[tenant-admin][profile-guard][xhr]', {
          method: this.__tenantAdminMethod,
          pathname,
          rawBodyType: typeof body,
          rawBodyPreview: typeof body === 'string' ? body.slice(0, 300) : null,
          hasPasswordPayload: Boolean(passwordPayload),
          hasCurrentPassword: Boolean(String(passwordPayload?.currentPassword || '').trim()),
          hasPassword: Boolean(String(passwordPayload?.password || '').trim()),
          hasConfirmPassword: Boolean(String(passwordPayload?.confirmPassword || '').trim()),
          isTenantAdminPasswordRequest,
        });
      }

      if (isTenantAdminPasswordRequest) {
        const handlePasswordResponse = () => {
          if (this.readyState !== 4 || this.__tenantAdminPasswordHandled) {
            return;
          }

          this.__tenantAdminPasswordHandled = true;

          console.error('[tenant-admin][profile-guard][xhr-response]', {
            status: this.status,
            responseText: String(this.responseText || '').slice(0, 500),
          });

          if (this.status >= 200 && this.status < 300) {
            window.setTimeout(() => {
              window.alert('Password changed successfully. Please log in again.');
              forceTenantAdminLogoutAfterPasswordChange();
            }, 0);
            return;
          }

          let message = 'Unable to change password. Please try again.';
          try {
            const payload = JSON.parse(String(this.responseText || '{}'));
            message = extractTenantAdminPasswordErrorMessage(payload);
          } catch (_error) {
            // Keep fallback message.
          }

          window.setTimeout(() => {
            replaceVisibleGenericAdminErrorWithRetries(message);
            window.alert(message);
          }, 0);
        };

        this.addEventListener('readystatechange', handlePasswordResponse);
        this.addEventListener('loadend', handlePasswordResponse);
      }

      if (
        this.__tenantAdminMethod === 'GET' &&
        pathname === TENANT_ADMIN_COLLECTION_API_PATH
      ) {
        const handleTenantAdminCollectionForbidden = () => {
          if (this.readyState !== 4 || this.__tenantAdminCollectionHandled) {
            return;
          }

          this.__tenantAdminCollectionHandled = true;
          if (this.status === 403) {
            window.setTimeout(() => {
              void redirectTenantAdminToOwnRecord();
            }, 0);
          }
        };

        this.addEventListener('readystatechange', handleTenantAdminCollectionForbidden);
        this.addEventListener('loadend', handleTenantAdminCollectionForbidden);
      }

      return originalXhrSend.call(this, body);
    };
  }

  void fetchTenantAdminCapabilities()
    .then((capabilities) => {
      isTenantAdminScoped = capabilities?.isTenantAdminScoped === true;
    })
    .catch(() => {});
};

const bootstrap = (app) => {
  installSettingsUsersSortGuard();
  installAppUsersSortGuard();
  installTenantAdminSettingsGuard();
  installTenantAdminProfilePasswordGuard();

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'voice-call-panel',
    Component: VoiceCallPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-panel',
    Component: AppUserPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-selfie-preview',
    Component: AppUserSelfiePreview,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-field-layout',
    Component: AppUserFieldLayout,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-color-panel',
    Component: TenantColorPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-key-panel',
    Component: TenantKeyPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-admin-panel',
    Component: TenantAdminPanel,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'bulk-clear-actions',
    Component: BulkClearActions,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'contact-export-action',
    Component: ContactExportAction,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'tenant-admin-qr-copy-buttons',
    Component: TenantAdminQrListCopyButtons,
  });
};

export default {
  config,
  bootstrap,
};







