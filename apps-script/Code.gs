/**
 * Owner-scoped normalized event entry point shared by the Stage 3 tests and
 * the Stage 4 Twilio adapter in Twilio.gs.
 */

function handleNormalizedEvent(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('STATE_MACHINE_BUSY: could not acquire script lock.');
  }
  try {
    return routeNormalizedEvent(event);
  } finally {
    lock.releaseLock();
  }
}
