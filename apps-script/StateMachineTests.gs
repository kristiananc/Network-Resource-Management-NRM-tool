/**
 * Executable Stage 3 state-machine tests.
 */

function runStage3Tests() {
  const results = [
    _nrmRunTest_('two-owner concurrent full loop', _nrmTestConcurrentOwnerLoop_),
    _nrmRunTest_('MessageSid duplicate checks', _nrmTestMessageSidDuplicates_),
    _nrmRunTest_('AI person new contact guarded commit', _nrmTestNewContactCommit_),
    _nrmRunTest_('empty staged contact recovery', _nrmTestEmptyContactBundleCommit_),
    _nrmRunTest_('AI person existing contact resolution', _nrmTestExistingContactCommit_),
    _nrmRunTest_('missing date prompt then supplied date', _nrmTestMissingDatePromptAndCorrection_),
    _nrmRunTest_('explicit NO DATE approval', _nrmTestExplicitNoDateApproval_),
    _nrmRunTest_('missing contact name prompt', _nrmTestMissingContactNamePrompt_),
    _nrmRunTest_('open-review per-state routing trace', _nrmTestOpenReviewStateRouting_),
    _nrmRunTest_('CANCEL and command isolation', _nrmTestCancelAndCommandIsolation_),
    _nrmRunTest_('PROCESSING lock contention reply', _nrmTestProcessingLockContention_),
    _nrmRunTest_('OWNER_MISMATCH hard rejection', _nrmTestOwnerMismatchCommit_),
    _nrmRunTest_('Local API owner passthrough guard', _nrmTestLocalAiOwnerMismatch_),
    _nrmRunTest_('candidate and YES parsing', _nrmTestReplyParsing_),
    _nrmRunTest_('Stage 3 persistence owner guards', _nrmTestStage3PersistenceOwnerGuards_)
  ];
  results.forEach(function (line) { Logger.log(line); });
  const failures = results.filter(function (line) { return line.indexOf('FAIL ') === 0; });
  if (failures.length) {
    throw new Error('Stage 3 tests failed:\n' + failures.join('\n'));
  }
  Logger.log('PASS Stage 3 suite: ' + results.length + '/' + results.length + ' tests passed.');
  return results;
}

function runStage3CrossOwnerLoopTest() {
  const output = _nrmTestConcurrentOwnerLoop_();
  Logger.log(output);
  return output;
}

function runStage3FastApiIntegrationTest() {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    const previousClient = NRM_TEST_LOCAL_AI_CLIENT_;
    const ownerId = ' Own/Stage3:Opaque ';
    try {
      setupNrmSheets();
      NRM_TEST_LOCAL_AI_CLIENT_ = null;
      createContact({
        contact_id: 'contact_stage3_http', display_name: 'HTTP Contact',
        context_tag: 'Integration'
      }, ownerId);
      const started = handleNormalizedEvent({
        message_sid: 'SM3_HTTP_CAPTURE', owner_id: ownerId,
        owner_number: '+15550000003', body: 'HTTP integration capture.',
        contact_query: 'HTTP Contact', contact: { display_name: 'HTTP Contact' }
      });
      _nrmAssert_(started.owner_id === ownerId, 'FastAPI process changed owner_id.');
      _nrmAssert_(started.state === 'PENDING_REVIEW', 'FastAPI process did not reach review.');
      const revised = handleNormalizedEvent({
        message_sid: 'SM3_HTTP_REVISE', owner_id: ownerId,
        review_id: started.review_id, body: 'Revise through real HTTP.'
      });
      _nrmAssert_(revised.owner_id === ownerId, 'FastAPI revise changed owner_id.');
      _nrmAssert_(revised.state === 'PENDING_REVIEW', 'FastAPI revision did not return to review.');
      const committed = handleNormalizedEvent({
        message_sid: 'SM3_HTTP_APPROVE', owner_id: ownerId,
        review_id: started.review_id, body: 'YES'
      });
      _nrmAssert_(committed.state === 'COMMITTED', 'HTTP-backed review did not commit.');
      const interactions = _nrmReadOwnedRows_('Interactions', ownerId);
      _nrmAssert_(interactions.length === 1, 'HTTP-backed interaction missing.');
      _nrmAssert_(interactions[0].record.owner_id === ownerId, 'Committed owner_id changed.');
      const output = 'PASS Stage 3 FastAPI integration: real /process-interaction and /revise-draft HTTP calls preserved adversarial owner_id and committed one scoped interaction.';
      Logger.log(output);
      return output;
    } finally {
      NRM_TEST_LOCAL_AI_CLIENT_ = previousClient;
    }
  });
}

