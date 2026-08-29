/**
 * Executable Stage 5 Apps Script trust-boundary and TwiML integration tests.
 */

function runStage5AppsScriptTests() {
  const results = [
    _nrmRunTest_('Worker HMAC and normalized event parsing', _nrmTestWorkerEnvelopeParsing_),
    _nrmRunTest_('direct and tampered request rejection', _nrmTestWorkerRequestRejection_),
    _nrmRunTest_('Twilio REST request construction', _nrmTestTwilioRestRequestConstruction_),
    _nrmRunTest_('two-owner outbound SMS review loop isolation', _nrmTestWorkerTwoOwnerLoop_),
    _nrmRunTest_('outbound failure state integrity', _nrmTestOutboundFailureStateIntegrity_),
    _nrmRunTest_('safe empty TwiML acknowledgement', _nrmTestSafeWorkerResponses_)
  ];
  results.forEach(function (line) { Logger.log(line); });
  const failures = results.filter(function (line) { return line.indexOf('FAIL ') === 0; });
  if (failures.length) {
    throw new Error('Stage 5 Apps Script tests failed:\n' + failures.join('\n'));
  }
  Logger.log('PASS Stage 5 Apps Script suite: ' + results.length + '/' + results.length + ' tests passed.');
  return results;
}

// Retained as a regression entry point for the existing local runner. Stage 5
// intentionally replaces the direct Stage 4 transport boundary.
function runStage4Tests() {
  return runStage5AppsScriptTests();
}

function _nrmTestWorkerEnvelopeParsing_() {
  return _nrmWithStage5Spreadsheet_(function () {
    _nrmAssert_(
      _nrmHmacHexForSecret_('1700000000.dGVzdA==', 'test-secret') ===
        'f72b3e217e2d70ff849af9170709f930b3308b5b2fb9112af4e8eae4cd564523',
      'HMAC-SHA256 known vector mismatch.'
    );
    const input = _nrmStage5WorkerEvent_(
      NRM_TEST_OWNER_A,
      '+15550000001',
      'SM5_PARSE',
      'Photo caption',
      [
        { url: 'https://api.twilio.test/media/0', content_type: 'image/jpeg' },
        { url: 'https://api.twilio.test/media/1', content_type: 'image/png' }
      ]
    );
    const parsed = parseAndVerifyWorkerWebhook_(input);
    _nrmAssert_(parsed.message_sid === 'SM5_PARSE', 'MessageSid was not parsed.');
    _nrmAssert_(parsed.owner_id === NRM_TEST_OWNER_A, 'owner_id changed.');
    _nrmAssert_(parsed.from === '+15550000001', 'From was not parsed.');
    _nrmAssert_(parsed.to === '+15559999999', 'To was not parsed.');
    _nrmAssert_(parsed.body === 'Photo caption', 'Body was not parsed.');
    _nrmAssert_(parsed.num_media === 2 && parsed.media.length === 2, 'Media count changed.');
    _nrmAssert_(parsed.media[1].content_type === 'image/png', 'MediaContentType changed.');
    return 'PASS Worker HMAC and normalized event parsing: independent HMAC vector matched; owner_id and full MMS contract preserved.';
  });
}

