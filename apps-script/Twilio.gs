/**
 * Stage 5 Worker-authenticated webhook adapter.
 *
 * Apps Script web-app events do not expose arbitrary HTTP headers, so the
 * Worker sends a timestamped HMAC-SHA256 envelope in the JSON body. The
 * signature is verified before the normalized event or owner_id is trusted.
 */

const NRM_WORKER_ENVELOPE_MAX_AGE_SECONDS = 300;
var NRM_TEST_NOW_MS_ = null;
var NRM_TEST_TWILIO_CLIENT_ = null;

function doPost(e) {
  let ownerId = '';
  try {
    const inbound = parseAndVerifyWorkerWebhook_(e);
    ownerId = inbound.owner_id;
    const normalized = _nrmNormalizedEventFromWorker_(inbound);
    const openReview = _nrmFindOpenReviewForSender_(inbound.from, ownerId);
    if (openReview) normalized.review_id = openReview.review_id;

    const result = handleNormalizedEvent(normalized);
    const replyText = _nrmTwilioReplyMessage_(result, ownerId);
    _nrmSendTwilioReplySafely_(replyText, inbound.to, inbound.from, result, ownerId);
    return _nrmEmptyTwiMlResponse_();
  } catch (error) {
    if (!ownerId) {
      console.error('WORKER_AUTH_REJECTED in doPost');
    } else {
      _nrmLogWorkerFailureSafely_(error, ownerId);
    }
    return _nrmEmptyTwiMlResponse_();
  }
}

function parseAndVerifyWorkerWebhook_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') {
    throw new Error('INVALID_WORKER_REQUEST: JSON body required.');
  }
  const contentType = String(e.postData.type || '').toLowerCase();
  if (contentType.indexOf('application/json') !== 0) {
    throw new Error('INVALID_WORKER_REQUEST: application/json required.');
  }

  let envelope;
  try {
    envelope = JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error('INVALID_WORKER_REQUEST: malformed JSON envelope.');
  }
  if (!envelope || Object.prototype.toString.call(envelope) !== '[object Object]') {
    throw new Error('INVALID_WORKER_REQUEST: envelope object required.');
  }

  const timestamp = _nrmRequireString_(envelope.timestamp, 'timestamp');
  const payload = _nrmRequireString_(envelope.payload, 'payload');
  const signature = _nrmRequireString_(envelope.signature, 'signature').toLowerCase();
  if (!/^\d+$/.test(timestamp)) {
    throw new Error('INVALID_WORKER_TIMESTAMP');
  }
  const ageSeconds = Math.abs(Math.floor(_nrmNowMs_() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > NRM_WORKER_ENVELOPE_MAX_AGE_SECONDS) {
    throw new Error('STALE_WORKER_REQUEST');
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(signature)) {
    throw new Error('INVALID_WORKER_SIGNATURE');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new Error('INVALID_WORKER_PAYLOAD');
  }

  const expected = _nrmWorkerHmacHex_(timestamp + '.' + payload);
  if (!_nrmConstantTimeEqual_(signature, expected)) {
    throw new Error('INVALID_WORKER_SIGNATURE');
  }

  let event;
  try {
    const decoded = Utilities.newBlob(Utilities.base64Decode(payload))
      .getDataAsString('UTF-8');
    event = JSON.parse(decoded);
  } catch (error) {
    throw new Error('INVALID_WORKER_PAYLOAD');
  }
  return _nrmValidateWorkerEvent_(event);
}

function _nrmValidateWorkerEvent_(event) {
  if (!event || Object.prototype.toString.call(event) !== '[object Object]') {
    throw new Error('INVALID_WORKER_EVENT');
  }
  const normalized = {
    message_sid: _nrmRequireString_(event.message_sid, 'message_sid'),
    owner_id: _nrmRequireOwnerId_(event.owner_id),
    from: _nrmRequireString_(event.from, 'from'),
    to: _nrmRequireString_(event.to, 'to'),
    body: String(event.body || ''),
    num_media: Number(event.num_media),
    media: event.media,
    received_at: _nrmRequireString_(event.received_at, 'received_at')
  };
  if (!Number.isInteger(normalized.num_media) || normalized.num_media < 0) {
    throw new Error('INVALID_WORKER_EVENT: num_media must be a non-negative integer.');
  }
  if (!Array.isArray(normalized.media) || normalized.media.length !== normalized.num_media) {
    throw new Error('INVALID_WORKER_EVENT: media length must equal num_media.');
  }
  normalized.media = normalized.media.map(function (entry) {
    if (!entry || Object.prototype.toString.call(entry) !== '[object Object]') {
      throw new Error('INVALID_WORKER_EVENT: media item must be an object.');
    }
    return {
      url: _nrmRequireString_(entry.url, 'media.url'),
      content_type: String(entry.content_type || '')
    };
  });
  if (isNaN(new Date(normalized.received_at).getTime())) {
    throw new Error('INVALID_WORKER_EVENT: received_at must be an ISO timestamp.');
  }
  return normalized;
}

function _nrmNormalizedEventFromWorker_(inbound) {
  return {
    message_sid: inbound.message_sid,
    owner_id: inbound.owner_id,
    owner_number: inbound.from,
    body: inbound.body,
    media_refs: inbound.media
  };
}

