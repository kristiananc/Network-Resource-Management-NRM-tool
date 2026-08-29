/**
 * Apps Script configuration. Deployment-specific secrets remain in Script
 * Properties.
 */

const NRM_LOCAL_API_URL_PROPERTY = 'NRM_LOCAL_API_BASE_URL';
const NRM_LOCAL_API_TOKEN_PROPERTY = 'NRM_INTERNAL_API_TOKEN';
const NRM_SPREADSHEET_ID_PROPERTY = 'NRM_SPREADSHEET_ID';
const NRM_WORKER_HMAC_SECRET_PROPERTY = 'NRM_WORKER_HMAC_SECRET';
const NRM_TWILIO_ACCOUNT_SID_PROPERTY = 'TWILIO_ACCOUNT_SID';
const NRM_TWILIO_AUTH_TOKEN_PROPERTY = 'TWILIO_AUTH_TOKEN';

// Tests supply a synthetic HMAC secret without reading production properties.
var NRM_TEST_WORKER_HMAC_SECRET_ = null;

function getNrmLocalApiConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const baseUrl = String(properties.getProperty(NRM_LOCAL_API_URL_PROPERTY) || '')
    .replace(/\/+$/, '');
  const token = String(properties.getProperty(NRM_LOCAL_API_TOKEN_PROPERTY) || '');
  if (!baseUrl) {
    throw new Error('MISSING_CONFIG: ' + NRM_LOCAL_API_URL_PROPERTY);
  }
  if (!token) {
    throw new Error('MISSING_CONFIG: ' + NRM_LOCAL_API_TOKEN_PROPERTY);
  }
  return { base_url: baseUrl, token: token };
}

function getNrmWorkerHmacSecret_() {
  const secret = NRM_TEST_WORKER_HMAC_SECRET_ === null
    ? PropertiesService.getScriptProperties().getProperty(NRM_WORKER_HMAC_SECRET_PROPERTY)
    : NRM_TEST_WORKER_HMAC_SECRET_;
  if (!secret) {
    throw new Error('MISSING_CONFIG: ' + NRM_WORKER_HMAC_SECRET_PROPERTY);
  }
  return String(secret);
}

function getNrmTwilioApiConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const accountSid = String(properties.getProperty(NRM_TWILIO_ACCOUNT_SID_PROPERTY) || '');
  const authToken = String(properties.getProperty(NRM_TWILIO_AUTH_TOKEN_PROPERTY) || '');
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new Error('MISSING_CONFIG: ' + NRM_TWILIO_ACCOUNT_SID_PROPERTY);
  }
  if (!authToken) {
    throw new Error('MISSING_CONFIG: ' + NRM_TWILIO_AUTH_TOKEN_PROPERTY);
  }
  return { account_sid: accountSid, auth_token: authToken };
}
