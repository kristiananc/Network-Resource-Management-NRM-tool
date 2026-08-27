/**
 * Minimal Stage 4 Twilio webhook adapter.
 *
 * Twilio posts form-encoded parameters to doPost. This file parses that
 * transport shape, applies the temporary sender authorization boundary, and
 * delegates all workflow behavior to handleNormalizedEvent(event).
 */

const NRM_UNAUTHORIZED_OWNER_SENTINEL = '__UNAUTHORIZED_SENDER__';

function doPost(e) {
  let ownerId = '';
  try {
    const inbound = parseTwilioWebhook_(e);
    ownerId = resolveOwnerIdFromSender_(inbound.from_number);
    if (!ownerId) {
      _nrmLogUnauthorizedSender_(inbound);
      return _nrmTwiMlResponse_('This sender is not authorized.');
    }

    const normalized = _nrmNormalizedEventFromTwilio_(inbound, ownerId);
    const openReview = _nrmFindOpenReviewForSender_(inbound.from_number, ownerId);
    if (openReview) normalized.review_id = openReview.review_id;

    const result = handleNormalizedEvent(normalized);
    return _nrmTwiMlResponse_(_nrmTwilioReplyMessage_(result, ownerId));
  } catch (error) {
    _nrmLogTwilioFailureSafely_(error, ownerId);
    return _nrmTwiMlResponse_('Unable to process this message right now. Please try again later.');
  }
}

function parseTwilioWebhook_(e) {
  if (!e || !e.parameter || Object.prototype.toString.call(e.parameter) !== '[object Object]') {
    throw new Error('INVALID_TWILIO_REQUEST: form parameters are required.');
  }
  const parameter = e.parameter;
  const numMediaText = String(parameter.NumMedia === undefined ? '0' : parameter.NumMedia).trim();
  if (!/^\d+$/.test(numMediaText)) {
    throw new Error('INVALID_TWILIO_REQUEST: NumMedia must be a non-negative integer.');
  }
  const numMedia = Number(numMediaText);
  const mediaRefs = [];
  for (let index = 0; index < numMedia; index += 1) {
    const url = _nrmRequireString_(parameter['MediaUrl' + index], 'MediaUrl' + index);
    mediaRefs.push({
      url: url,
      content_type: String(parameter['MediaContentType' + index] || '').trim()
    });
  }

  return {
    body: String(parameter.Body || ''),
    from_number: _nrmRequireString_(parameter.From, 'From'),
    to_number: _nrmRequireString_(parameter.To, 'To'),
    message_sid: _nrmRequireString_(parameter.MessageSid, 'MessageSid'),
    num_media: numMedia,
    media_refs: mediaRefs
  };
}

function _nrmNormalizedEventFromTwilio_(inbound, ownerId) {
  return {
    message_sid: inbound.message_sid,
    owner_id: ownerId,
    owner_number: inbound.from_number,
    body: inbound.body,
    media_refs: inbound.media_refs
  };
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

function _nrmTwiMlResponse_(message) {
  const text = String(message || '');
  const xml = text
    ? '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' +
      _nrmEscapeXml_(text) + '</Message></Response>'
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.XML);
}

function _nrmEscapeXml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _nrmLogUnauthorizedSender_(inbound) {
  logEvent({
    event_type: 'UNAUTHORIZED_SENDER',
    status: 'FAILURE',
    details: {
      message_sid: inbound.message_sid,
      destination_number: inbound.to_number
    }
  }, NRM_UNAUTHORIZED_OWNER_SENTINEL);
}

function _nrmLogTwilioFailureSafely_(error, ownerId) {
  const eventType = String(error && error.message || '').indexOf('OWNER_MISMATCH') !== -1
    ? 'OWNER_MISMATCH'
    : 'TWILIO_WEBHOOK_ERROR';
  console.error(eventType + ' in doPost');
  try {
    logEvent({
      event_type: eventType,
      status: 'FAILURE',
      details: { error_code: _nrmTwilioErrorCode_(error) }
    }, ownerId || NRM_UNAUTHORIZED_OWNER_SENTINEL);
  } catch (loggingError) {
    console.error('TWILIO_WEBHOOK_ERROR logging failed');
  }
}

function _nrmTwilioErrorCode_(error) {
  const message = String(error && error.message || 'UNKNOWN_ERROR');
  const separator = message.indexOf(':');
  return (separator === -1 ? message : message.slice(0, separator)).trim() || 'UNKNOWN_ERROR';
}