function _nrmWorkerHmacHex_(signingInput) {
  const bytes = Utilities.computeHmacSha256Signature(
    signingInput,
    getNrmWorkerHmacSecret_(),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    return ('0' + ((Number(byte) + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function _nrmConstantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function _nrmNowMs_() {
  return NRM_TEST_NOW_MS_ === null ? Date.now() : NRM_TEST_NOW_MS_;
}

function _nrmFindOpenReviewForSender_(fromNumber, ownerId) {
  const canonicalSender = _nrmCanonicalSenderNumber_(fromNumber);
  const matches = _nrmReadOwnedRows_('Staging', ownerId).filter(function (entry) {
    return _nrmCanonicalSenderNumber_(entry.record.owner_number) === canonicalSender;
  });
  if (matches.length > 1) {
    throw new Error('AMBIGUOUS_ACTIVE_REVIEW: sender has more than one open review.');
  }
  return matches.length === 1 ? matches[0].record : null;
}

function _nrmCanonicalSenderNumber_(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  const e164Digits = normalized.match(/^\+?(\d+)$/);
  return e164Digits ? '+' + e164Digits[1] : normalized;
}

function _nrmTwilioReplyMessage_(result, ownerId) {
  if (!result || Object.prototype.toString.call(result) !== '[object Object]') {
    throw new Error('INVALID_STATE_RESULT');
  }
  if (result.owner_id !== ownerId) {
    throw new Error('OWNER_MISMATCH: state-machine result changed owner_id.');
  }
  if (result.duplicate || result.state === 'DUPLICATE') return '';

  if (result.state === 'DISAMBIGUATING') {
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const lines = candidates.map(function (candidate) {
      const context = candidate.context_tag ? ' (' + candidate.context_tag + ')' : '';
      return candidate.number + '. ' + candidate.display_name + context;
    });
    return 'Choose a contact:\n' + lines.join('\n') + '\nReply with a candidate number.';
  }

  if (result.state === 'PENDING_REVIEW') {
    const staging = findStagingByReviewId(result.review_id, ownerId);
    if (!staging) throw new Error('STAGING_NOT_FOUND: pending review reply.');
    const bundle = _nrmParseJsonObject_(staging.draft_json, {});
    const summary = bundle.interaction && bundle.interaction.summary
      ? String(bundle.interaction.summary)
      : 'Draft ready.';
    return 'Review: ' + summary + '\nReply YES to confirm, or send a correction.';
  }

  if (result.state === 'COMMITTED') return 'Interaction saved.';
  if (result.state === 'ERROR') return String(result.message || 'Processing failed.');
  return String(result.message || 'Message received.');
}

function _nrmSendTwilioReplySafely_(body, fromNumber, toNumber, result, ownerId) {
  if (!body) return false;
  try {
    const client = NRM_TEST_TWILIO_CLIENT_ || _nrmPostTwilioMessage_;
    client({
      from: _nrmRequireString_(fromNumber, 'outbound.from'),
      to: _nrmRequireString_(toNumber, 'outbound.to'),
      body: _nrmRequireString_(body, 'outbound.body')
    });
    return true;
  } catch (error) {
    _nrmLogOutboundSmsFailureSafely_(error, result, ownerId);
    return false;
  }
}

function _nrmPostTwilioMessage_(message) {
  const config = getNrmTwilioApiConfig_();
  const request = _nrmBuildTwilioMessageRequest_(message, config);
  const response = UrlFetchApp.fetch(request.url, request.options);
  const statusCode = response.getResponseCode();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('TWILIO_HTTP_ERROR: status=' + statusCode);
  }
  let responseBody;
  try {
    responseBody = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('TWILIO_INVALID_RESPONSE');
  }
  if (!responseBody || !responseBody.sid) {
    throw new Error('TWILIO_INVALID_RESPONSE');
  }
  return { message_sid: String(responseBody.sid) };
}

function _nrmBuildTwilioMessageRequest_(message, config) {
  const accountSid = _nrmRequireString_(config.account_sid, 'twilio.account_sid');
  const authToken = _nrmRequireString_(config.auth_token, 'twilio.auth_token');
  return {
    url: 'https://api.twilio.com/2010-04-01/Accounts/' +
      encodeURIComponent(accountSid) + '/Messages.json',
    options: {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        Authorization: 'Basic ' + Utilities.base64Encode(
          accountSid + ':' + authToken,
          Utilities.Charset.UTF_8
        )
      },
      payload: 'To=' + encodeURIComponent(_nrmRequireString_(message.to, 'outbound.to')) +
        '&From=' + encodeURIComponent(_nrmRequireString_(message.from, 'outbound.from')) +
        '&Body=' + encodeURIComponent(_nrmRequireString_(message.body, 'outbound.body')),
      muteHttpExceptions: true
    }
  };
}

function _nrmLogOutboundSmsFailureSafely_(error, result, ownerId) {
  console.error('OUTBOUND_SMS_FAILED');
  try {
    logEvent({
      review_id: result && result.review_id ? result.review_id : '',
      event_type: 'OUTBOUND_SMS_FAILED',
      status: 'FAILURE',
      details: { error_code: _nrmWorkerErrorCode_(error) }
    }, ownerId);
  } catch (loggingError) {
    console.error('OUTBOUND_SMS_FAILED logging failed');
  }
}

function _nrmEmptyTwiMlResponse_() {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.XML);
}

function _nrmLogWorkerFailureSafely_(error, ownerId) {
  const eventType = String(error && error.message || '').indexOf('OWNER_MISMATCH') !== -1
    ? 'OWNER_MISMATCH'
    : 'WORKER_WEBHOOK_ERROR';
  console.error(eventType + ' in doPost');
  try {
    logEvent({
      event_type: eventType,
      status: 'FAILURE',
      details: { error_code: _nrmWorkerErrorCode_(error) }
    }, ownerId);
  } catch (loggingError) {
    console.error('WORKER_WEBHOOK_ERROR logging failed');
  }
}

function _nrmWorkerErrorCode_(error) {
  const message = String(error && error.message || 'UNKNOWN_ERROR');
  const separator = message.indexOf(':');
  return (separator === -1 ? message : message.slice(0, separator)).trim() || 'UNKNOWN_ERROR';
}
