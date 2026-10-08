/**
 * Owner-scoped Stage 3 workflow state machine.
 */

const NRM_YES_REPLIES = Object.freeze(['YES', 'Y']);
const NRM_NO_DATE_REPLY = 'NO DATE';
const NRM_CANCEL_REPLY = 'CANCEL';

function routeNormalizedEvent(event) {
  const normalized = _nrmNormalizeEvent_(event);
  if (_nrmMessageSidSeen_(normalized.message_sid, normalized.owner_id)) {
    return {
      owner_id: normalized.owner_id,
      review_id: normalized.review_id || '',
      state: 'DUPLICATE',
      duplicate: true,
      message: 'MessageSid already processed.'
    };
  }

  if (!normalized.review_id) {
    const openReview = _nrmFindOpenReviewForSender_(
      normalized.owner_number,
      normalized.owner_id
    );
    if (openReview) {
      normalized.review_id = openReview.review_id;
    } else if (isCancelReply_(normalized.body) || isNoDateReply_(normalized.body)) {
      return _nrmHandleCommandWithoutOpenReview_(normalized);
    } else {
      return _nrmStartCapture_(normalized);
    }
  }

  const staging = findStagingByReviewId(normalized.review_id, normalized.owner_id);
  if (!staging) {
    logEvent({
      review_id: normalized.review_id,
      event_type: 'STAGING_NOT_FOUND',
      status: 'FAILURE',
      details: { message_sid: normalized.message_sid }
    }, normalized.owner_id);
    return {
      owner_id: normalized.owner_id,
      review_id: normalized.review_id,
      state: 'ERROR',
      duplicate: false,
      message: 'Review not found for owner.'
    };
  }

  if (isCancelReply_(normalized.body)) {
    _nrmLogMessageAccepted_(normalized, staging.review_id);
    return _nrmCancelOpenReview_(staging, normalized);
  }
  return _nrmDispatchState_(staging, normalized);
}

function handleProcessing_(staging, event) {
  if (event.message_sid !== staging.message_sid) {
    return _nrmRejectOpenReviewMessage_(staging, event);
  }
  const seed = _nrmParseJsonObject_(staging.draft_json, {});
  const response = processInteractionWithLocalAi_({
    owner_id: staging.owner_id,
    review_id: staging.review_id,
    raw_body: staging.raw_body || '',
    media_refs: _nrmMediaUrlsForLocalAi_(_nrmParseJsonArray_(staging.media_json))
  });
  const proposedContact = _nrmContactProposalFromDraft_(
    response.draft,
    seed.contact || {}
  );
  const query = _nrmContactQuery_(
    seed.contact_query || event.contact_query,
    proposedContact
  );
  const candidates = query ? searchContacts(query, staging.owner_id) : [];
  const candidateIds = candidates.map(function (contact) { return contact.contact_id; });
  const bundle = {
    interaction: response.draft,
    contact: proposedContact,
    contact_query: query
  };

  if (candidates.length > 1) {
    const disambiguating = updateStaging(staging.review_id, {
      state: 'DISAMBIGUATING',
      candidate_contact_ids: candidateIds,
      selected_contact_id: '',
      draft_json: bundle,
      error_json: ''
    }, staging.owner_id);
    return _nrmStateResult_(disambiguating, {
      message: 'Reply with a candidate number.',
      candidates: candidates.map(function (contact, index) {
        return {
          number: index + 1,
          display_name: contact.display_name,
          context_tag: contact.context_tag
        };
      })
    });
  }

  const pending = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW',
    candidate_contact_ids: candidateIds,
    selected_contact_id: candidates.length === 1 ? candidates[0].contact_id : '',
    draft_json: bundle,
    error_json: ''
  }, staging.owner_id);
  return _nrmPendingReviewResult_(pending);
}

function handleDisambiguating_(staging, event) {
  const candidateIds = _nrmParseJsonArray_(staging.candidate_contact_ids);
  const ownedCandidates = candidateIds.map(function (contactId) {
    const contact = findContactById(contactId, staging.owner_id);
    if (!contact) {
      throw new Error('OWNER_MISMATCH: candidate contact is outside staging owner_id.');
    }
    return contact;
  });
  const candidateIndex = parseCandidateNumber_(event.body, ownedCandidates.length);
  if (candidateIndex === null) {
    return _nrmRejectOpenReviewMessage_(
      staging,
      event,
      'This review is waiting for a contact choice. Reply with 1-' +
        ownedCandidates.length + ', or reply CANCEL to discard it.'
    );
  }

  _nrmLogMessageAccepted_(event, staging.review_id);
  const pending = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW',
    selected_contact_id: ownedCandidates[candidateIndex].contact_id,
    error_json: ''
  }, staging.owner_id);
  return _nrmPendingReviewResult_(pending);
}

