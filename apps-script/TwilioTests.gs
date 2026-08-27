/**
 * Executable Stage 4 Twilio adapter tests.
 */

function runStage4Tests() {
  const results = [
    _nrmRunTest_('Twilio form and MMS parsing', _nrmTestTwilioFormParsing_),
    _nrmRunTest_('temporary sender-map resolution', _nrmTestSenderMapResolution_),
    _nrmRunTest_('unauthorized sender rejected before staging', _nrmTestUnauthorizedSender_),
    _nrmRunTest_('two-owner Twilio review loop isolation', _nrmTestTwilioTwoOwnerLoop_),
    _nrmRunTest_('safe TwiML errors and XML escaping', _nrmTestSafeTwilioResponses_)
  ];
  results.forEach(function (line) { Logger.log(line); });
  const failures = results.filter(function (line) { return line.indexOf('FAIL ') === 0; });
  if (failures.length) {
    throw new Error('Stage 4 tests failed:\n' + failures.join('\n'));
  }
  Logger.log('PASS Stage 4 suite: ' + results.length + '/' + results.length + ' tests passed.');
  return results;
}

function _nrmTestTwilioFormParsing_() {
  const parsed = parseTwilioWebhook_({ parameter: {
    Body: 'Photo caption', From: '+15550000001', To: '+15559999999',
    MessageSid: 'SM4_PARSE', NumMedia: '2',
    MediaUrl0: 'https://api.twilio.test/media/0', MediaContentType0: 'image/jpeg',
    MediaUrl1: 'https://api.twilio.test/media/1', MediaContentType1: 'image/png'
  } });
  _nrmAssert_(parsed.body === 'Photo caption', 'Body was not parsed.');
  _nrmAssert_(parsed.from_number === '+15550000001', 'From was not parsed.');
  _nrmAssert_(parsed.to_number === '+15559999999', 'To was not parsed.');
  _nrmAssert_(parsed.message_sid === 'SM4_PARSE', 'MessageSid was not parsed.');
  _nrmAssert_(parsed.num_media === 2 && parsed.media_refs.length === 2, 'NumMedia was not parsed.');
  _nrmAssert_(parsed.media_refs[0].url === 'https://api.twilio.test/media/0', 'MediaUrl0 was not parsed.');
  _nrmAssert_(parsed.media_refs[1].content_type === 'image/png', 'MediaContentType1 was not parsed.');
  return 'PASS Twilio form and MMS parsing: Body, From, To, MessageSid, NumMedia, MediaUrlN, and MediaContentTypeN preserved.';
}

function _nrmTestSenderMapResolution_() {
  const previousMap = NRM_TEST_AUTHORIZED_SENDERS_;
  try {
    NRM_TEST_AUTHORIZED_SENDERS_ = {
      '+15550000001': 'own_test_a',
      '+15550000002': ' Own/Stage4:Opaque '
    };
    _nrmAssert_(resolveOwnerIdFromSender_('+15550000001') === 'own_test_a', 'Owner A did not resolve.');
    _nrmAssert_(resolveOwnerIdFromSender_('+15550000002') === ' Own/Stage4:Opaque ', 'Opaque owner_id changed.');
    _nrmAssert_(resolveOwnerIdFromSender_('+15550000003') === null, 'Unknown sender resolved.');
    return 'PASS temporary sender-map resolution: exact E.164 lookup, opaque owner_id passthrough, unknown sender rejected.';
  } finally {
    NRM_TEST_AUTHORIZED_SENDERS_ = previousMap;
  }
}

