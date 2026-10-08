/**
 * Owner-scoped normalized event entry point shared by the Stage 3 tests and
 * the Stage 4 Twilio adapter in Twilio.gs.
 */

const NRM_STATE_LOCK_WAIT_MS = 1000;
var NRM_TEST_STATE_LOCK_ = null;

function handleNormalizedEvent(event) {
  const lock = NRM_TEST_STATE_LOCK_ || LockService.getScriptLock();
  if (!lock.tryLock(NRM_STATE_LOCK_WAIT_MS)) {
    return _nrmHandleStateLockContention_(event);
  }
  try {
    return routeNormalizedEvent(event);
  } finally {
    lock.releaseLock();
  }
}

function _nrmHandleStateLockContention_(event) {
  const normalized = _nrmNormalizeEvent_(event);
  const staging = normalized.review_id
    ? findStagingByReviewId(normalized.review_id, normalized.owner_id)
    : _nrmFindOpenReviewForSender_(normalized.owner_number, normalized.owner_id);
  if (staging) {
    return _nrmRejectOpenReviewMessage_(staging, normalized);
  }

  logEvent({
    event_type: 'MESSAGE_REJECTED_BUSY',
    status: 'RETRY',
    details: {
      message_sid: normalized.message_sid,
      state: 'NONE'
    }
  }, normalized.owner_id);
  return {
    owner_id: normalized.owner_id,
    review_id: '',
    state: 'BUSY',
    duplicate: false,
    message: 'NRM is busy with another entry. Please resend this message in a minute.'
  };
}
