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
    results.push(_nrmRunAccessRequestTest_('E.164 phone preservation', _nrmTestPhoneNumberPersistence_));
    results.push(_nrmRunAccessRequestTest_('optional consent recording', _nrmTestOptionalConsentRecording_));
    results.push(_nrmRunAccessRequestTest_('invalid request rejection', _nrmTestInvalidAccessRequest_));
    results.push(_nrmRunAccessRequestTest_('legacy consent migration', _nrmTestLegacyConsentMigration_));
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
  const response = doPost(_nrmAccessRequestEvent_('Ada Lovelace', '+12025550123', 'true', 'submission-valid'));
  _nrmAccessAssert_(response.getContent().indexOf('"ok":true') !== -1, 'Success response missing.');
  _nrmAccessAssert_(response.getContent().indexOf('"submission_id":"submission-valid"') !== -1, 'Submission ID missing.');
  _nrmAccessAssert_(response.getContent().indexOf('window.top.postMessage') !== -1, 'Top-window response missing.');
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  _nrmAccessAssert_(sheet !== null, 'AccessRequests tab was not created.');
  const values = sheet.getDataRange().getValues();
  _nrmAccessAssert_(JSON.stringify(values[0]) === JSON.stringify(NRM_ACCESS_REQUEST_HEADERS), 'Headers changed.');
  _nrmAccessAssert_(values.length === 2, 'Expected exactly one request row.');
  _nrmAccessAssert_(String(values[1][1]) === 'Ada Lovelace', 'Name changed.');
  _nrmAccessAssert_(String(values[1][2]) === '+12025550123', 'E.164 phone number changed.');
  _nrmAccessAssert_(String(values[1][3]) === '2026-09-15T12:34:56.000Z', 'Consent timestamp changed.');
  _nrmAccessAssert_(String(values[1][4]) === 'PENDING', 'Status must default to PENDING.');
  _nrmAccessAssert_(values[1][5] === true, 'Affirmative SMS consent was not stored as true.');
  return 'PASS valid request append: exact headers, E.164 phone, timestamp, PENDING status, and sms_consent=true persisted.';
}

function _nrmTestPhoneNumberPersistence_() {
  const expected = '+19097719380';
  const response = doPost(_nrmAccessRequestEvent_(
    'Phone Preservation',
    expected,
    'true',
    'submission-phone-preservation'
  ));
  _nrmAccessAssert_(response.getContent().indexOf('"ok":true') !== -1, 'Phone preservation request failed.');
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  const phoneCell = sheet.getRange(sheet.getLastRow(), 3);
  _nrmAccessAssert_(String(phoneCell.getValue()) === expected, 'Stored phone number changed.');
  _nrmAccessAssert_(String(phoneCell.getDisplayValue()) === expected, 'Displayed phone number changed.');
  return 'PASS E.164 phone preservation: +19097719380 stored and displayed unchanged.';
}

function _nrmTestOptionalConsentRecording_() {
  const response = doPost(_nrmAccessRequestEvent_(
    'No SMS Consent',
    '+12025550125',
    'false',
    'submission-no-consent'
  ));
  _nrmAccessAssert_(response.getContent().indexOf('"ok":true') !== -1, 'Unchecked consent request was rejected.');
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  const values = sheet.getRange(sheet.getLastRow(), 1, 1, NRM_ACCESS_REQUEST_HEADERS.length).getValues()[0];
  _nrmAccessAssert_(values[3] === '', 'Unchecked consent received a consent timestamp.');
  _nrmAccessAssert_(String(values[4]) === 'PENDING', 'Unchecked consent request was not recorded as PENDING.');
  _nrmAccessAssert_(values[5] === false, 'Unchecked SMS consent was not stored as false.');
  return 'PASS optional consent recording: unchecked consent submitted successfully with sms_consent=false and no consented_at timestamp.';
}

function _nrmTestInvalidAccessRequest_() {
  const sheet = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_.getSheetByName('AccessRequests');
  const before = sheet ? sheet.getLastRow() : 0;
  const badPhone = doPost(_nrmAccessRequestEvent_('Grace Hopper', '202-555-0123', 'true', 'submission-bad-phone'));
  const badConsent = doPost(_nrmAccessRequestEvent_('Grace Hopper', '+12025550123', 'maybe', 'submission-bad-consent'));
  _nrmAccessAssert_(badPhone.getContent().indexOf('"ok":false') !== -1, 'Invalid phone was accepted.');
  _nrmAccessAssert_(badConsent.getContent().indexOf('"ok":false') !== -1, 'Invalid consent value was accepted.');
  _nrmAccessAssert_(sheet.getLastRow() === before, 'Invalid input appended a row.');
  return 'PASS invalid request rejection: malformed consent and non-E.164 phone appended zero rows.';
}

function _nrmTestLegacyConsentMigration_() {
  const isolated = SpreadsheetApp.create('NRM Access Request Migration Test ' + new Date().toISOString());
  const original = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_;
  try {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = isolated;
    const sheet = isolated.insertSheet('AccessRequests');
    sheet.getRange(1, 1, 1, NRM_ACCESS_REQUEST_LEGACY_HEADERS.length)
      .setValues([NRM_ACCESS_REQUEST_LEGACY_HEADERS.slice()]);
    sheet.getRange(2, 1, 1, NRM_ACCESS_REQUEST_LEGACY_HEADERS.length)
      .setNumberFormat('@')
      .setValues([[
        'legacy-request', 'Legacy Consent', '+12025550126',
        '2026-09-14T12:00:00.000Z', 'PENDING'
      ]]);
    const response = doPost(_nrmAccessRequestEvent_(
      'New Optional Consent',
      '+12025550127',
      'false',
      'submission-after-migration'
    ));
    _nrmAccessAssert_(response.getContent().indexOf('"ok":true') !== -1, 'Request failed after migration.');
    const values = sheet.getDataRange().getValues();
    _nrmAccessAssert_(JSON.stringify(values[0]) === JSON.stringify(NRM_ACCESS_REQUEST_HEADERS), 'Legacy headers were not migrated.');
    _nrmAccessAssert_(values[1][5] === true, 'Legacy affirmative-consent row was not backfilled true.');
    _nrmAccessAssert_(values[2][5] === false, 'Post-migration unchecked consent was not stored false.');
    return 'PASS legacy consent migration: existing forced-consent rows backfilled true and new optional consent stored false.';
  } finally {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = original;
    DriveApp.getFileById(isolated.getId()).setTrashed(true);
  }
}

function _nrmTestAccessRequestSchemaMismatch_() {
  const isolated = SpreadsheetApp.create('NRM Access Request Schema Test ' + new Date().toISOString());
  const original = NRM_ACCESS_REQUEST_TEST_SPREADSHEET_;
  try {
    NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = isolated;
    isolated.insertSheet('AccessRequests').getRange(1, 1).setValue('wrong_header');
    const response = doPost(_nrmAccessRequestEvent_('Katherine Johnson', '+12025550124', 'true', 'submission-schema'));
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