function _nrmTestConcurrentOwnerLoop_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const ownerAStart = handleNormalizedEvent({
      message_sid: 'SM3_A_CAPTURE', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Met Sarah for coffee.',
      contact_query: 'Sarah Chen', contact: { display_name: 'Sarah Chen' }
    });
    const ownerBStart = handleNormalizedEvent({
      message_sid: 'SM3_B_CAPTURE', owner_id: NRM_TEST_OWNER_B,
      owner_number: '+15550000002', body: 'Met Sarah at work.',
      contact_query: 'Sarah Chen', contact: { display_name: 'Sarah Chen' }
    });
    _nrmAssert_(ownerAStart.state === 'DISAMBIGUATING', 'Owner A should disambiguate two contacts.');
    _nrmAssert_(ownerAStart.candidates.length === 2, 'Owner A should receive two candidates.');
    _nrmAssert_(ownerBStart.state === 'PENDING_REVIEW', 'Owner B should have one selected candidate.');

    const ownerAStaging = findStagingByReviewId(ownerAStart.review_id, NRM_TEST_OWNER_A);
    const ownerACandidates = _nrmParseJsonArray_(ownerAStaging.candidate_contact_ids);
    _nrmAssert_(ownerACandidates.join(',') === 'contact_a_navwar,contact_a_usc', 'Owner A candidates contaminated.');
    _nrmAssert_(findStagingByReviewId(ownerAStart.review_id, NRM_TEST_OWNER_B) === null, 'Owner B could read Owner A staging.');

    const invalidChoice = handleNormalizedEvent({
      message_sid: 'SM3_A_BAD_CHOICE', owner_id: NRM_TEST_OWNER_A,
      review_id: ownerAStart.review_id, body: '3'
    });
    _nrmAssert_(invalidChoice.state === 'DISAMBIGUATING', 'Invalid candidate number changed state.');
    const ownerASelected = handleNormalizedEvent({
      message_sid: 'SM3_A_CHOICE', owner_id: NRM_TEST_OWNER_A,
      review_id: ownerAStart.review_id, body: '2'
    });
    _nrmAssert_(ownerASelected.state === 'PENDING_REVIEW', 'Owner A candidate selection failed.');

    const ownerBCommitted = handleNormalizedEvent({
      message_sid: 'SM3_B_APPROVE', owner_id: NRM_TEST_OWNER_B,
      review_id: ownerBStart.review_id, body: 'YES'
    });
    _nrmAssert_(ownerBCommitted.state === 'COMMITTED', 'Owner B approval did not commit.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B).length === 1, 'Owner B interaction missing.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'Owner B commit contaminated Owner A.');

    const ownerARevised = handleNormalizedEvent({
      message_sid: 'SM3_A_REVISE', owner_id: NRM_TEST_OWNER_A,
      review_id: ownerAStart.review_id, body: 'Use a revised summary.'
    });
    _nrmAssert_(ownerARevised.state === 'PENDING_REVIEW', 'Owner A revision did not return to review.');
    const revisedStaging = findStagingByReviewId(ownerAStart.review_id, NRM_TEST_OWNER_A);
    _nrmAssert_(Number(revisedStaging.revision_count) === 1, 'revision_count did not increment.');
    const revisedBundle = _nrmParseJsonObject_(revisedStaging.draft_json, {});
    _nrmAssert_(revisedBundle.interaction.summary.indexOf('revised') !== -1, 'Revised dummy draft not stored.');

    const ownerACommitted = handleNormalizedEvent({
      message_sid: 'SM3_A_APPROVE', owner_id: NRM_TEST_OWNER_A,
      review_id: ownerAStart.review_id, body: 'y'
    });
    _nrmAssert_(ownerACommitted.state === 'COMMITTED', 'Owner A approval did not commit.');
    const ownerAInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    const ownerBInteractions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B);
    _nrmAssert_(ownerAInteractions.length === 1 && ownerBInteractions.length === 1, 'Expected one interaction per owner.');
    _nrmAssert_(ownerAInteractions[0].record.contact_id === 'contact_a_usc', 'Owner A committed wrong candidate.');
    _nrmAssert_(ownerBInteractions[0].record.contact_id === 'contact_b_work', 'Owner B committed wrong candidate.');
    _nrmAssert_(ownerAInteractions[0].record.owner_id === NRM_TEST_OWNER_A, 'Owner A interaction owner changed.');
    _nrmAssert_(ownerBInteractions[0].record.owner_id === NRM_TEST_OWNER_B, 'Owner B interaction owner changed.');
    return 'PASS two-owner concurrent full loop: own_test_a and own_test_b interleaved capture/review; one correctly scoped interaction each; zero cross-contamination.';
  });
}

function _nrmTestMessageSidDuplicates_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const ownerAEvent = {
      message_sid: 'SM3_SHARED_SID', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Met Sarah.',
      contact_query: 'Sarah Chen', contact: { display_name: 'Sarah Chen' }
    };
    const first = handleNormalizedEvent(ownerAEvent);
    const duplicate = handleNormalizedEvent(ownerAEvent);
    _nrmAssert_(first.duplicate === false && duplicate.duplicate === true, 'Owner A duplicate not detected.');
    _nrmAssert_(_nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A).length === 1, 'Duplicate created another staging row.');

    const ownerB = handleNormalizedEvent({
      message_sid: 'SM3_SHARED_SID', owner_id: NRM_TEST_OWNER_B,
      owner_number: '+15550000002', body: 'Met Sarah.',
      contact_query: 'Sarah Chen', contact: { display_name: 'Sarah Chen' }
    });
    _nrmAssert_(ownerB.duplicate === false, 'Same MessageSid under another owner was treated globally.');
    const approval = {
      message_sid: 'SM3_B_DUP_APPROVAL', owner_id: NRM_TEST_OWNER_B,
      review_id: ownerB.review_id, body: 'YES'
    };
    _nrmAssert_(handleNormalizedEvent(approval).state === 'COMMITTED', 'Owner B approval failed.');
    _nrmAssert_(handleNormalizedEvent(approval).duplicate === true, 'Duplicate follow-up MessageSid not detected.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B).length === 1, 'Duplicate approval wrote twice.');
    return 'PASS MessageSid duplicate checks: replays rejected per owner, same SID allowed across owners, duplicate approval wrote exactly once.';
  });
}

