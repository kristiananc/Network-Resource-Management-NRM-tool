/**
 * Owner-scoped Stage 3 workflow state machine.
 */

const NRM_YES_REPLIES = Object.freeze(['YES', 'Y']);

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
    return _nrmStartCapture_(normalized);
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

  _nrmLogMessageAccepted_(normalized, staging.review_id);
  return _nrmDispatchState_(staging, normalized);
}

function handleProcessing_(staging, event) {
  const seed = _nrmParseJsonObject_(staging.draft_json, {});
  const response = processInteractionWithLocalAi_({
    owner_id: staging.owner_id,
    review_id: staging.review_id,
    raw_body: staging.raw_body || '',
    media_refs: _nrmParseJsonArray_(staging.media_json)
  });
  const query = String(seed.contact_query || event.contact_query || '').trim();
  const candidates = searchContacts(query, staging.owner_id);
  const candidateIds = candidates.map(function (contact) { return contact.contact_id; });
  const bundle = {
    interaction: response.draft,
    contact: seed.contact || {},
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
  return _nrmStateResult_(pending, {
    message: 'Reply YES to approve or send a correction.'
  });
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
    return _nrmStateResult_(staging, {
      message: 'Invalid candidate number. Reply with 1-' + ownedCandidates.length + '.'
    });
  }

  const pending = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW',
    selected_contact_id: ownedCandidates[candidateIndex].contact_id,
    error_json: ''
  }, staging.owner_id);
  return _nrmStateResult_(pending, {
    message: 'Reply YES to approve or send a correction.'
  });
}

function handlePendingReview_(staging, event) {
  if (isYesApproval_(event.body)) {
    return _nrmCommitApprovedReview_(staging);
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
  const response = reviseDraftWithLocalAi_({
    owner_id: staging.owner_id,
    review_id: staging.review_id,
    draft: bundle.interaction,
    correction: _nrmRequireString_(event.body, 'correction')
  });
  bundle.interaction = response.draft;
  const pending = updateStaging(staging.review_id, {
    state: 'PENDING_REVIEW',
    draft_json: bundle,
    error_json: ''
  }, staging.owner_id);
  return _nrmStateResult_(pending, {
    message: 'Revision ready. Reply YES to approve or send another correction.'
  });
}

function handleError_(staging) {
  return _nrmStateResult_(staging, {
    message: 'Review is in ERROR and requires recovery.'
  });
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
      contact_query: event.contact_query || contact.display_name || event.body
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
    if (staging.state === 'REVISING') return handleRevising_(staging, event);
    if (staging.state === 'ERROR') return handleError_(staging, event);
    throw new Error('INVALID_STATE: ' + staging.state);
  } catch (error) {
    const critical = error.message.indexOf('OWNER_MISMATCH') !== -1;
    return _nrmTransitionToError_(staging, error, critical);
  }
}

function _nrmCommitApprovedReview_(staging) {
  const ownerId = staging.owner_id;
  const bundle = _nrmParseJsonObject_(staging.draft_json, {});
  if (!bundle.interaction) {
    throw new Error('MISSING_DRAFT: staged interaction draft is required.');
  }

  let contact;
  if (staging.selected_contact_id) {
    contact = findContactById(staging.selected_contact_id, ownerId);
    if (!contact) {
      throw new Error('OWNER_MISMATCH: resolved contact_id does not belong to staging owner_id.');
    }
  } else {
    contact = createContact(bundle.contact || {}, ownerId);
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
  }, ownerId);

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