function handlePendingReview_(staging, event) {
  _nrmLogMessageAccepted_(event, staging.review_id);
  if (isYesApproval_(event.body)) {
    return _nrmCommitApprovedReview_(staging, event);
  }

  const revising = updateStaging(staging.review_id, {
    state: 'REVISING',
    revision_count: Number(staging.revision_count || 0) + 1,
    error_json: ''
  }, staging.owner_id);
  return handleRevising_(revising, event);
}

function handleRevising_(staging, event) {
  const bundle = _nrmParseJsonObject_(staging.draft_json, {});
  if (!bundle.interaction) {
    throw new Error('MISSING_DRAFT: staged interaction draft is required.');
  }
  if (isNoDateReply_(event.body)) {
    bundle.interaction.interaction_date = null;
    bundle.review_control = Object.assign({}, bundle.review_control || {}, {
      no_date_confirmed: true
    });
  } else {
    const response = reviseDraftWithLocalAi_({
      owner_id: staging.owner_id,
      review_id: staging.review_id,
      draft: bundle.interaction,
      correction: _nrmRequireString_(event.body, 'correction')
    });
    bundle.interaction = response.draft;
    if (bundle.interaction.interaction_date) {
      bundle.review_control = Object.assign({}, bundle.review_control || {}, {
        no_date_confirmed: false
      });
    }
  }
  bundle.contact = _nrmContactProposalFromDraft_(
    bundle.interaction,
    bundle.contact || {}
  );
  const pending = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW',
    draft_json: bundle,
    error_json: ''
  }, staging.owner_id);
  return _nrmPendingReviewResult_(pending, 'Revision ready. ');
}

function handleError_(staging, event) {
  return _nrmRejectOpenReviewMessage_(staging, event);
}

function parseCandidateNumber_(body, candidateCount) {
  const normalized = String(body || '').trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const oneBased = Number(normalized);
  if (oneBased < 1 || oneBased > candidateCount) {
    return null;
  }
  return oneBased - 1;
}

function isYesApproval_(body) {
  return NRM_YES_REPLIES.indexOf(String(body || '').trim().toUpperCase()) !== -1;
}

function isNoDateReply_(body) {
  return String(body || '').trim().toUpperCase() === NRM_NO_DATE_REPLY;
}

function isCancelReply_(body) {
  return String(body || '').trim().toUpperCase() === NRM_CANCEL_REPLY;
}

function _nrmStartCapture_(event) {
  const contact = _nrmNormalizedContact_(event.contact, event.contact_query);
  const staging = createStaging({
    message_sid: event.message_sid,
    owner_number: event.owner_number,
    state: 'PROCESSING',
    raw_body: event.body,
    media_json: event.media_refs,
    draft_json: {
      contact: contact,
      contact_query: event.contact_query || contact.display_name || ''
    },
    revision_count: 0
  }, event.owner_id);
  _nrmLogMessageAccepted_(event, staging.review_id);
  return _nrmDispatchState_(staging, event);
}

function _nrmDispatchState_(staging, event) {
  try {
    if (staging.state === 'PROCESSING') return handleProcessing_(staging, event);
    if (staging.state === 'DISAMBIGUATING') return handleDisambiguating_(staging, event);
    if (staging.state === 'PENDING_REVIEW') return handlePendingReview_(staging, event);
    if (staging.state === 'REVISING') return _nrmRejectOpenReviewMessage_(staging, event);
    if (staging.state === 'ERROR') return handleError_(staging, event);
    throw new Error('INVALID_STATE: ' + staging.state);
  } catch (error) {
    const critical = error.message.indexOf('OWNER_MISMATCH') !== -1;
    return _nrmTransitionToError_(staging, error, critical);
  }
}