function _nrmTestNewContactCommit_() {
  return _nrmWithStage3Spreadsheet_(function () {
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      _nrmAssert_(path === '/process-interaction', 'Unexpected new-contact AI path.');
      return {
        owner_id: payload.owner_id,
        review_id: payload.review_id,
        schema_version: '1.0',
        draft: _nrmStage3DraftWithPerson_(payload.raw_body, {
          name: 'Jordan New',
          organization: 'Community Works',
          context_tag: 'Community',
          phone: '+15551234567',
          email: 'jordan@example.test'
        })
      };
    };
    const started = handleNormalizedEvent({
      message_sid: 'SM3_NEW_CAPTURE', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Met Jordan New from Community Works today.'
    });
    _nrmAssert_(started.state === 'PENDING_REVIEW', 'New contact should go directly to review.');
    const staged = findStagingByReviewId(started.review_id, NRM_TEST_OWNER_A);
    const stagedBundle = _nrmParseJsonObject_(staged.draft_json, {});
    _nrmAssert_(stagedBundle.contact.display_name === 'Jordan New', 'AI person.name was not staged as display_name.');
    _nrmAssert_(stagedBundle.contact.organization === 'Community Works', 'AI person.organization was not staged.');
    _nrmAssert_(stagedBundle.contact.context_tag === 'Community', 'AI person.context_tag was not staged.');
    _nrmAssert_(stagedBundle.contact.phone === '+15551234567', 'AI person.phone was not staged.');
    _nrmAssert_(stagedBundle.contact.email === 'jordan@example.test', 'AI person.email was not staged.');
    const committed = handleNormalizedEvent({
      message_sid: 'SM3_NEW_APPROVE', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(committed.state === 'COMMITTED', 'New contact approval failed.');
    const contacts = searchContacts('Jordan New', NRM_TEST_OWNER_A);
    _nrmAssert_(contacts.length === 1, 'New owner A contact missing.');
    _nrmAssert_(contacts[0].display_name === 'Jordan New', 'Committed display_name is wrong.');
    _nrmAssert_(contacts[0].organization === 'Community Works', 'Committed organization is wrong.');
    _nrmAssert_(contacts[0].context_tag === 'Community', 'Committed context_tag is wrong.');
    _nrmAssert_(contacts[0].phone === '+15551234567', 'Committed phone is wrong.');
    _nrmAssert_(contacts[0].email === 'jordan@example.test', 'Committed email is wrong.');
    _nrmAssert_(searchContacts('Jordan New', NRM_TEST_OWNER_B).length === 0, 'New contact leaked to owner B.');
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    _nrmAssert_(interactions.length === 1, 'New contact interaction missing.');
    _nrmAssert_(interactions[0].record.contact_id === contacts[0].contact_id, 'Interaction did not link to created Contact.');
    _nrmAssert_(interactions[0].record.owner_id === NRM_TEST_OWNER_A, 'Interaction owner_id changed.');
    _nrmAssert_(findStagingByReviewId(started.review_id, NRM_TEST_OWNER_A) === null, 'Committed Staging row was not cleared.');
    const committedEvents = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      return entry.record.review_id === started.review_id &&
        entry.record.event_type === 'COMMITTED' && entry.record.status === 'SUCCESS';
    });
    _nrmAssert_(committedEvents.length === 1, 'COMMITTED success EventLog row missing.');
    const committedDetails = _nrmParseJsonObject_(committedEvents[0].record.details, {});
    _nrmAssert_(committedDetails.contact_id === contacts[0].contact_id, 'COMMITTED event has wrong contact_id.');
    _nrmAssert_(committedDetails.interaction_id === interactions[0].record.interaction_id, 'COMMITTED event has wrong interaction_id.');
    return 'PASS AI person new contact commit: mapped name/organization/context/phone/email, linked owner-scoped Interaction, cleared Staging, and logged COMMITTED success.';
  });
}

function _nrmTestExistingContactCommit_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const beforeContacts = _nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_B).length;
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      _nrmAssert_(path === '/process-interaction', 'Unexpected existing-contact AI path.');
      return {
        owner_id: payload.owner_id,
        review_id: payload.review_id,
        schema_version: '1.0',
        draft: _nrmStage3DraftWithPerson_(payload.raw_body, {
          name: 'Sarah Chen', organization: 'Example Corp', context_tag: 'Work',
          phone: null, email: null
        })
      };
    };
    const started = handleNormalizedEvent({
      message_sid: 'SM3_EXISTING_CAPTURE', owner_id: NRM_TEST_OWNER_B,
      owner_number: '+15550000002', body: 'Met Sarah Chen for coffee today.'
    });
    _nrmAssert_(started.state === 'PENDING_REVIEW', 'Existing contact did not reach review.');
    const staged = findStagingByReviewId(started.review_id, NRM_TEST_OWNER_B);
    _nrmAssert_(staged.selected_contact_id === 'contact_b_work', 'AI person name did not resolve the owned existing contact.');
    const committed = handleNormalizedEvent({
      message_sid: 'SM3_EXISTING_APPROVE', owner_id: NRM_TEST_OWNER_B,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(committed.state === 'COMMITTED', 'Existing-contact approval failed.');
    _nrmAssert_(_nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_B).length === beforeContacts, 'Existing-contact commit created a duplicate Contact.');
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B);
    _nrmAssert_(interactions.length === 1, 'Existing-contact Interaction missing.');
    _nrmAssert_(interactions[0].record.contact_id === 'contact_b_work', 'Interaction linked to the wrong existing Contact.');
    _nrmAssert_(interactions[0].record.owner_id === NRM_TEST_OWNER_B, 'Existing-contact Interaction owner_id changed.');
    return 'PASS AI person existing contact resolution: matched within owner, created no duplicate Contact, and linked the Interaction to contact_b_work.';
  });
}

