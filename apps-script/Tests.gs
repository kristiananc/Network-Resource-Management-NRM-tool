/**
 * Executable Stage 1 tests. In Apps Script, run runStage1Tests() or
 * runCrossOwnerIsolationTest() from the editor.
 */

const NRM_TEST_OWNER_A = 'own_test_a';
const NRM_TEST_OWNER_B = 'own_test_b';

const NRM_EXPECTED_V1_HEADERS_FOR_TESTS = Object.freeze({
  Contacts: Object.freeze([
    'contact_id', 'owner_id', 'display_name', 'context_tag', 'phone', 'email',
    'organization', 'role_title', 'relationship_summary', 'last_contact',
    'last_platform', 'created_at', 'updated_at', 'status'
  ]),
  Interactions: Object.freeze([
    'interaction_id', 'contact_id', 'owner_id', 'interaction_date', 'platform',
    'summary', 'details_json', 'raw_body', 'media_refs', 'source_message_sid',
    'created_at', 'ai_model', 'schema_version'
  ]),
  Staging: Object.freeze([
    'review_id', 'message_sid', 'owner_number', 'owner_id', 'state', 'created_at',
    'updated_at', 'raw_body', 'media_json', 'candidate_contact_ids',
    'selected_contact_id', 'draft_json', 'revision_count', 'error_json'
  ]),
  EventLog: Object.freeze([
    'event_id', 'review_id', 'owner_id', 'timestamp', 'event_type', 'status',
    'details'
  ])
});

function runStage1Tests() {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    setupNrmSheets();
    const results = [];
    results.push(_nrmRunTest_('schema v1.0 headers', _nrmTestSchemaHeaders_));
    _nrmSeedStage1Fixtures_();
    results.push(_nrmRunTest_('fixture edge cases', _nrmTestFixtureEdgeCases_));
    results.push(_nrmRunTest_('cross-owner isolation', _nrmAssertCrossOwnerIsolation_));
    results.push(_nrmRunTest_('staging CRUD and interaction append', _nrmTestPersistenceFlow_));
    results.push(_nrmRunTest_('UUID and deterministic dates', _nrmTestUtilities_));
    results.push(_nrmRunTest_('owner_id required and immutable', _nrmTestOwnerGuards_));
    results.push(_nrmRunTest_('schema mismatch protection', _nrmTestSchemaMismatchProtection_));

    results.forEach(function (line) { Logger.log(line); });
    const failures = results.filter(function (line) { return line.indexOf('FAIL ') === 0; });
    if (failures.length) {
      throw new Error('Stage 1 tests failed:\n' + failures.join('\n'));
    }
    Logger.log('PASS Stage 1 suite: ' + results.length + '/' + results.length + ' tests passed.');
    return results;
  });
}

function runCrossOwnerIsolationTest() {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    setupNrmSheets();
    _nrmSeedStage1Fixtures_();
    const output = _nrmAssertCrossOwnerIsolation_();
    Logger.log(output);
    return output;
  });
}

function _nrmWithTemporaryTestSpreadsheet_(callback) {
  const previous = NRM_TEST_SPREADSHEET_;
  const spreadsheet = SpreadsheetApp.create('NRM Stage 1 Test ' + new Date().toISOString());
  NRM_TEST_SPREADSHEET_ = spreadsheet;
  try {
    return callback();
  } finally {
    NRM_TEST_SPREADSHEET_ = previous;
    DriveApp.getFileById(spreadsheet.getId()).setTrashed(true);
  }
}

function _nrmSeedStage1Fixtures_() {
  const created = '2026-08-26T00:00:00.000Z';
  [
    {
      contact_id: 'contact_a_navwar', owner_id: NRM_TEST_OWNER_A,
      display_name: 'Sarah Chen', context_tag: 'NAVWAR', phone: '',
      email: 'sarah.a@example.test', organization: 'NAVWAR', role_title: '',
      relationship_summary: '', last_contact: '', last_platform: '',
      created_at: created, updated_at: created, status: 'ACTIVE'
    },
    {
      contact_id: 'contact_a_usc', owner_id: NRM_TEST_OWNER_A,
      display_name: 'Sarah Chen', context_tag: 'USC', phone: '+15550102020',
      email: '', organization: 'USC', role_title: 'Researcher',
      relationship_summary: '', last_contact: '', last_platform: '',
      created_at: created, updated_at: created, status: 'ACTIVE'
    },
    {
      contact_id: 'contact_b_work', owner_id: NRM_TEST_OWNER_B,
      display_name: 'Sarah Chen', context_tag: 'Work', phone: '+15550102020',
      email: 'sarah.a@example.test', organization: 'Example Corp', role_title: '',
      relationship_summary: '', last_contact: '', last_platform: '',
      created_at: created, updated_at: created, status: 'ACTIVE'
    }
  ].forEach(function (fixture) {
    _nrmAppendObject_('Contacts', fixture);
  });
}