function _nrmTestUnauthorizedSender_() {
  return _nrmWithStage4Spreadsheet_(function () {
    const response = doPost(_nrmTwilioTestEvent_('+15550000999', 'SM4_UNAUTHORIZED', 'Unauthorized body'));
    _nrmAssert_(response.mimeType === ContentService.MimeType.XML, 'Unauthorized response was not XML.');
    _nrmAssert_(response.getContent().indexOf('<Response><Message>') !== -1, 'Unauthorized response was not TwiML.');
    _nrmAssert_(_nrmReadOwnedRows_('Staging', NRM_UNAUTHORIZED_OWNER_SENTINEL).length === 0, 'Unauthorized sender created staging.');
    _nrmAssert_(_nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A).length === 0, 'Unauthorized sender contaminated Owner A staging.');
    const logs = _nrmReadOwnedRows_('EventLog', NRM_UNAUTHORIZED_OWNER_SENTINEL);
    _nrmAssert_(logs.length === 1, 'Unauthorized event was not logged once.');
    _nrmAssert_(logs[0].record.event_type === 'UNAUTHORIZED_SENDER', 'Unauthorized event type is wrong.');
    const details = _nrmParseJsonObject_(logs[0].record.details, {});
    _nrmAssert_(details.message_sid === 'SM4_UNAUTHORIZED', 'Unauthorized MessageSid missing from log.');
    _nrmAssert_(JSON.stringify(details).indexOf('+15550000999') === -1, 'Unauthorized sender number was logged.');
    return 'PASS unauthorized sender rejected before staging: zero Staging rows; one UNAUTHORIZED_SENDER log under __UNAUTHORIZED_SENDER__; sender number omitted.';
  });
}

function _nrmTestTwilioTwoOwnerLoop_() {
  return _nrmWithStage4Spreadsheet_(function () {
    createContact({ contact_id: 'sm4_a_one', display_name: 'Sarah Chen', context_tag: 'A one' }, NRM_TEST_OWNER_A);
    createContact({ contact_id: 'sm4_a_two', display_name: 'Sarah Chen', context_tag: 'A two' }, NRM_TEST_OWNER_A);
    createContact({ contact_id: 'sm4_b_one', display_name: 'Sarah Chen', context_tag: 'B only' }, NRM_TEST_OWNER_B);

    const ownerAStart = doPost(_nrmTwilioTestEvent_('+15550000001', 'SM4_A_CAPTURE', 'Sarah Chen', [{
      url: 'https://api.twilio.test/media/a', content_type: 'image/jpeg'
    }]));
    const ownerBStart = doPost(_nrmTwilioTestEvent_('+15550000002', 'SM4_B_CAPTURE', 'Sarah Chen'));
    _nrmAssert_(ownerAStart.getContent().indexOf('1. Sarah Chen (A one)') !== -1, 'Owner A candidate list missing.');
    _nrmAssert_(ownerAStart.getContent().indexOf('B only') === -1, 'Owner B candidate leaked into Owner A TwiML.');
    _nrmAssert_(ownerBStart.getContent().indexOf('Reply YES to confirm') !== -1, 'Owner B review prompt missing.');

    const ownerAStaging = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A);
    const ownerBStaging = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_B);
    _nrmAssert_(ownerAStaging.length === 1 && ownerBStaging.length === 1, 'Expected one staging row per owner.');
    const media = _nrmParseJsonArray_(ownerAStaging[0].record.media_json);
    _nrmAssert_(media[0].url === 'https://api.twilio.test/media/a', 'MMS URL was not staged.');
    _nrmAssert_(media[0].content_type === 'image/jpeg', 'MMS content type was not staged.');

    const ownerAChoice = doPost(_nrmTwilioTestEvent_('+15550000001', 'SM4_A_CHOICE', '2'));
    _nrmAssert_(ownerAChoice.getContent().indexOf('Review: Stage 2 deterministic dummy interaction.') !== -1, 'Pending review summary missing.');
    _nrmAssert_(ownerAChoice.getContent().indexOf('Reply YES to confirm') !== -1, 'YES prompt missing.');
    const ownerAAfterChoice = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A);
    _nrmAssert_(ownerAAfterChoice.length === 1, 'Candidate reply started a second Owner A review.');
    _nrmAssert_(ownerAAfterChoice[0].record.state === 'PENDING_REVIEW', 'Owner A review did not reach PENDING_REVIEW.');
    _nrmAssert_(ownerAAfterChoice[0].record.selected_contact_id === 'sm4_a_two', 'Owner A candidate selection was not persisted.');
    const ownerACommit = doPost(_nrmTwilioTestEvent_('+15550000001', 'SM4_A_APPROVE', 'YES'));
    const ownerBCommit = doPost(_nrmTwilioTestEvent_('+15550000002', 'SM4_B_APPROVE', 'YES'));
    _nrmAssert_(
      ownerACommit.getContent().indexOf('Interaction saved.') !== -1,
      'Owner A commit reply missing; received: ' + ownerACommit.getContent()
    );
    _nrmAssert_(
      ownerBCommit.getContent().indexOf('Interaction saved.') !== -1,
      'Owner B commit reply missing; received: ' + ownerBCommit.getContent()
    );

    const ownerAInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    const ownerBInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B);
    _nrmAssert_(ownerAInteractions.length === 1 && ownerBInteractions.length === 1, 'Expected one interaction per owner.');
    _nrmAssert_(ownerAInteractions[0].record.contact_id === 'sm4_a_two', 'Owner A committed wrong candidate.');
    _nrmAssert_(ownerBInteractions[0].record.contact_id === 'sm4_b_one', 'Owner B committed wrong contact.');
    return 'PASS two-owner Twilio review loop isolation: form events auto-routed to each sender review, scoped candidate/summary/YES TwiML returned, one correct interaction per owner, zero cross-contamination.';
  });
}