function _nrmTestMissingDatePromptAndCorrection_() {
  return _nrmWithStage3Spreadsheet_(function () {
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      if (path === '/process-interaction') {
        const draft = _nrmStage3DraftWithPerson_(payload.raw_body, {
          name: 'Kris Angell', organization: 'Toastmasters', context_tag: 'Toastmasters'
        });
        draft.interaction_date = null;
        return {
          owner_id: payload.owner_id, review_id: payload.review_id,
          schema_version: '1.0', draft: draft
        };
      }
      _nrmAssert_(path === '/revise-draft', 'Expected date correction through revision path.');
      const revised = Object.assign({}, payload.draft, { interaction_date: '2026-10-03' });
      return {
        owner_id: payload.owner_id, review_id: payload.review_id,
        schema_version: '1.0', draft: revised
      };
    };

    const started = handleNormalizedEvent({
      message_sid: 'SM3_MISSING_DATE', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Kris Angell recently opened a winery touring business.'
    });
    _nrmAssert_(started.state === 'PENDING_REVIEW', 'Missing date should remain reviewable.');
    _nrmAssert_(started.missing_fields.join(',') === 'interaction_date', 'Missing date was not identified at draft time.');
    _nrmAssert_(started.message.indexOf('I need a date for this.') !== -1, 'Specific date prompt missing.');

    const prematureYes = handleNormalizedEvent({
      message_sid: 'SM3_MISSING_DATE_YES', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(prematureYes.state === 'PENDING_REVIEW', 'YES with missing date entered ERROR or committed.');
    _nrmAssert_(_nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_A).length === 2, 'Premature YES partially created a Contact.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'Premature YES wrote an Interaction.');

    const revised = handleNormalizedEvent({
      message_sid: 'SM3_DATE_CORRECTION', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'It happened on October 3, 2026.'
    });
    _nrmAssert_(revised.state === 'PENDING_REVIEW', 'Date correction did not return to review.');
    _nrmAssert_(revised.missing_fields.length === 0, 'Supplied date remained missing.');
    const committed = handleNormalizedEvent({
      message_sid: 'SM3_DATE_APPROVE', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(committed.state === 'COMMITTED', 'Corrected date did not commit.');
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    _nrmAssert_(interactions.length === 1, 'Corrected interaction missing.');
    _nrmAssert_(interactions[0].record.interaction_date === '2026-10-03', 'Corrected date changed.');
    const validationEvents = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      return entry.record.event_type === 'VALIDATION_REQUIRED';
    });
    _nrmAssert_(validationEvents.length === 1, 'Missing-date YES did not log VALIDATION_REQUIRED.');
    return 'PASS missing date prompt then supplied date: draft named interaction_date before confirmation; premature YES wrote no Contact/Interaction; date revision committed 2026-10-03.';
  });
}

function _nrmTestExplicitNoDateApproval_() {
  return _nrmWithStage3Spreadsheet_(function () {
    let revisionCalls = 0;
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      if (path === '/revise-draft') revisionCalls += 1;
      const draft = _nrmStage3DraftWithPerson_(payload.raw_body || '', {
        name: 'No Date Person', organization: null, context_tag: null
      });
      draft.interaction_date = null;
      return {
        owner_id: payload.owner_id, review_id: payload.review_id,
        schema_version: '1.0', draft: draft
      };
    };
    const started = handleNormalizedEvent({
      message_sid: 'SM3_NO_DATE_CAPTURE', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'No Date Person runs a local business.'
    });
    const noDate = handleNormalizedEvent({
      message_sid: 'SM3_NO_DATE_REPLY', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: ' no date '
    });
    _nrmAssert_(noDate.state === 'PENDING_REVIEW', 'NO DATE did not return to review.');
    _nrmAssert_(noDate.missing_fields.length === 0, 'Explicit NO DATE still reported date missing.');
    _nrmAssert_(revisionCalls === 0, 'NO DATE was sent to the model instead of handled as an explicit correction.');
    const staged = findStagingByReviewId(started.review_id, NRM_TEST_OWNER_A);
    const bundle = _nrmParseJsonObject_(staged.draft_json, {});
    _nrmAssert_(bundle.review_control.no_date_confirmed === true, 'NO DATE control metadata missing.');
    _nrmAssert_(Number(staged.revision_count) === 1, 'NO DATE did not traverse the revision state path.');
    const committed = handleNormalizedEvent({
      message_sid: 'SM3_NO_DATE_APPROVE', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(committed.state === 'COMMITTED', 'Explicit NO DATE did not commit.');
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    _nrmAssert_(interactions.length === 1 && interactions[0].record.interaction_date === '', 'NO DATE was not stored as blank.');
    return 'PASS explicit NO DATE approval: command traversed REVISING, set draft_json review_control, bypassed the model, and committed one blank-date Interaction only after YES.';
  });
}

function _nrmTestMissingContactNamePrompt_() {
  return _nrmWithStage3Spreadsheet_(function () {
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      const draft = _nrmStage3DraftWithPerson_(payload.raw_body, {
        name: null, organization: 'Camp Pendleton', context_tag: null
      });
      return {
        owner_id: payload.owner_id, review_id: payload.review_id,
        schema_version: '1.0', draft: draft
      };
    };
    const started = handleNormalizedEvent({
      message_sid: 'SM3_MISSING_NAME', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Went to Camp Pendleton.'
    });
    _nrmAssert_(started.missing_fields.indexOf('contact.display_name') !== -1, 'Missing Contact name was not detected.');
    _nrmAssert_(started.message.indexOf("I need the person's name.") !== -1, 'Specific name prompt missing.');
    const prematureYes = handleNormalizedEvent({
      message_sid: 'SM3_MISSING_NAME_YES', owner_id: NRM_TEST_OWNER_A,
      review_id: started.review_id, body: 'YES'
    });
    _nrmAssert_(prematureYes.state === 'PENDING_REVIEW', 'Missing name entered ERROR.');
    _nrmAssert_(_nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_A).length === 2, 'Missing name partially wrote Contact.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'Missing name wrote Interaction.');
    return 'PASS missing contact name prompt: unnamed capture stayed PENDING_REVIEW, named contact.display_name in plain language, and premature YES wrote nothing permanent.';
  });
}

function _nrmTestOpenReviewStateRouting_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const trace = [];
    const originalClient = NRM_TEST_LOCAL_AI_CLIENT_;

    const processing = createStaging({
      message_sid: 'SM3_TRACE_PROCESSING_ORIGINAL', owner_number: '+15550000901',
      state: 'PROCESSING', raw_body: 'Original processing capture.',
      draft_json: { contact: {}, contact_query: '' }
    }, NRM_TEST_OWNER_A);
    NRM_TEST_LOCAL_AI_CLIENT_ = function () {
      throw new Error('Processing rejection must not invoke Local AI.');
    };
    const processingReply = handleNormalizedEvent({
      message_sid: 'SM3_TRACE_PROCESSING_NEW', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000901', body: 'Second capture while processing.'
    });
    _nrmAssert_(processingReply.state === 'PROCESSING', 'PROCESSING rejection changed state.');
    _nrmAssert_(processingReply.message === 'Still working on your previous entry. Please resend this message in a minute.', 'PROCESSING reply is wrong.');
    _nrmAssert_(findStagingByReviewId(processing.review_id, NRM_TEST_OWNER_A).state === 'PROCESSING', 'PROCESSING row changed.');
    trace.push('PROCESSING=>rejected/state unchanged/reply=resend in a minute');
    deleteStaging(processing.review_id, NRM_TEST_OWNER_A);

    NRM_TEST_LOCAL_AI_CLIENT_ = originalClient;
    const disambiguating = createStaging({
      message_sid: 'SM3_TRACE_DISAMBIGUATING_ORIGINAL', owner_number: '+15550000902',
      state: 'DISAMBIGUATING', raw_body: 'Ambiguous capture.',
      candidate_contact_ids: ['contact_a_navwar', 'contact_a_usc'],
      draft_json: { contact: { display_name: 'Sarah Chen' }, interaction: _nrmStage3DummyDraft_('Ambiguous capture.', []) }
    }, NRM_TEST_OWNER_A);
    const disambiguatingReply = handleNormalizedEvent({
      message_sid: 'SM3_TRACE_DISAMBIGUATING_NEW', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000902', body: 'Joe is someone else.'
    });
    _nrmAssert_(disambiguatingReply.state === 'DISAMBIGUATING', 'Invalid candidate changed state.');
    _nrmAssert_(disambiguatingReply.message.indexOf('waiting for a contact choice') !== -1, 'Disambiguation guidance missing.');
    trace.push('DISAMBIGUATING=>rejected/state unchanged/reply=choose 1-2 or CANCEL');
    deleteStaging(disambiguating.review_id, NRM_TEST_OWNER_A);

    const pending = createStaging({
      message_sid: 'SM3_TRACE_PENDING_ORIGINAL', owner_number: '+15550000903',
      state: 'PENDING_REVIEW', raw_body: 'Pending capture.',
      selected_contact_id: 'contact_a_navwar',
      draft_json: { contact: { display_name: 'Sarah Chen' }, interaction: _nrmStage3DummyDraft_('Pending capture.', []) }
    }, NRM_TEST_OWNER_A);
    const pendingReply = handleNormalizedEvent({
      message_sid: 'SM3_TRACE_PENDING_NEW', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000903', body: 'Correct the summary.'
    });
    _nrmAssert_(pendingReply.state === 'PENDING_REVIEW', 'PENDING correction did not return to review.');
    const pendingAfter = findStagingByReviewId(pending.review_id, NRM_TEST_OWNER_A);
    _nrmAssert_(Number(pendingAfter.revision_count) === 1, 'PENDING correction did not increment revision_count.');
    trace.push('PENDING_REVIEW=>processed as correction/revision_count=1/state=PENDING_REVIEW');
    deleteStaging(pending.review_id, NRM_TEST_OWNER_A);

    const failed = createStaging({
      message_sid: 'SM3_TRACE_ERROR_ORIGINAL', owner_number: '+15550000904',
      state: 'ERROR', raw_body: 'Failed capture.',
      error_json: { code: 'TEST_ERROR' },
      draft_json: { contact: {}, interaction: _nrmStage3DummyDraft_('Failed capture.', []) }
    }, NRM_TEST_OWNER_A);
    const errorReply = handleNormalizedEvent({
      message_sid: 'SM3_TRACE_ERROR_NEW', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000904', body: 'Another capture.'
    });
    _nrmAssert_(errorReply.state === 'ERROR', 'ERROR rejection changed state.');
    _nrmAssert_(errorReply.message.indexOf('Reply CANCEL to clear it') !== -1, 'ERROR recovery guidance missing.');
    trace.push('ERROR=>rejected/state unchanged/reply=CANCEL then resend');

    const rejectionEvents = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      return entry.record.event_type === 'MESSAGE_REJECTED_OPEN_REVIEW';
    });
    _nrmAssert_(rejectionEvents.length === 3, 'Expected PROCESSING, DISAMBIGUATING, and ERROR rejection logs.');
    const rejectionDetails = rejectionEvents.map(function (entry) {
      return _nrmParseJsonObject_(entry.record.details, {});
    });
    _nrmAssert_(rejectionDetails.every(function (details) {
      return details.message_sid && details.existing_review_id && details.state;
    }), 'Rejection log is missing message_sid, existing_review_id, or state.');
    _nrmAssert_(JSON.stringify(rejectionDetails).indexOf('Second capture while processing.') === -1, 'Rejection log retained raw message body.');
    const acceptedPending = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      const details = _nrmParseJsonObject_(entry.record.details, {});
      return entry.record.event_type === 'MESSAGE_ACCEPTED' &&
        details.message_sid === 'SM3_TRACE_PENDING_NEW';
    });
    _nrmAssert_(acceptedPending.length === 1, 'Processed PENDING correction was not logged as accepted exactly once.');
    return 'PASS open-review per-state routing trace: ' + trace.join('; ') + '; three rejected messages logged with SID/review/state and no raw bodies.';
  });
}