function _nrmTestSchemaHeaders_() {
  Object.keys(NRM_EXPECTED_V1_HEADERS_FOR_TESTS).forEach(function (sheetName) {
    const expected = NRM_EXPECTED_V1_HEADERS_FOR_TESTS[sheetName];
    const actual = _nrmGetSheet_(sheetName).getRange(1, 1, 1, expected.length).getValues()[0];
    _nrmAssert_(_nrmArraysEqual_(actual, expected), sheetName + ' headers differ from frozen v1.0.');
    _nrmAssert_(actual.indexOf('owner_id') !== -1, sheetName + ' is missing owner_id.');
  });
  return 'PASS schema v1.0 headers: Contacts, Interactions, Staging, EventLog exact; owner_id present on all four.';
}

function _nrmTestFixtureEdgeCases_() {
  const ownerA = searchContacts('Sarah Chen', NRM_TEST_OWNER_A);
  const allRows = _nrmGetSheet_('Contacts').getDataRange().getValues();
  _nrmAssert_(ownerA.length === 2, 'Expected duplicate display_names for owner A.');
  _nrmAssert_(ownerA.some(function (row) { return row.phone === ''; }), 'Missing-phone fixture not preserved.');
  _nrmAssert_(ownerA.some(function (row) { return row.email === ''; }), 'Missing-email fixture not preserved.');
  _nrmAssert_(ownerA.map(function (row) { return row.context_tag; }).join(',') === 'NAVWAR,USC', 'Multiple context tags not represented.');
  _nrmAssert_(allRows.length === 4, 'Expected header plus three synthetic fixture rows.');
  return 'PASS fixture edge cases: duplicate names, missing phone/email, context tags NAVWAR/USC/Work, two owners.';
}

function _nrmAssertCrossOwnerIsolation_() {
  const ownerAResults = searchContacts('Sarah Chen', NRM_TEST_OWNER_A);
  const ownerBResults = searchContacts('Sarah Chen', NRM_TEST_OWNER_B);
  _nrmAssert_(ownerAResults.length === 2, 'Owner A should see exactly two Sarah Chen rows.');
  _nrmAssert_(ownerBResults.length === 1, 'Owner B should see exactly one Sarah Chen row.');
  _nrmAssert_(ownerAResults.every(function (row) { return row.owner_id === NRM_TEST_OWNER_A; }), 'Owner A received a foreign row.');
  _nrmAssert_(ownerBResults.every(function (row) { return row.owner_id === NRM_TEST_OWNER_B; }), 'Owner B received a foreign row.');
  _nrmAssert_(findContactById('contact_b_work', NRM_TEST_OWNER_A) === null, 'Owner A resolved Owner B contact_id.');
  _nrmAssert_(findContactById('contact_a_navwar', NRM_TEST_OWNER_B) === null, 'Owner B resolved Owner A contact_id.');
  _nrmAssert_(searchContacts('NAVWAR', NRM_TEST_OWNER_B).length === 0, 'Owner B matched Owner A context tag.');

  return 'PASS cross-owner isolation: own_test_a returned [contact_a_navwar, contact_a_usc]; own_test_b returned [contact_b_work]; no foreign rows or contact IDs exposed.';
}

