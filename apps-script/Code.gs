/**
 * Active Stage 3 entry point. The caller supplies an authenticated,
 * normalized event; this layer does not parse Twilio form payloads.
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