function _nrmCommitApprovedReview_(staging, event) {
  const ownerId = staging.owner_id;
  const bundle = _nrmParseJsonObject_(staging.draft_json, {});
  if (!bundle.interaction) {
    throw new Error('MISSING_DRAFT: staged interaction draft is required.');
  }

  const issues = _nrmReviewValidationIssues_(staging, bundle);
  if (issues.length) {
    logEvent({
      review_id: staging.review_id,
      event_type: 'VALIDATION_REQUIRED',
      status: 'FAILURE',
      details: {
        message_sid: event && event.message_sid ? event.message_sid : '',
        fields: issues.map(function (issue) { return issue.field; })
      }
    }, ownerId);
    return _nrmPendingReviewResult_(staging);
  }

  let contact;
  if (staging.selected_contact_id) {
    contact = findContactById(staging.selected_contact_id, ownerId);
    if (!contact) {
      throw new Error('OWNER_MISMATCH: resolved contact_id does not belong to staging owner_id.');
    }
  } else {
    contact = createContact(
      _nrmContactProposalFromDraft_(bundle.interaction, bundle.contact || {}),
      ownerId
    );
  }

  const draft = bundle.interaction;
  const interaction = appendInteraction({
    contact_id: contact.contact_id,
    interaction_date: draft.interaction_date,
    platform: draft.platform,
    summary: draft.summary,
    details_json: draft.details_json,
    raw_body: draft.raw_body,
    media_refs: draft.media_refs,
    source_message_sid: staging.message_sid,
    ai_model: draft.ai_model,
    schema_version: draft.schema_version
  }, ownerId, {
    allow_explicit_no_date: Boolean(
      bundle.review_control && bundle.review_control.no_date_confirmed === true
    )
  });

  logEvent({
    review_id: staging.review_id,
    event_type: 'COMMITTED',
    status: 'SUCCESS',
    details: {
      contact_id: contact.contact_id,
      interaction_id: interaction.interaction_id,
      source_message_sid: staging.message_sid
    }
  }, ownerId);
  deleteStaging(staging.review_id, ownerId);
  return {
    owner_id: ownerId,
    review_id: staging.review_id,
    state: 'COMMITTED',
    duplicate: false,
    contact_id: contact.contact_id,
    interaction_id: interaction.interaction_id,
    message: 'Interaction committed.'
  };
}

function _nrmPendingReviewResult_(staging, prefix) {
  const bundle = _nrmParseJsonObject_(staging.draft_json, {});
  const issues = _nrmReviewValidationIssues_(staging, bundle);
  const instruction = issues.length
    ? issues.map(function (issue) { return issue.prompt; }).join(' ')
    : 'Reply YES to confirm, or send a correction. To log something else, reply CANCEL to discard this review, then resend.';
  return _nrmStateResult_(staging, {
    message: String(prefix || '') + instruction,
    missing_fields: issues.map(function (issue) { return issue.field; })
  });
}

function _nrmCancelOpenReview_(staging, event) {
  const ownerId = staging.owner_id;
  const details = {
    message_sid: event.message_sid,
    existing_review_id: staging.review_id,
    state: staging.state
  };
  if (!deleteStaging(staging.review_id, ownerId)) {
    throw new Error('STAGING_NOT_FOUND: ' + staging.review_id);
  }
  logEvent({
    review_id: staging.review_id,
    event_type: 'CANCELLED',
    status: 'SUCCESS',
    details: details
  }, ownerId);
  return {
    owner_id: ownerId,
    review_id: staging.review_id,
    state: 'CANCELLED',
    duplicate: false,
    message: 'Previous review cancelled. You can send a new entry now.'
  };
}

function _nrmHandleCommandWithoutOpenReview_(event) {
  const command = isCancelReply_(event.body) ? 'CANCEL' : 'NO_DATE';
  logEvent({
    event_type: 'COMMAND_REJECTED_NO_OPEN_REVIEW',
    status: 'FAILURE',
    details: {
      message_sid: event.message_sid,
      command: command,
      state: 'NONE'
    }
  }, event.owner_id);
  return {
    owner_id: event.owner_id,
    review_id: '',
    state: 'NO_OPEN_REVIEW',
    duplicate: false,
    message: command === 'CANCEL'
      ? 'There is no open review to cancel. Send a new entry when you are ready.'
      : 'There is no open review waiting for a date. Send a new entry first.'
  };
}

function _nrmRejectOpenReviewMessage_(staging, event, message) {
  logEvent({
    review_id: staging.review_id,
    event_type: 'MESSAGE_REJECTED_OPEN_REVIEW',
    status: 'RETRY',
    details: {
      message_sid: event.message_sid,
      existing_review_id: staging.review_id,
      state: staging.state
    }
  }, staging.owner_id);
  return _nrmStateResult_(staging, {
    message: message || _nrmOpenReviewInstruction_(staging.state)
  });
}