function _nrmTestSafeTwilioResponses_() {
  return _nrmWithStage4Spreadsheet_(function () {
    const invalid = doPost({ parameter: {} });
    _nrmAssert_(invalid.mimeType === ContentService.MimeType.XML, 'Error response was not XML.');
    _nrmAssert_(invalid.getContent().indexOf('<?xml version="1.0" encoding="UTF-8"?>') === 0, 'Error response lacks XML declaration.');
    _nrmAssert_(invalid.getContent().indexOf('<Response><Message>') !== -1, 'Error response was not valid TwiML shape.');
    const escaped = _nrmTwiMlResponse_('Review <unsafe> & "quoted"');
    _nrmAssert_(escaped.getContent().indexOf('&lt;unsafe&gt; &amp; &quot;quoted&quot;') !== -1, 'TwiML text was not escaped.');
    const empty = _nrmTwiMlResponse_('');
    _nrmAssert_(empty.getContent().indexOf('<Response></Response>') !== -1, 'Empty TwiML response is invalid.');
    return 'PASS safe TwiML errors and XML escaping: malformed webhook returned XML/TwiML, special characters escaped, empty 200 body represented by empty Response.';
  });
}

function _nrmWithStage4Spreadsheet_(callback) {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    const previousClient = NRM_TEST_LOCAL_AI_CLIENT_;
    const previousMap = NRM_TEST_AUTHORIZED_SENDERS_;
    try {
      setupNrmSheets();
      NRM_TEST_LOCAL_AI_CLIENT_ = _nrmStage3DummyClient_;
      NRM_TEST_AUTHORIZED_SENDERS_ = {
        '+15550000001': NRM_TEST_OWNER_A,
        '+15550000002': NRM_TEST_OWNER_B
      };
      return callback();
    } finally {
      NRM_TEST_LOCAL_AI_CLIENT_ = previousClient;
      NRM_TEST_AUTHORIZED_SENDERS_ = previousMap;
    }
  });
}

function _nrmTwilioTestEvent_(fromNumber, messageSid, body, mediaRefs) {
  const parameter = {
    Body: body,
    From: fromNumber,
    To: '+15559999999',
    MessageSid: messageSid,
    NumMedia: String((mediaRefs || []).length)
  };
  (mediaRefs || []).forEach(function (mediaRef, index) {
    parameter['MediaUrl' + index] = mediaRef.url;
    parameter['MediaContentType' + index] = mediaRef.content_type;
  });
  return { parameter: parameter };
}
