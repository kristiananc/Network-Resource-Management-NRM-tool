/**
 * Authenticated client for the deterministic Stage 2 FastAPI endpoints.
 */

var NRM_TEST_LOCAL_AI_CLIENT_ = null;

function processInteractionWithLocalAi_(payload) {
  return _nrmCallLocalAi_('/process-interaction', payload);
}

function reviseDraftWithLocalAi_(payload) {
  return _nrmCallLocalAi_('/revise-draft', payload);
}

function _nrmCallLocalAi_(path, payload) {
  const response = NRM_TEST_LOCAL_AI_CLIENT_
    ? NRM_TEST_LOCAL_AI_CLIENT_(path, payload)
    : _nrmFetchLocalAi_(path, payload);
  _nrmValidateLocalAiResponse_(response, payload.owner_id);
  return response;
}

function _nrmFetchLocalAi_(path, payload) {
  const config = getNrmLocalApiConfig_();
  const httpResponse = UrlFetchApp.fetch(config.base_url + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const statusCode = httpResponse.getResponseCode();
  const responseText = httpResponse.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('LOCAL_AI_HTTP_ERROR: status=' + statusCode);
  }
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error('LOCAL_AI_INVALID_JSON');
  }
}

function _nrmValidateLocalAiResponse_(response, expectedOwnerId) {
  if (!response || Object.prototype.toString.call(response) !== '[object Object]') {
    throw new Error('LOCAL_AI_INVALID_RESPONSE');
  }
  if (response.owner_id !== expectedOwnerId) {
    throw new Error('OWNER_MISMATCH: Local API changed owner_id.');
  }
  if (response.schema_version !== '1.0' || !response.draft || response.draft.schema_version !== '1.0') {
    throw new Error('SCHEMA_VERSION_MISMATCH: Local API response must use 1.0.');
  }
}