function _nrmOpenReviewInstruction_(state) {
  if (state === 'PROCESSING' || state === 'REVISING') {
    return 'Still working on your previous entry. Please resend this message in a minute.';
  }
  if (state === 'PENDING_REVIEW') {
    return 'Finish your open review first: reply YES or send a correction, or reply CANCEL to discard it. Then resend this message.';
  }
  if (state === 'ERROR') {
    return 'Your previous entry failed. Reply CANCEL to clear it, then resend your entry.';
  }
  if (state === 'DISAMBIGUATING') {
    return 'Finish choosing a contact for your open review, or reply CANCEL to discard it.';
  }
  return 'Finish or cancel your open review, then resend this message.';
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

function _nrmReviewValidationIssues_(staging, bundle) {
  const interaction = bundle && bundle.interaction;
  if (!interaction || Object.prototype.toString.call(interaction) !== '[object Object]') {
    return [{
      field: 'interaction',
      prompt: 'I could not build an interaction draft. Reply CANCEL and resend the entry.'
    }];
  }

  const issues = [];
  const explicitNoDate = Boolean(
    bundle.review_control && bundle.review_control.no_date_confirmed === true
  );
  if (!interaction.interaction_date && !explicitNoDate) {
    issues.push({
      field: 'interaction_date',
      prompt: 'I need a date for this. Reply with a date (or "earlier this week", etc.), or reply NO DATE if there is not a specific one.'
    });
  } else if (interaction.interaction_date) {
    try {
      normalizeDate(interaction.interaction_date);
    } catch (error) {
      issues.push({
        field: 'interaction_date',
        prompt: 'I could not understand the interaction date. Reply with a specific date or relative date, or reply NO DATE.'
      });
    }
  }

  if (!interaction.platform || NRM_PLATFORMS.indexOf(interaction.platform) === -1) {
    issues.push({
      field: 'platform',
      prompt: 'I need the interaction method. Reply with how you interacted, such as in person, text, call, email, or video call.'
    });
  }
  if (!String(interaction.summary || '').trim()) {
    issues.push({
      field: 'summary',
      prompt: 'I need a short summary. Reply with what happened.'
    });
  }

  if (!staging.selected_contact_id) {
    const contact = _nrmContactProposalFromDraft_(interaction, bundle.contact || {});
    if (!String(contact.display_name || '').trim()) {
      issues.push({
        field: 'contact.display_name',
        prompt: 'I need the person\'s name. Reply with their name, or reply CANCEL if this should not be saved.'
      });
    }
  }
  return issues;
}

function _nrmTransitionToError_(staging, error, critical) {
  const ownerId = staging.owner_id;
  const eventType = critical ? 'OWNER_MISMATCH' : 'ERROR';
  if (critical) {
    console.error('CRITICAL OWNER_MISMATCH review_id=' + staging.review_id);
  }
  const failed = _nrmMarkStagingError_(staging.review_id, {
    code: eventType,
    message: error.message
  }, ownerId);
  logEvent({
    review_id: staging.review_id,
    event_type: eventType,
    status: 'FAILURE',
    details: { message: error.message }
  }, ownerId);
  return _nrmStateResult_(failed, {
    message: critical ? 'Owner mismatch rejected.' : 'Processing failed.'
  });
}

function _nrmMarkStagingError_(reviewId, errorData, ownerId) {
  const target = _nrmReadOwnedRows_('Staging', ownerId).find(function (entry) {
    return entry.record.review_id === reviewId;
  });
  if (!target) {
    throw new Error('STAGING_NOT_FOUND: ' + reviewId);
  }
  const failed = Object.assign({}, target.record, {
    state: 'ERROR',
    updated_at: currentDateTimeUtc(),
    error_json: errorData
  });
  _nrmWriteObjectAtRow_('Staging', target.rowNumber, failed);
  return _nrmObjectFromRow_(NRM_HEADERS.Staging, NRM_HEADERS.Staging.map(function (header) {
    return _nrmCellValue_(failed[header]);
  }));
}

function _nrmMessageSidSeen_(messageSid, ownerId) {
  const inStaging = _nrmReadOwnedRows_('Staging', ownerId).some(function (entry) {
    return entry.record.message_sid === messageSid;
  });
  if (inStaging || findInteractionBySourceMessageSid(messageSid, ownerId)) {
    return true;
  }
  return _nrmReadOwnedRows_('EventLog', ownerId).some(function (entry) {
    const details = _nrmParseJsonObject_(entry.record.details, {});
    return details.message_sid === messageSid;
  });
}

function _nrmLogMessageAccepted_(event, reviewId) {
  logEvent({
    review_id: reviewId,
    event_type: 'MESSAGE_ACCEPTED',
    status: 'SUCCESS',
    details: { message_sid: event.message_sid }
  }, event.owner_id);
}

function _nrmNormalizeEvent_(event) {
  if (!event || Object.prototype.toString.call(event) !== '[object Object]') {
    throw new Error('INVALID_EVENT: normalized event object required.');
  }
  const ownerId = _nrmRequireOwnerId_(event.owner_id);
  const reviewId = event.review_id ? _nrmRequireString_(event.review_id, 'review_id') : '';
  return {
    message_sid: _nrmRequireString_(event.message_sid, 'message_sid'),
    owner_id: ownerId,
    owner_number: reviewId ? String(event.owner_number || '') : _nrmRequireString_(event.owner_number, 'owner_number'),
    review_id: reviewId,
    body: String(event.body || ''),
    media_refs: Array.isArray(event.media_refs) ? event.media_refs.slice() : [],
    contact_query: String(event.contact_query || ''),
    contact: event.contact || {}
  };
}

function _nrmNormalizedContact_(contact, fallbackName) {
  if (!contact || Object.prototype.toString.call(contact) !== '[object Object]') {
    throw new Error('INVALID_EVENT: contact must be an object.');
  }
  if (contact.owner_id !== undefined) {
    throw new Error('INVALID_EVENT: contact must not supply owner_id.');
  }
  const allowed = [
    'display_name', 'context_tag', 'phone', 'email', 'organization',
    'role_title', 'relationship_summary'
  ];
  const normalized = {};
  allowed.forEach(function (field) {
    if (contact[field] !== undefined) normalized[field] = contact[field];
  });
  if (!normalized.display_name && fallbackName) normalized.display_name = fallbackName;
  return normalized;
}

function _nrmContactProposalFromDraft_(draft, seedContact) {
  const seed = _nrmNormalizedContact_(seedContact || {}, '');
  const details = _nrmParseJsonObject_(draft && draft.details_json, {});
  const person = _nrmParseJsonObject_(details.person, {});
  const fieldMap = {
    name: 'display_name',
    context_tag: 'context_tag',
    phone: 'phone',
    email: 'email',
    organization: 'organization'
  };
  const extracted = {};
  Object.keys(fieldMap).forEach(function (sourceField) {
    const value = person[sourceField];
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (normalized) extracted[fieldMap[sourceField]] = normalized;
  });
  return Object.assign({}, seed, extracted);
}

function _nrmContactQuery_(explicitQuery, contact) {
  const explicit = String(explicitQuery || '').trim();
  if (explicit) return explicit;
  const candidateFields = ['phone', 'email', 'display_name', 'organization'];
  for (let index = 0; index < candidateFields.length; index += 1) {
    const value = String(contact[candidateFields[index]] || '').trim();
    if (value) return value;
  }
  return '';
}

function _nrmStateResult_(staging, extra) {
  return Object.assign({
    owner_id: staging.owner_id,
    review_id: staging.review_id,
    state: staging.state,
    duplicate: false
  }, extra || {});
}

function _nrmParseJsonArray_(value) {
  if (Array.isArray(value)) return value.slice();
  if (value === undefined || value === null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('not array');
    return parsed;
  } catch (error) {
    throw new Error('INVALID_JSON_ARRAY');
  }
}

function _nrmMediaUrlsForLocalAi_(mediaRefs) {
  return mediaRefs.map(function (mediaRef) {
    if (typeof mediaRef === 'string') return mediaRef;
    if (mediaRef && Object.prototype.toString.call(mediaRef) === '[object Object]') {
      return _nrmRequireString_(mediaRef.url, 'media_ref.url');
    }
    throw new Error('INVALID_MEDIA_REF');
  });
}

function _nrmParseJsonObject_(value, fallback) {
  if (value && Object.prototype.toString.call(value) === '[object Object]') return value;
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Object.prototype.toString.call(parsed) !== '[object Object]') {
      throw new Error('not object');
    }
    return parsed;
  } catch (error) {
    throw new Error('INVALID_JSON_OBJECT');
  }
}