function _nrmTestCancelAndCommandIsolation_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const ownerAContactsBefore = _nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_A).length;
    const ownerBContactsBefore = _nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_B).length;
    const ownerA = createStaging({
      message_sid: 'SM3_CANCEL_A_ORIGINAL', owner_number: '+15550000801',
      state: 'ERROR', raw_body: 'OWNER_A_PRIVATE_BODY',
      error_json: { code: 'TEST_ERROR' }
    }, NRM_TEST_OWNER_A);
    const ownerB = createStaging({
      message_sid: 'SM3_CANCEL_B_ORIGINAL', owner_number: '+15550000802',
      state: 'PENDING_REVIEW', raw_body: 'OWNER_B_PRIVATE_BODY',
      selected_contact_id: 'contact_b_work',
      draft_json: { contact: { display_name: 'Sarah Chen' }, interaction: _nrmStage3DummyDraft_('Owner B.', []) }
    }, NRM_TEST_OWNER_B);

    const cancelled = handleNormalizedEvent({
      message_sid: 'SM3_CANCEL_A_COMMAND', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000801', body: ' cancel '
    });
    _nrmAssert_(cancelled.state === 'CANCELLED', 'CANCEL did not confirm cancellation.');
    _nrmAssert_(findStagingByReviewId(ownerA.review_id, NRM_TEST_OWNER_A) === null, 'Owner A Staging row remained.');
    _nrmAssert_(findStagingByReviewId(ownerB.review_id, NRM_TEST_OWNER_B) !== null, 'Owner A CANCEL deleted Owner B Staging.');

    const crossOwnerCancel = handleNormalizedEvent({
      message_sid: 'SM3_CANCEL_CROSS_OWNER', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000801', review_id: ownerB.review_id, body: 'CANCEL'
    });
    _nrmAssert_(crossOwnerCancel.state === 'ERROR', 'Foreign review_id was not rejected.');
    _nrmAssert_(findStagingByReviewId(ownerB.review_id, NRM_TEST_OWNER_B) !== null, 'Cross-owner CANCEL deleted Owner B Staging.');

    const noOpenCancel = handleNormalizedEvent({
      message_sid: 'SM3_CANCEL_NO_OPEN', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000801', body: 'CANCEL'
    });
    _nrmAssert_(noOpenCancel.state === 'NO_OPEN_REVIEW', 'CANCEL without review started a capture.');
    const noOpenDate = handleNormalizedEvent({
      message_sid: 'SM3_NO_DATE_NO_OPEN', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000801', body: 'NO DATE'
    });
    _nrmAssert_(noOpenDate.state === 'NO_OPEN_REVIEW', 'NO DATE without review started a capture.');
    _nrmAssert_(_nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A).length === 0, 'Command without open review created Staging.');
    _nrmAssert_(_nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_A).length === ownerAContactsBefore, 'CANCEL changed Owner A Contacts.');
    _nrmAssert_(_nrmReadOwnedRows_('Contacts', NRM_TEST_OWNER_B).length === ownerBContactsBefore, 'CANCEL changed Owner B Contacts.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'CANCEL changed Owner A Interactions.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_B).length === 0, 'CANCEL changed Owner B Interactions.');

    const cancelledEvents = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
      return entry.record.event_type === 'CANCELLED';
    });
    _nrmAssert_(cancelledEvents.length === 1, 'CANCELLED event missing.');
    const cancelDetails = _nrmParseJsonObject_(cancelledEvents[0].record.details, {});
    _nrmAssert_(cancelDetails.message_sid === 'SM3_CANCEL_A_COMMAND', 'CANCELLED log has wrong MessageSid.');
    _nrmAssert_(cancelDetails.existing_review_id === ownerA.review_id && cancelDetails.state === 'ERROR', 'CANCELLED log lacks prior review/state.');
    const serializedEvents = JSON.stringify(_nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A));
    _nrmAssert_(serializedEvents.indexOf('OWNER_A_PRIVATE_BODY') === -1, 'CANCEL EventLog retained raw body.');
    return 'PASS CANCEL and command isolation: owner A deleted only its ERROR Staging row; owner B row and both owners\' Contacts/Interactions were untouched; CANCEL/NO DATE without an open review created no capture.';
  });
}