function _nrmTestWorkerRequestRejection_() {
  return _nrmWithStage5Spreadsheet_(function () {
    const direct = doPost({ parameter: {
      Body: 'Direct public request', From: '+15550000001', To: '+15559999999',
      MessageSid: 'SM5_DIRECT', NumMedia: '0'
    } });
    _nrmAssert_(direct.getContent().indexOf('<Response></Response>') !== -1, 'Direct request response was not empty TwiML.');

    const tampered = _nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_TAMPER', 'Original');
    const tamperedEnvelope = JSON.parse(tampered.postData.contents);
    const decoded = JSON.parse(Utilities.newBlob(Utilities.base64Decode(tamperedEnvelope.payload)).getDataAsString('UTF-8'));
    decoded.body = 'Tampered';
    tamperedEnvelope.payload = Utilities.base64Encode(JSON.stringify(decoded), Utilities.Charset.UTF_8);
    tampered.postData.contents = JSON.stringify(tamperedEnvelope);
    const tamperedResponse = doPost(tampered);
    _nrmAssert_(tamperedResponse.getContent().indexOf('<Response></Response>') !== -1, 'Tampered response was not empty TwiML.');

    const stale = _nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_STALE', 'Stale');
    const staleEnvelope = JSON.parse(stale.postData.contents);
    staleEnvelope.timestamp = String(Math.floor(_nrmNowMs_() / 1000) - 301);
    staleEnvelope.signature = _nrmWorkerHmacHex_(staleEnvelope.timestamp + '.' + staleEnvelope.payload);
    stale.postData.contents = JSON.stringify(staleEnvelope);
    const staleResponse = doPost(stale);
    _nrmAssert_(staleResponse.getContent().indexOf('<Response></Response>') !== -1, 'Stale response was not empty TwiML.');

    _nrmAssert_(_nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A).length === 0, 'Rejected request created Staging state.');
    _nrmAssert_(_nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).length === 0, 'Rejected request wrote trusted EventLog state.');
    return 'PASS direct and tampered request rejection: direct form, changed payload, and stale signed envelope created zero Staging/EventLog rows.';
  });
}

function _nrmTestWorkerTwoOwnerLoop_() {
  return _nrmWithStage5Spreadsheet_(function () {
    const sentMessages = [];
    NRM_TEST_TWILIO_CLIENT_ = function (message) {
      sentMessages.push(Object.assign({}, message));
      return { message_sid: 'SM_OUTBOUND_' + sentMessages.length };
    };
    createContact({ contact_id: 'sm5_a_one', display_name: 'Sarah Chen', context_tag: 'A one' }, NRM_TEST_OWNER_A);
    createContact({ contact_id: 'sm5_a_two', display_name: 'Sarah Chen', context_tag: 'A two' }, NRM_TEST_OWNER_A);
    createContact({ contact_id: 'sm5_b_one', display_name: 'Sarah Chen', context_tag: 'B only' }, NRM_TEST_OWNER_B);

    const ownerAStart = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_A_CAPTURE', 'Sarah Chen', [{
      url: 'https://api.twilio.test/media/a', content_type: 'image/jpeg'
    }]));
    const ownerBStart = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_B, '+15550000002', 'SM5_B_CAPTURE', 'Sarah Chen'));
    _nrmAssert_(ownerAStart.getContent().indexOf('<Response></Response>') !== -1, 'Owner A acknowledgement was not empty TwiML.');
    _nrmAssert_(ownerBStart.getContent().indexOf('<Response></Response>') !== -1, 'Owner B acknowledgement was not empty TwiML.');
    _nrmAssert_(sentMessages[0].body.indexOf('1. Sarah Chen (A one)') !== -1, 'Owner A candidate SMS missing.');
    _nrmAssert_(sentMessages[0].body.indexOf('B only') === -1, 'Owner B candidate leaked into Owner A SMS.');
    _nrmAssert_(sentMessages[0].to === '+15550000001', 'Owner A SMS recipient changed.');
    _nrmAssert_(sentMessages[0].from === '+15559999999', 'Owner A SMS sender changed.');
    _nrmAssert_(sentMessages[1].body.indexOf('Reply YES to confirm') !== -1, 'Owner B review SMS missing.');
    _nrmAssert_(sentMessages[1].to === '+15550000002', 'Owner B SMS recipient changed.');

    const ownerAChoice = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_A_CHOICE', '2'));
    _nrmAssert_(ownerAChoice.getContent().indexOf('<Response></Response>') !== -1, 'Owner A choice acknowledgement was not empty TwiML.');
    _nrmAssert_(sentMessages[2].body.indexOf('Review: Stage 2 deterministic dummy interaction.') !== -1, 'Pending review SMS summary missing.');
    const ownerACommit = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_A_APPROVE', 'YES'));
    const ownerBCommit = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_B, '+15550000002', 'SM5_B_APPROVE', 'YES'));
    _nrmAssert_(ownerACommit.getContent().indexOf('<Response></Response>') !== -1, 'Owner A commit acknowledgement was not empty TwiML.');
    _nrmAssert_(ownerBCommit.getContent().indexOf('<Response></Response>') !== -1, 'Owner B commit acknowledgement was not empty TwiML.');
    _nrmAssert_(sentMessages.length === 5, 'Expected five outbound review messages.');
    _nrmAssert_(sentMessages[3].body === 'Interaction saved.', 'Owner A commit SMS missing.');
    _nrmAssert_(sentMessages[4].body === 'Interaction saved.', 'Owner B commit SMS missing.');

    const ownerAInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    const ownerBInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B);
    _nrmAssert_(ownerAInteractions.length === 1 && ownerBInteractions.length === 1, 'Expected one interaction per owner.');
    _nrmAssert_(ownerAInteractions[0].record.contact_id === 'sm5_a_two', 'Owner A committed wrong candidate.');
    _nrmAssert_(ownerBInteractions[0].record.contact_id === 'sm5_b_one', 'Owner B committed wrong contact.');
    return 'PASS two-owner outbound SMS review loop isolation: five correctly addressed candidate/review/commit messages; one interaction per owner; zero cross-contamination.';
  });
}

