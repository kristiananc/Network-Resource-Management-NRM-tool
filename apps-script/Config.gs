/**
 * Stage 3 Apps Script configuration. Secrets remain in Script Properties.
 */

const NRM_LOCAL_API_URL_PROPERTY = 'NRM_LOCAL_API_BASE_URL';
const NRM_LOCAL_API_TOKEN_PROPERTY = 'NRM_INTERNAL_API_TOKEN';

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