function _nrmTestProcessingLockContention_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const processing = createStaging({
      message_sid: 'SM3_LOCK_ORIGINAL', owner_number: '+15550000701',
      state: 'PROCESSING', raw_body: 'Original slow inference.',
      draft_json: { contact: {}, contact_query: '' }
    }, NRM_TEST_OWNER_A);
    const previousLock = NRM_TEST_STATE_LOCK_;
    let requestedWait = null;
    NRM_TEST_STATE_LOCK_ = {
      tryLock: function (waitMs) { requestedWait = waitMs; return false; },
      releaseLock: function () { throw new Error('Unacquired lock must not be released.'); }
    };
    try {
      const result = handleNormalizedEvent({
        message_sid: 'SM3_LOCK_SECOND', owner_id: NRM_TEST_OWNER_A,
        owner_number: '+15550000701', body: 'Second message during slow inference.'
      });
      _nrmAssert_(requestedWait === 1000, 'Lock contention did not use the one-second bound.');
      _nrmAssert_(result.state === 'PROCESSING', 'Lock contention lost the open PROCESSING state.');
      _nrmAssert_(result.message === 'Still working on your previous entry. Please resend this message in a minute.', 'Lock contention reply is wrong.');
      _nrmAssert_(findStagingByReviewId(processing.review_id, NRM_TEST_OWNER_A).state === 'PROCESSING', 'Lock contention changed Staging.');
      const rejected = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).filter(function (entry) {
        return entry.record.event_type === 'MESSAGE_REJECTED_OPEN_REVIEW';
      });
      _nrmAssert_(rejected.length === 1, 'Lock contention rejection was not logged.');
      return 'PASS PROCESSING lock contention reply: failed one-second lock acquisition returned the exact resend guidance, preserved PROCESSING Staging, and logged MESSAGE_REJECTED_OPEN_REVIEW.';
    } finally {
      NRM_TEST_STATE_LOCK_ = previousLock;
    }
  });
}