function _nrmTestTwilioRestRequestConstruction_() {
  const accountSid = 'AC11111111111111111111111111111111';
  const request = _nrmBuildTwilioMessageRequest_({
    to: '+15550000001',
    from: '+15559999999',
    body: 'Review: Coffee & lunch\nReply YES.'
  }, {
    account_sid: accountSid,
    auth_token: 'stage5-rest-test-token'
  });
  _nrmAssert_(
    request.url === 'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json',
    'Messages endpoint is wrong.'
  );
  _nrmAssert_(request.options.method === 'post', 'Messages request was not POST.');
  _nrmAssert_(request.options.contentType === 'application/x-www-form-urlencoded', 'Messages request content type is wrong.');
  _nrmAssert_(
    request.options.headers.Authorization === 'Basic ' + Utilities.base64Encode(
      accountSid + ':stage5-rest-test-token',
      Utilities.Charset.UTF_8
    ),
    'Messages request Basic Auth is wrong.'
  );
  _nrmAssert_(
    request.options.payload === 'To=%2B15550000001&From=%2B15559999999&Body=Review%3A%20Coffee%20%26%20lunch%0AReply%20YES.',
    'Messages request To/From/Body encoding is wrong.'
  );
  return 'PASS Twilio REST request construction: exact Messages endpoint, Basic Auth, form content type, and encoded To/From/Body.';
}

function _nrmTestOutboundFailureStateIntegrity_() {
  return _nrmWithStage5Spreadsheet_(function () {
    NRM_TEST_TWILIO_CLIENT_ = function () {
      throw new Error('TWILIO_HTTP_ERROR: status=503');
    };
    createContact({ contact_id: 'sm5_failure_contact', display_name: 'Sarah Chen', context_tag: 'Failure test' }, NRM_TEST_OWNER_A);

    const captureResponse = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_FAIL_CAPTURE', 'Sarah Chen'));
    _nrmAssert_(captureResponse.getContent().indexOf('<Response></Response>') !== -1, 'Failed-send capture did not acknowledge safely.');
    let staging = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A);
    _nrmAssert_(staging.length === 1, 'Failed review SMS removed Staging state.');
    _nrmAssert_(staging[0].record.state === 'PENDING_REVIEW', 'Failed review SMS changed workflow state.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'Failed review SMS created an Interaction.');

    const commitResponse = doPost(_nrmStage5WorkerEvent_(NRM_TEST_OWNER_A, '+15550000001', 'SM5_FAIL_COMMIT', 'YES'));
    _nrmAssert_(commitResponse.getContent().indexOf('<Response></Response>') !== -1, 'Failed-send commit did not acknowledge safely.');
    staging = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A);
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    _nrmAssert_(staging.length === 0, 'Failed commit SMS restored or retained Staging state.');
    _nrmAssert_(interactions.length === 1, 'Failed commit SMS prevented the approved Interaction commit.');
    _nrmAssert_(interactions[0].record.contact_id === 'sm5_failure_contact', 'Failed commit SMS changed the committed contact.');

    const failures = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      return entry.record.event_type === 'OUTBOUND_SMS_FAILED';
    });
    _nrmAssert_(failures.length === 2, 'Expected one failure log per failed send.');
    const details = failures.map(function (entry) { return _nrmParseJsonObject_(entry.record.details, {}); });
    _nrmAssert_(details.every(function (entry) { return entry.error_code === 'TWILIO_HTTP_ERROR'; }), 'Failure error code was not sanitized.');
    const serialized = JSON.stringify(details);
    _nrmAssert_(serialized.indexOf('+15550000001') === -1, 'Failure log leaked recipient number.');
    _nrmAssert_(serialized.indexOf('stage5-rest-test-token') === -1, 'Failure log leaked credentials.');
    return 'PASS outbound failure state integrity: failed review send preserved PENDING_REVIEW; failed commit confirmation preserved committed Interaction; two sanitized failures logged.';
  });
}