function _nrmTestPersistenceFlow_() {
  const staging = createStaging({
    message_sid: 'SM_STAGE1_A', owner_number: '+15550000001', state: 'PROCESSING',
    raw_body: 'Met Sarah at a project review.'
  }, NRM_TEST_OWNER_A);
  _nrmAssert_(staging.owner_id === NRM_TEST_OWNER_A, 'Staging owner_id was not persisted.');
  _nrmAssert_(updateStaging(staging.review_id, { state: 'PENDING_REVIEW' }, NRM_TEST_OWNER_B) === null, 'Foreign owner updated staging.');
  _nrmAssertThrows_(function () {
    updateStaging(staging.review_id, { selected_contact_id: 'contact_b_work' }, NRM_TEST_OWNER_A);
  }, 'OWNER_MISMATCH');
  _nrmAssertThrows_(function () {
    updateStaging(staging.review_id, {
      candidate_contact_ids: ['contact_a_navwar', 'contact_b_work']
    }, NRM_TEST_OWNER_A);
  }, 'OWNER_MISMATCH');

  const updated = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW', selected_contact_id: 'contact_a_navwar',
    candidate_contact_ids: ['contact_a_navwar', 'contact_a_usc'],
    draft_json: { summary: 'Project review follow-up' }, revision_count: 1
  }, NRM_TEST_OWNER_A);
  _nrmAssert_(updated.state === 'PENDING_REVIEW', 'Staging state was not updated.');
  _nrmAssert_(updated.revision_count === 1, 'Staging revision_count was not updated.');

  const interaction = appendInteraction({
    contact_id: 'contact_a_navwar', interaction_date: '2026-08-25',
    platform: 'IN_PERSON', summary: 'Discussed project review follow-up.',
    details_json: { topics: ['project review'] }, source_message_sid: 'SM_STAGE1_A'
  }, NRM_TEST_OWNER_A);
  _nrmAssert_(interaction.owner_id === NRM_TEST_OWNER_A, 'Interaction owner_id was not persisted.');
  _nrmAssert_(interaction.schema_version === '1.0', 'Interaction schema_version was not 1.0.');

  _nrmAssertThrows_(function () {
    appendInteraction({
      contact_id: 'contact_b_work', interaction_date: '2026-08-25',
      platform: 'TEXT', summary: 'Must not write.'
    }, NRM_TEST_OWNER_A);
  }, 'OWNER_MISMATCH');

  const event = logEvent({
    review_id: staging.review_id, event_type: 'STAGE1_TEST', status: 'SUCCESS',
    details: { interaction_id: interaction.interaction_id }
  }, NRM_TEST_OWNER_A);
  _nrmAssert_(event.owner_id === NRM_TEST_OWNER_A, 'Event owner_id was not persisted.');
  _nrmAssert_(deleteStaging(staging.review_id, NRM_TEST_OWNER_B) === false, 'Foreign owner deleted staging.');
  _nrmAssert_(deleteStaging(staging.review_id, NRM_TEST_OWNER_A) === true, 'Owner could not delete staging.');
  return 'PASS staging CRUD and interaction append: create/update/delete scoped; staged contact IDs owner-validated; interaction and event appended; cross-owner writes rejected.';
}

function _nrmTestUtilities_() {
  const uuid = generateUuid();
  _nrmAssert_(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid), 'UUID format invalid.');
  _nrmAssert_(normalizeDate('2024-02-29') === '2024-02-29', 'Leap-day normalization failed.');
  _nrmAssert_(normalizeDateTime('2026-08-26T05:06:07Z') === '2026-08-26T05:06:07.000Z', 'UTC datetime normalization failed.');
  _nrmAssertThrows_(function () { normalizeDate('2025-02-29'); }, 'Invalid calendar date');
  _nrmAssertThrows_(function () { normalizeDate('2026-08-26Tgarbage'); }, 'Invalid date format');
  return 'PASS UUID and deterministic dates: UUID format valid; UTC date/datetime normalization stable; invalid date rejected.';
}

function _nrmTestOwnerGuards_() {
  [
    function () { findContactById('contact_a_navwar', ''); },
    function () { searchContacts('Sarah', ''); },
    function () { appendInteraction({}, ''); },
    function () { createStaging({}, ''); },
    function () { updateStaging('review', {}, ''); },
    function () { deleteStaging('review', ''); },
    function () { logEvent({}, ''); }
  ].forEach(function (operation) {
    _nrmAssertThrows_(operation, 'owner_id');
  });
  _nrmAssertThrows_(function () {
    createStaging({
      owner_id: NRM_TEST_OWNER_B, message_sid: 'SM_BAD_OWNER',
      owner_number: '+15550000001', state: 'PROCESSING'
    }, NRM_TEST_OWNER_A);
  }, 'OWNER_MISMATCH');
  return 'PASS owner_id guards: all seven public data helpers reject missing owner_id; conflicting embedded owner rejected.';
}

function _nrmTestSchemaMismatchProtection_() {
  const sheet = _nrmGetSheet_('EventLog');
  const expected = NRM_EXPECTED_V1_HEADERS_FOR_TESTS.EventLog;
  sheet.getRange(1, 1, 1, expected.length).setValues([expected.slice(0, -1).concat(['wrong_header'])]);
  _nrmAssertThrows_(function () { setupNrmSheets(); }, 'SCHEMA_MISMATCH');
  sheet.getRange(1, 1, 1, expected.length).setValues([expected.slice()]);
  return 'PASS schema mismatch protection: provisioning refused to overwrite an existing mismatched header.';
}

function _nrmRunTest_(name, callback) {
  try {
    return callback();
  } catch (error) {
    return 'FAIL ' + name + ': ' + error.message;
  }
}

function _nrmAssert_(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function _nrmAssertThrows_(callback, expectedMessagePart) {
  let thrown = null;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  _nrmAssert_(thrown !== null, 'Expected error containing: ' + expectedMessagePart);
  _nrmAssert_(thrown.message.indexOf(expectedMessagePart) !== -1, 'Unexpected error: ' + thrown.message);
}
