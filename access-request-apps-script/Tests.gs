/**
 * Run in the separate access-request Apps Script project with
 * runAccessRequestTests(). Tests use a temporary spreadsheet.
 */

function runAccessRequestTests() {
  const spreadsheet = SpreadsheetApp.create('NRM Access Request Test ' + new Date().toISOString());
  const originalSpreadsheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_;
  const originalNow = NRM_ACCESS_REQUEST_TEST_NOW_;
  const results = [];
  try {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = spreadsheet;
    NRM_ACCESS_REQUEST_TEST_NOW_ = new Date('2026-09-15T12:34:56.000Z');
    results.push(_nrmRunAccessRequestTest_('valid request append', _nrmTestValidAccessRequest_));
    results.push(_nrmRunAccessRequestTest_('invalid request rejection', _nrmTestInvalidAccessRequest_));
    results.push(_nrmRunAccessRequestTest_('schema mismatch protection', _nrmTestAccessRequestSchemaMismatch_));
    Logger.log('PASS Access Request suite: ' + results.length + '/' + results.length + ' tests passed.');
    return results;
  } finally {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = originalSpreadsheet;
    NRM_ACCESS_REQUEST_TEST_NOW_ = originalNow;
    DriveApp.getFileById(spreadsheet.getId()).setTrashed(true);
  }
}

function _nrmRunAccessRequestTest_(name, testFunction) {
  try {
    const output = testFunction();
    Logger.log(output);
    return output;
  } catch (error) {
    throw new Error('FAIL ' + name + ': ' + error.message);
  }
}

function _nrmTestValidAccessRequest_() {
  const response = doPost(_nrmAccessRequestEvent_('Ada Lovelace', '+19097719380', 'yes', 'submission-valid'));
  _nrmAccessAssert_(response.getContent().indexOf('"ok":true') !== -1, 'Success response missing.');
  _nrmAccessAssert_(response.getContent().indexOf('"submission_id":"submission-valid"') !== -1, 'Submission ID missing.');
  _nrmAccessAssert_(response.getContent().indexOf('window.top.postMessage') !== -1, 'Top-window response missing.');
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  _nrmAccessAssert_(sheet !== null, 'AccessRequests tab was not created.');
  const values = sheet.getDataRange().getValues();
  _nrmAccessAssert_(JSON.stringify(values[0]) === JSON.stringify(NRM_ACCESS_REQUEST_HEADERS), 'Headers changed.');
  _nrmAccessAssert_(values.length === 2, 'Expected exactly one request row.');
  _nrmAccessAssert_(String(values[1][1]) === 'Ada Lovelace', 'Name changed.');
  _nrmAccessAssert_(String(values[1][2]) === '+19097719380', 'E.164 phone number changed.');
  _nrmAccessAssert_(String(values[1][3]) === '2026-09-15T12:34:56.000Z', 'Consent timestamp changed.');
  _nrmAccessAssert_(String(values[1][4]) === 'PENDING', 'Status must default to PENDING.');
  return 'PASS valid request append: exact headers, E.164 phone, timestamp, and PENDING status persisted.';
}

function _nrmTestInvalidAccessRequest_() {
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  const before = sheet ? sheet.getLastRow() : 0;
  const noConsent = doPost(_nrmAccessRequestEvent_('Grace Hopper', '+12025550123', '', 'submission-no-consent'));
  const badPhone = doPost(_nrmAccessRequestEvent_('Grace Hopper', '202-555-0123', 'yes', 'submission-bad-phone'));
  _nrmAccessAssert_(noConsent.getContent().indexOf('"ok":false') !== -1, 'Missing consent was accepted.');
  _nrmAccessAssert_(badPhone.getContent().indexOf('"ok":false') !== -1, 'Invalid phone was accepted.');
  _nrmAccessAssert_(sheet.getLastRow() === before, 'Invalid input appended a row.');
  return 'PASS invalid request rejection: missing consent and non-E.164 phone appended zero rows.';
}

function _nrmTestAccessRequestSchemaMismatch_() {
  const isolated = SpreadsheetApp.create('NRM Access Request Schema Test ' + new Date().toISOString());
  const original = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_;
  try {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = isolated;
    isolated.insertSheet('AccessRequests').getRange(1, 1).setValue('wrong_header');
    const response = doPost(_nrmAccessRequestEvent_('Katherine Johnson', '+12025550124', 'yes', 'submission-schema'));
    _nrmAccessAssert_(response.getContent().indexOf('"ok":false') !== -1, 'Schema mismatch was accepted.');
    _nrmAccessAssert_(isolated.getSheetByName('AccessRequests').getLastRow() === 1, 'Schema mismatch wrote data.');
    return 'PASS schema mismatch protection: existing incorrect headers were not overwritten.';
  } finally {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = original;
    DriveApp.getFileById(isolated.getId()).setTrashed(true);
  }
}

function _nrmAccessRequestEvent_(name, phoneNumber, consent, submissionId) {
  return {
    parameter: {
      name: name,
      phone_number: phoneNumber,
      consent: consent,
      submission_id: submissionId
    },
    parameters: {
      name: [name],
      phone_number: [phoneNumber],
      consent: [consent],
      submission_id: [submissionId]
    }
  };
}

function _nrmAccessAssert_(condition, message) {
  if (!condition) throw new Error(message);
}
