/**
 * Standalone Apps Script web app for NRM signup requests.
 *
 * Deploy this as a separate Apps Script project and deployment. It intentionally
 * shares no code or deployment with the Twilio-facing webhook in apps-script/.
 */

const NRM_ACCESS_REQUEST_SHEET_NAME = 'AccessRequests';
const NRM_ACCESS_REQUEST_HEADERS = Object.freeze([
  'request_id', 'name', 'phone_number', 'consented_at', 'status'
]);
const NRM_ACCESS_REQUEST_STATUS = 'PENDING';
const NRM_ACCESS_REQUEST_SPREADSHEET_ID_PROPERTY = 'NRM_SPREADSHEET_ID';

// Tests supply isolated dependencies without reading production configuration.
var NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = null;
var NRM_ACCESS_REQUEST_TEST_NOW_ = null;

function doGet() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8"><p>NRM access-request endpoint is ready.</p>'
  );
}

function doPost(e) {
  try {
    const request = _nrmParseAccessRequest_(e);
    const saved = _nrmAppendAccessRequest_(request);
    return _nrmAccessRequestResponse_(true, 'Access request received.', saved.request_id);
  } catch (error) {
    console.error('ACCESS_REQUEST_REJECTED code=' + _nrmAccessRequestErrorCode_(error));
    return _nrmAccessRequestResponse_(false, _nrmAccessRequestClientMessage_(error), '');
  }
}

function _nrmParseAccessRequest_(e) {
  if (!e || !e.parameter) {
    throw new Error('INVALID_REQUEST');
  }

  const name = _nrmAccessRequestSingleParameter_(e, 'name').replace(/\s+/g, ' ').trim();
  const phoneNumber = _nrmAccessRequestSingleParameter_(e, 'phone_number').trim();
  const consent = _nrmAccessRequestSingleParameter_(e, 'consent').trim().toLowerCase();

  if (!name || name.length > 120) {
    throw new Error('INVALID_NAME');
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) {
    throw new Error('INVALID_PHONE_NUMBER');
  }
  if (consent !== 'yes') {
    throw new Error('CONSENT_REQUIRED');
  }

  return { name: name, phone_number: phoneNumber };
}

function _nrmAccessRequestSingleParameter_(e, name) {
  if (e.parameters && e.parameters[name] && e.parameters[name].length !== 1) {
    throw new Error('DUPLICATE_PARAMETER');
  }
  return String(e.parameter[name] || '');
}

function _nrmAppendAccessRequest_(request) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('ACCESS_REQUEST_BUSY');
  }

  try {
    const sheet = _nrmAccessRequestSheet_();
    const record = {
      request_id: Utilities.getUuid(),
      name: request.name,
      phone_number: request.phone_number,
      consented_at: _nrmAccessRequestNow_().toISOString(),
      status: NRM_ACCESS_REQUEST_STATUS
    };
    const row = NRM_ACCESS_REQUEST_HEADERS.map(function (header) {
      return record[header];
    });
    const nextRow = sheet.getLastRow() + 1;
    const range = sheet.getRange(nextRow, 1, 1, NRM_ACCESS_REQUEST_HEADERS.length);
    range.setNumberFormat('@');
    range.setValues([row]);
    return record;
  } finally {
    lock.releaseLock();
  }
}

function _nrmAccessRequestSheet_() {
  const spreadsheet = _nrmAccessRequestSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(NRM_ACCESS_REQUEST_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(NRM_ACCESS_REQUEST_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, NRM_ACCESS_REQUEST_HEADERS.length)
      .setValues([NRM_ACCESS_REQUEST_HEADERS.slice()]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  if (sheet.getLastColumn() !== NRM_ACCESS_REQUEST_HEADERS.length) {
    throw new Error('SCHEMA_MISMATCH');
  }
  const existing = sheet.getRange(1, 1, 1, NRM_ACCESS_REQUEST_HEADERS.length)
    .getValues()[0];
  for (let index = 0; index < NRM_ACCESS_REQUEST_HEADERS.length; index += 1) {
    if (existing[index] !== NRM_ACCESS_REQUEST_HEADERS[index]) {
      throw new Error('SCHEMA_MISMATCH');
    }
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function _nrmAccessRequestSpreadsheet_() {
  if (NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ !== null) {
    return NRM_ACCESS_REQUEST_TEST_SPREADSHEET_;
  }
  const spreadsheetId = String(
    PropertiesService.getScriptProperties()
      .getProperty(NRM_ACCESS_REQUEST_SPREADSHEET_ID_PROPERTY) || ''
  ).trim();
  if (!spreadsheetId) {
    throw new Error('MISSING_CONFIG');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function _nrmAccessRequestNow_() {
  return NRM_ACCESS_REQUEST_TEST_NOW_ === null
    ? new Date()
    : new Date(NRM_ACCESS_REQUEST_TEST_NOW_.getTime());
}

function _nrmAccessRequestResponse_(ok, message, requestId) {
  const payload = JSON.stringify({
    source: 'nrm-access-request',
    ok: ok,
    message: message,
    request_id: requestId
  });
  const html = '<!doctype html><meta charset="utf-8">' +
    '<p>' + _nrmAccessRequestEscapeHtml_(message) + '</p>' +
    '<script>window.parent.postMessage(' + payload + ', "*");</script>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function _nrmAccessRequestEscapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _nrmAccessRequestErrorCode_(error) {
  const message = String(error && error.message || 'UNKNOWN_ERROR');
  return /^[A-Z0-9_]+$/.test(message) ? message : 'UNKNOWN_ERROR';
}

function _nrmAccessRequestClientMessage_(error) {
  const code = _nrmAccessRequestErrorCode_(error);
  if (code === 'INVALID_NAME') return 'Please provide a valid name.';
  if (code === 'INVALID_PHONE_NUMBER') return 'Please provide a valid E.164 phone number.';
  if (code === 'CONSENT_REQUIRED') return 'Consent is required to request access.';
  if (code === 'ACCESS_REQUEST_BUSY') return 'The service is busy. Please try again.';
  return 'The request could not be submitted. Please contact support.';
}
