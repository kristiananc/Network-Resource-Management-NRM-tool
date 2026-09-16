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
  const submissionId = _nrmAccessRequestSubmissionId_(e);
  try {
    const request = _nrmParseAccessRequest_(e);
    const saved = _nrmAppendAccessRequest_(request);
    return _nrmAccessRequestResponse_(
      true,
      'Access request received.',
      saved.request_id,
      request.submission_id
    );
  } catch (error) {
    console.error('ACCESS_REQUEST_REJECTED code=' + _nrmAccessRequestErrorCode_(error));
    return _nrmAccessRequestResponse_(
      false,
      _nrmAccessRequestClientMessage_(error),
      '',
      submissionId
    );
  }
}

/**
 * Run once after configuring NRM_SPREADSHEET_ID in the separate Apps Script
 * project. This verifies the exact production target and creates/validates the
 * AccessRequests tab without appending a request row.
 */
function setupNrmAccessRequestSheet() {
  const spreadsheet = _nrmAccessRequestSpreadsheet_();
  const existed = spreadsheet.getSheetByName(NRM_ACCESS_REQUEST_SHEET_NAME) !== null;
  const sheet = _nrmAccessRequestSheet_(spreadsheet);
  const output = _nrmAccessRequestTargetDetails_(spreadsheet, sheet, existed);
  _nrmLogAccessRequestTarget_(output);
  return output;
}

/**
 * Read-only diagnostic for confirming the spreadsheet used by web requests.
 */
function logNrmAccessRequestSpreadsheetTarget() {
  const spreadsheet = _nrmAccessRequestSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(NRM_ACCESS_REQUEST_SHEET_NAME);
  const output = _nrmAccessRequestTargetDetails_(spreadsheet, sheet, sheet !== null);
  _nrmLogAccessRequestTarget_(output);
  return output;
}

function _nrmParseAccessRequest_(e) {
  if (!e || !e.parameter) {
    throw new Error('INVALID_REQUEST');
  }

  const name = _nrmAccessRequestSingleParameter_(e, 'name').replace(/\s+/g, ' ').trim();
  const phoneNumber = _nrmAccessRequestSingleParameter_(e, 'phone_number').trim();
  const consent = _nrmAccessRequestSingleParameter_(e, 'consent').trim().toLowerCase();
  const submissionId = _nrmAccessRequestSingleParameter_(e, 'submission_id').trim();

  if (!name || name.length > 120) {
    throw new Error('INVALID_NAME');
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber)) {
    throw new Error('INVALID_PHONE_NUMBER');
  }
  if (consent !== 'yes') {
    throw new Error('CONSENT_REQUIRED');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(submissionId)) {
    throw new Error('INVALID_SUBMISSION_ID');
  }

  return { name: name, phone_number: phoneNumber, submission_id: submissionId };
}

function _nrmAccessRequestSubmissionId_(e) {
  if (!e || !e.parameter) return '';
  const value = String(e.parameter.submission_id || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
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
      return header === 'phone_number' ? '' : record[header];
    });
    const nextRow = sheet.getLastRow() + 1;
    const range = sheet.getRange(nextRow, 1, 1, NRM_ACCESS_REQUEST_HEADERS.length);
    range.setNumberFormat('@');
    range.setValues([row]);

    // Force the E.164 value through a separately flushed plain-text cell.
    // This prevents Sheets from interpreting a leading plus sign as numeric
    // input and lets us reject the write rather than retain a changed number.
    const phoneColumn = NRM_ACCESS_REQUEST_HEADERS.indexOf('phone_number') + 1;
    const phoneCell = sheet.getRange(nextRow, phoneColumn);
    phoneCell.setNumberFormat('@');
    SpreadsheetApp.flush();
    phoneCell.setValue(record.phone_number);
    SpreadsheetApp.flush();
    const storedPhone = String(phoneCell.getValue());
    const displayedPhone = String(phoneCell.getDisplayValue());
    if (storedPhone !== record.phone_number || displayedPhone !== record.phone_number) {
      if (String(sheet.getRange(nextRow, 1).getValue()) === record.request_id) {
        sheet.deleteRow(nextRow);
      }
      throw new Error('PHONE_PERSISTENCE_MISMATCH');
    }
    return record;
  } finally {
    lock.releaseLock();
  }
}

function _nrmAccessRequestSheet_(spreadsheet) {
  spreadsheet = spreadsheet || _nrmAccessRequestSpreadsheet_();
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

function _nrmAccessRequestTargetDetails_(spreadsheet, sheet, existed) {
  return {
    name: spreadsheet.getName(),
    id: spreadsheet.getId(),
    url: spreadsheet.getUrl(),
    script_property: NRM_ACCESS_REQUEST_SPREADSHEET_ID_PROPERTY,
    sheet_name: NRM_ACCESS_REQUEST_SHEET_NAME,
    sheet_exists: sheet !== null,
    sheet_was_present: existed
  };
}

function _nrmLogAccessRequestTarget_(output) {
  Logger.log('NRM access-request spreadsheet target');
  Logger.log('NAME: ' + output.name);
  Logger.log('ID: ' + output.id);
  Logger.log('URL: ' + output.url);
  Logger.log('SCRIPT PROPERTY: ' + output.script_property + '=' + output.id);
  Logger.log('SHEET: ' + output.sheet_name);
  Logger.log('SHEET EXISTS: ' + output.sheet_exists);
}

function _nrmAccessRequestNow_() {
  return NRM_ACCESS_REQUEST_TEST_NOW_ === null
    ? new Date()
    : new Date(NRM_ACCESS_REQUEST_TEST_NOW_.getTime());
}

function _nrmAccessRequestResponse_(ok, message, requestId, submissionId) {
  const payload = JSON.stringify({
    source: 'nrm-access-request',
    ok: ok,
    message: message,
    request_id: requestId,
    submission_id: submissionId
  }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = '<!doctype html><meta charset="utf-8">' +
    '<p>' + _nrmAccessRequestEscapeHtml_(message) + '</p>' +
    '<script>window.top.postMessage(' + payload + ', "*");</script>';
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