function _nrmTestEmptyContactBundleCommit_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const staging = createStaging({
      message_sid: 'SM3_EMPTY_CONTACT_CAPTURE',
      owner_number: '+15550000001',
      state: 'PENDING_REVIEW',
      raw_body: 'Met Taylor from Harbor Labs today.',
      selected_contact_id: '',
      candidate_contact_ids: [],
      draft_json: {
        contact: {},
        contact_query: 'Taylor',
        interaction: _nrmStage3DraftWithPerson_('Met Taylor from Harbor Labs today.', {
          name: 'Taylor Reed',
          organization: 'Harbor Labs',
          context_tag: 'Maritime',
          phone: null,
          email: null
        })
      }
    }, NRM_TEST_OWNER_A);
    const committed = handleNormalizedEvent({
      message_sid: 'SM3_EMPTY_CONTACT_APPROVE',
      owner_id: NRM_TEST_OWNER_A,
      review_id: staging.review_id,
      body: 'YES'
    });
    _nrmAssert_(committed.state === 'COMMITTED', 'Empty staged contact did not commit from AI person.');
    const contacts = searchContacts('Taylor Reed', NRM_TEST_OWNER_A);
    _nrmAssert_(contacts.length === 1, 'Recovered Contact was not created.');
    _nrmAssert_(contacts[0].display_name === 'Taylor Reed', 'Recovered display_name is wrong.');
    _nrmAssert_(contacts[0].organization === 'Harbor Labs', 'Recovered organization is wrong.');
    _nrmAssert_(contacts[0].context_tag === 'Maritime', 'Recovered context_tag is wrong.');
    const interactions = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A);
    _nrmAssert_(interactions.length === 1, 'Recovered Interaction was not created.');
    _nrmAssert_(interactions[0].record.contact_id === contacts[0].contact_id, 'Recovered Interaction link is wrong.');
    _nrmAssert_(findStagingByReviewId(staging.review_id, NRM_TEST_OWNER_A) === null, 'Recovered Staging row was not cleared.');
    return 'PASS empty staged contact recovery: approval reconstructed Contact from AI person before validation and committed the linked Interaction.';
  });
}

function _nrmTestOwnerMismatchCommit_() {
  return _nrmWithStage3Spreadsheet_(function () {
    const staging = createStaging({
      message_sid: 'SM3_FAULT_CAPTURE', owner_number: '+15550000001',
      state: 'PENDING_REVIEW', raw_body: 'Fault injection',
      selected_contact_id: '', candidate_contact_ids: [],
      draft_json: {
        contact: { display_name: 'Should Not Create' },
        interaction: _nrmStage3DummyDraft_('Fault injection', [])
      }
    }, NRM_TEST_OWNER_A);
    const target = _nrmReadOwnedRows_('Staging', NRM_TEST_OWNER_A).find(function (entry) {
      return entry.record.review_id === staging.review_id;
    });
    const corrupted = Object.assign({}, target.record, { selected_contact_id: 'contact_b_work' });
    _nrmWriteObjectAtRow_('Staging', target.rowNumber, corrupted);

    const before = _nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length;
    const rejected = handleNormalizedEvent({
      message_sid: 'SM3_FAULT_APPROVE', owner_id: NRM_TEST_OWNER_A,
      review_id: staging.review_id, body: 'YES'
    });
    _nrmAssert_(rejected.state === 'ERROR', 'Owner mismatch did not enter ERROR.');
    _nrmAssert_(rejected.message === 'Owner mismatch rejected.', 'Owner mismatch was not hard-rejected.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === before, 'Owner mismatch wrote an interaction.');
    const ownerALogs = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_A).map(function (entry) { return entry.record; });
    const ownerBLogs = _nrmReadOwnedRows_('EventLog', NRM_TEST_OWNER_B).map(function (entry) { return entry.record; });
    _nrmAssert_(ownerALogs.some(function (row) { return row.event_type === 'OWNER_MISMATCH' && row.status === 'FAILURE'; }), 'Critical OWNER_MISMATCH event missing.');
    _nrmAssert_(!ownerBLogs.some(function (row) { return row.event_type === 'OWNER_MISMATCH'; }), 'Owner mismatch log leaked to owner B.');
    const errorReply = handleNormalizedEvent({
      message_sid: 'SM3_FAULT_AFTER_ERROR', owner_id: NRM_TEST_OWNER_A,
      review_id: staging.review_id, body: 'YES'
    });
    _nrmAssert_(errorReply.state === 'ERROR', 'ERROR handler did not retain state.');
    return 'PASS OWNER_MISMATCH hard rejection: corrupt foreign contact_id wrote nothing, entered ERROR, and emitted owner-scoped critical failure log.';
  });
}