function _nrmTestSafeWorkerResponses_() {
  return _nrmWithStage5Spreadsheet_(function () {
    let sendCount = 0;
    NRM_TEST_TWILIO_CLIENT_ = function () { sendCount += 1; };
    const invalid = doPost({ postData: { type: 'application/json', contents: '{}' } });
    _nrmAssert_(invalid.mimeType === ContentService.MimeType.XML, 'Error response was not XML.');
    _nrmAssert_(invalid.getContent().indexOf('<Response></Response>') !== -1, 'Auth error response was not empty TwiML.');
    _nrmAssert_(sendCount === 0, 'Rejected request attempted an outbound SMS.');
    return 'PASS safe empty TwiML acknowledgement: rejected request returned valid empty TwiML and attempted zero outbound sends.';
  });
}

function _nrmWithStage5Spreadsheet_(callback) {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    const previousClient = NRM_TEST_LOCAL_AI_CLIENT_;
    const previousSecret = NRM_TEST_WORKER_HMAC_SECRET_;
    const previousNow = NRM_TEST_NOW_MS_;
    const previousTwilioClient = NRM_TEST_TWILIO_CLIENT_;
    try {
      setupNrmSheets();
      NRM_TEST_LOCAL_AI_CLIENT_ = _nrmStage3DummyClient_;
      NRM_TEST_WORKER_HMAC_SECRET_ = 'stage5-apps-script-test-secret';
      NRM_TEST_NOW_MS_ = new Date('2026-08-28T19:20:21.000Z').getTime();
      NRM_TEST_TWILIO_CLIENT_ = function () { return { message_sid: 'SM_TEST_OUTBOUND' }; };
      return callback();
    } finally {
      NRM_TEST_LOCAL_AI_CLIENT_ = previousClient;
      NRM_TEST_WORKER_HMAC_SECRET_ = previousSecret;
      NRM_TEST_NOW_MS_ = previousNow;
      NRM_TEST_TWILIO_CLIENT_ = previousTwilioClient;
    }
  });
}

function _nrmStage5WorkerEvent_(ownerId, fromNumber, messageSid, body, media) {
  const event = {
    message_sid: messageSid,
    owner_id: ownerId,
    from: fromNumber,
    to: '+15559999999',
    body: body,
    num_media: (media || []).length,
    media: media || [],
    received_at: new Date(_nrmNowMs_()).toISOString()
  };
  const payload = Utilities.base64Encode(JSON.stringify(event), Utilities.Charset.UTF_8);
  const timestamp = String(Math.floor(_nrmNowMs_() / 1000));
  return {
    postData: {
      type: 'application/json',
      contents: JSON.stringify({
        timestamp: timestamp,
        payload: payload,
        signature: _nrmWorkerHmacHex_(timestamp + '.' + payload)
      })
    }
  };
}

function _nrmHmacHexForSecret_(message, secret) {
  return Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8)
    .map(function (byte) {
      return ('0' + ((Number(byte) + 256) % 256).toString(16)).slice(-2);
    }).join('');
}
