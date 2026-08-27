/**
 * Apps Script configuration. Secrets and deployment-specific sender mappings
 * remain in Script Properties.
 */

const NRM_LOCAL_API_URL_PROPERTY = 'NRM_LOCAL_API_BASE_URL';
const NRM_LOCAL_API_TOKEN_PROPERTY = 'NRM_INTERNAL_API_TOKEN';
const NRM_AUTHORIZED_SENDERS_PROPERTY = 'NRM_AUTHORIZED_SENDERS_JSON';

// Tests may supply a synthetic map. Production leaves this null and reads the
// same { E.164 sender: opaque owner_id } shape from Script Properties.
var NRM_TEST_AUTHORIZED_SENDERS_ = null;

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

/**
 * Temporary Stage 4 authorization boundary. Stage 5 can replace this one
 * function with the Worker-provided owner_id without changing doPost or the
 * state machine.
 */
function resolveOwnerIdFromSender_(fromNumber) {
  const sender = String(fromNumber || '').trim();
  if (!sender) return null;

  let senderMap = NRM_TEST_AUTHORIZED_SENDERS_;
  if (senderMap === null) {
    const raw = PropertiesService.getScriptProperties()
      .getProperty(NRM_AUTHORIZED_SENDERS_PROPERTY);
    if (!raw) {
      throw new Error('MISSING_CONFIG: ' + NRM_AUTHORIZED_SENDERS_PROPERTY);
    }
    try {
      senderMap = JSON.parse(raw);
    } catch (error) {
      throw new Error('INVALID_CONFIG: ' + NRM_AUTHORIZED_SENDERS_PROPERTY + ' must be valid JSON.');
    }
  }

  if (!senderMap || Object.prototype.toString.call(senderMap) !== '[object Object]') {
    throw new Error('INVALID_CONFIG: ' + NRM_AUTHORIZED_SENDERS_PROPERTY + ' must be a JSON object.');
  }
  if (!Object.prototype.hasOwnProperty.call(senderMap, sender)) return null;

  const ownerId = String(senderMap[sender] === undefined ? '' : senderMap[sender]);
  if (!ownerId.trim()) {
    throw new Error('INVALID_CONFIG: authorized sender owner_id must not be blank.');
  }
  return ownerId;
}