function _nrmTestLocalAiOwnerMismatch_() {
  return _nrmWithStage3Spreadsheet_(function () {
    NRM_TEST_LOCAL_AI_CLIENT_ = function (path, payload) {
      const response = _nrmStage3DummyClient_(path, payload);
      response.owner_id = NRM_TEST_OWNER_B;
      return response;
    };
    const result = handleNormalizedEvent({
      message_sid: 'SM3_AI_OWNER_FAULT', owner_id: NRM_TEST_OWNER_A,
      owner_number: '+15550000001', body: 'Met Sarah.',
      contact_query: 'Sarah Chen', contact: { display_name: 'Sarah Chen' }
    });
    _nrmAssert_(result.state === 'ERROR', 'Changed Local API owner_id was accepted.');
    _nrmAssert_(_nrmReadOwnedRows_('Interactions', NRM_TEST_OWNER_A).length === 0, 'AI owner mismatch wrote data.');
    return 'PASS Local API owner passthrough guard: changed owner_id hard-failed before candidate or interaction writes.';
  });
}

function _nrmTestReplyParsing_() {
  _nrmAssert_(parseCandidateNumber_('2', 3) === 1, 'Candidate 2 did not map to index 1.');
  _nrmAssert_(parseCandidateNumber_('0', 3) === null, 'Candidate 0 accepted.');
  _nrmAssert_(parseCandidateNumber_('2 please', 3) === null, 'Non-numeric candidate accepted.');
  _nrmAssert_(isYesApproval_(' YES ') && isYesApproval_('y'), 'YES approval parsing failed.');
  _nrmAssert_(!isYesApproval_('yes please') && !isYesApproval_('no'), 'Non-YES reply approved.');
  return 'PASS candidate and YES parsing: strict 1-based candidate numbers; only YES/Y approve.';
}

function _nrmTestStage3PersistenceOwnerGuards_() {
  [
    function () { createContact({}, ''); },
    function () { findStagingByReviewId('review', ''); },
    function () { findInteractionBySourceMessageSid('message', ''); }
  ].forEach(function (operation) {
    _nrmAssertThrows_(operation, 'owner_id');
  });
  return 'PASS Stage 3 persistence owner guards: createContact and both new lookup helpers reject missing owner_id.';
}

function _nrmWithStage3Spreadsheet_(callback) {
  return _nrmWithTemporaryTestSpreadsheet_(function () {
    const previousClient = NRM_TEST_LOCAL_AI_CLIENT_;
    try {
      setupNrmSheets();
      _nrmSeedStage1Fixtures_();
      NRM_TEST_LOCAL_AI_CLIENT_ = _nrmStage3DummyClient_;
      return callback();
    } finally {
      NRM_TEST_LOCAL_AI_CLIENT_ = previousClient;
    }
  });
}

function _nrmStage3DummyClient_(path, payload) {
  if (path === '/process-interaction') {
    return {
      owner_id: payload.owner_id,
      review_id: payload.review_id,
      schema_version: '1.0',
      draft: _nrmStage3DummyDraft_(payload.raw_body, payload.media_refs)
    };
  }
  if (path === '/revise-draft') {
    const revised = Object.assign({}, payload.draft, {
      summary: 'Stage 2 deterministic revised dummy interaction.',
      details_json: { mode: 'dummy', revision_applied: true },
      ai_model: 'stage2-dummy',
      schema_version: '1.0'
    });
    return {
      owner_id: payload.owner_id,
      review_id: payload.review_id,
      schema_version: '1.0',
      draft: revised
    };
  }
  throw new Error('Unexpected Local API path: ' + path);
}

function _nrmStage3DummyDraft_(rawBody, mediaRefs) {
  return {
    interaction_date: '2000-01-01',
    platform: 'OTHER',
    summary: 'Stage 2 deterministic dummy interaction.',
    details_json: { mode: 'dummy' },
    raw_body: rawBody,
    media_refs: mediaRefs || [],
    ai_model: 'stage2-dummy',
    schema_version: '1.0'
  };
}

function _nrmStage3DraftWithPerson_(rawBody, person) {
  const draft = _nrmStage3DummyDraft_(rawBody, []);
  draft.interaction_date = '2026-09-25';
  draft.platform = 'IN_PERSON';
  draft.summary = 'Discussed relationship follow-up.';
  draft.details_json = {
    person: person,
    identity: { confidence: 1, evidence: ['synthetic Stage 3 test'] },
    warnings: []
  };
  draft.ai_model = 'stage6-test-double';
  return draft;
}
