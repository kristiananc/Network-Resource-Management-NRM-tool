/**
 * Owner-scoped Google Sheets persistence for NRM schema version 1.0.
 */

const NRM_SCHEMA_VERSION = '1.0';

const NRM_HEADERS = Object.freeze({
  Contacts: Object.freeze([
    'contact_id', 'owner_id', 'display_name', 'context_tag', 'phone', 'email',
    'organization', 'role_title', 'relationship_summary', 'last_contact',
    'last_platform', 'created_at', 'updated_at', 'status'
  ]),
  Interactions: Object.freeze([
    'interaction_id', 'contact_id', 'owner_id', 'interaction_date', 'platform',
    'summary', 'details_json', 'raw_body', 'media_refs', 'source_message_sid',
    'created_at', 'ai_model', 'schema_version'
  ]),
  Staging: Object.freeze([
    'review_id', 'message_sid', 'owner_number', 'owner_id', 'state', 'created_at',
    'updated_at', 'raw_body', 'media_json', 'candidate_contact_ids',
    'selected_contact_id', 'draft_json', 'revision_count', 'error_json'
  ]),
  EventLog: Object.freeze([
    'event_id', 'review_id', 'owner_id', 'timestamp', 'event_type', 'status',
    'details'
  ])
});

const NRM_WORKFLOW_STATES = Object.freeze([
  'PROCESSING', 'DISAMBIGUATING', 'PENDING_REVIEW', 'REVISING', 'ERROR'
]);
const NRM_CONTACT_STATUSES = Object.freeze(['ACTIVE', 'ARCHIVED', 'MERGED']);
const NRM_PLATFORMS = Object.freeze([
  'IN_PERSON', 'TEXT', 'CALL', 'EMAIL', 'LINKEDIN', 'INSTAGRAM', 'EVENT',
  'VIDEO_CALL', 'OTHER'
]);
const NRM_EVENT_STATUSES = Object.freeze(['SUCCESS', 'RETRY', 'FAILURE']);

// Tests may temporarily supply an isolated spreadsheet. Production leaves this null.
var NRM_TEST_SPREADSHEET_ = null;

/**
 * One-time production provisioning helper. It adopts the bound spreadsheet
 * when run from a bound editor, or creates "NRM Production" for a standalone
 * project. The resulting ID is persisted explicitly for web-app executions.
 */
function setupNrmProductionSpreadsheet() {
  const properties = PropertiesService.getScriptProperties();
  const configuredId = String(properties.getProperty(NRM_SPREADSHEET_ID_PROPERTY) || '').trim();
  let spreadsheet;
  let source;

  if (configuredId) {
    spreadsheet = SpreadsheetApp.openById(configuredId);
    source = 'existing Script Property';
  } else {
    const boundSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (boundSpreadsheet) {
      spreadsheet = boundSpreadsheet;
      source = 'bound spreadsheet';
    } else {
      spreadsheet = SpreadsheetApp.create('NRM Production');
      source = 'newly created spreadsheet';
    }
    properties.setProperty(NRM_SPREADSHEET_ID_PROPERTY, spreadsheet.getId());
  }

  setupNrmSheets();
  const output = {
    source: source,
    name: spreadsheet.getName(),
    id: spreadsheet.getId(),
    url: spreadsheet.getUrl(),
    script_property: NRM_SPREADSHEET_ID_PROPERTY
  };
  Logger.log('NRM production spreadsheet source: ' + output.source);
  Logger.log('NAME: ' + output.name);
  Logger.log('ID: ' + output.id);
  Logger.log('URL: ' + output.url);
  Logger.log('SCRIPT PROPERTY: ' + output.script_property + '=' + output.id);
  return output;
}

function setupNrmSheets() {
  const spreadsheet = _nrmGetSpreadsheet_();
  Object.keys(NRM_HEADERS).forEach(function (sheetName) {
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
    }

    const headers = NRM_HEADERS[sheetName];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers.slice()]);
    } else {
      if (sheet.getLastColumn() !== headers.length) {
        throw new Error('SCHEMA_MISMATCH: ' + sheetName + ' header count does not match schema v1.0.');
      }
      const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (!_nrmArraysEqual_(existing, headers)) {
        throw new Error('SCHEMA_MISMATCH: ' + sheetName + ' headers do not match schema v1.0.');
      }
    }
    sheet.setFrozenRows(1);
  });

  return Object.keys(NRM_HEADERS);
}

function findContactById(contact_id, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const contactId = _nrmRequireString_(contact_id, 'contact_id');
  const ownerRows = _nrmReadOwnedRows_('Contacts', ownerId);
  const match = ownerRows.find(function (entry) {
    return entry.record.contact_id === contactId;
  });
  return match ? match.record : null;
}

function searchContacts(query, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const normalizedQuery = String(query || '').trim().toLowerCase();

  // Tenant filtering happens before any matching or candidate-generation logic.
  const ownerRows = _nrmReadOwnedRows_('Contacts', ownerId);
  if (!normalizedQuery) {
    return ownerRows.map(function (entry) { return entry.record; });
  }

  const searchableFields = [
    'display_name', 'context_tag', 'phone', 'email', 'organization', 'role_title'
  ];
  return ownerRows.filter(function (entry) {
    return searchableFields.some(function (field) {
      return String(entry.record[field] || '').toLowerCase().indexOf(normalizedQuery) !== -1;
    });
  }).map(function (entry) {
    return entry.record;
  });
}

function createContact(contactData, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const data = _nrmOwnedCopy_(contactData, ownerId, 'Contact');
  _nrmRequireFields_(data, ['display_name'], 'Contact');

  const now = currentDateTimeUtc();
  data.contact_id = data.contact_id || generateUuid();
  if (findContactById(data.contact_id, ownerId)) {
    throw new Error('DUPLICATE_CONTACT_ID: contact_id already exists for owner_id.');
  }
  data.created_at = data.created_at ? normalizeDateTime(data.created_at) : now;
  data.updated_at = data.updated_at ? normalizeDateTime(data.updated_at) : now;
  data.status = data.status || 'ACTIVE';
  _nrmRequireEnum_(data.status, NRM_CONTACT_STATUSES, 'status');
  if (data.last_contact) {
    data.last_contact = normalizeDate(data.last_contact);
  }
  if (data.last_platform) {
    _nrmRequireEnum_(data.last_platform, NRM_PLATFORMS, 'last_platform');
  }

  return _nrmAppendObject_('Contacts', data);
}

function appendInteraction(interactionData, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const data = _nrmOwnedCopy_(interactionData, ownerId, 'Interaction');
  _nrmRequireFields_(data, ['contact_id', 'interaction_date', 'platform', 'summary'], 'Interaction');

  if (!findContactById(data.contact_id, ownerId)) {
    throw new Error('OWNER_MISMATCH: contact_id does not belong to owner_id.');
  }
  _nrmRequireEnum_(data.platform, NRM_PLATFORMS, 'platform');

  data.interaction_id = data.interaction_id || generateUuid();
  data.interaction_date = normalizeDate(data.interaction_date);
  data.created_at = data.created_at ? normalizeDateTime(data.created_at) : currentDateTimeUtc();
  data.schema_version = data.schema_version || NRM_SCHEMA_VERSION;
  if (data.schema_version !== NRM_SCHEMA_VERSION) {
    throw new Error('SCHEMA_VERSION_MISMATCH: expected ' + NRM_SCHEMA_VERSION + '.');
  }

  return _nrmAppendObject_('Interactions', data);
}

function createStaging(stagingData, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const data = _nrmOwnedCopy_(stagingData, ownerId, 'Staging');
  _nrmRequireFields_(data, ['message_sid', 'owner_number', 'state'], 'Staging');
  _nrmRequireEnum_(data.state, NRM_WORKFLOW_STATES, 'state');

  const duplicate = _nrmReadOwnedRows_('Staging', ownerId).some(function (entry) {
    return entry.record.message_sid === data.message_sid;
  });
  if (duplicate) {
    throw new Error('DUPLICATE_MESSAGE_SID: staging already exists for this owner.');
  }

  const now = currentDateTimeUtc();
  data.review_id = data.review_id || generateUuid();
  data.created_at = data.created_at ? normalizeDateTime(data.created_at) : now;
  data.updated_at = data.updated_at ? normalizeDateTime(data.updated_at) : now;
  data.revision_count = data.revision_count === undefined ? 0 : data.revision_count;
  _nrmValidateStagingContactIds_(data, ownerId);

  return _nrmAppendObject_('Staging', data);
}

function findStagingByReviewId(review_id, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const reviewId = _nrmRequireString_(review_id, 'review_id');
  const match = _nrmReadOwnedRows_('Staging', ownerId).find(function (entry) {
    return entry.record.review_id === reviewId;
  });
  return match ? match.record : null;
}

function findInteractionBySourceMessageSid(message_sid, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const messageSid = _nrmRequireString_(message_sid, 'message_sid');
  const match = _nrmReadOwnedRows_('Interactions', ownerId).find(function (entry) {
    return entry.record.source_message_sid === messageSid;
  });
  return match ? match.record : null;
}

function updateStaging(review_id, updates, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const reviewId = _nrmRequireString_(review_id, 'review_id');
  const ownerRows = _nrmReadOwnedRows_('Staging', ownerId);
  const target = ownerRows.find(function (entry) {
    return entry.record.review_id === reviewId;
  });
  if (!target) {
    return null;
  }

  const changes = _nrmOwnedCopy_(updates, ownerId, 'Staging update');
  const immutable = ['review_id', 'message_sid', 'owner_number', 'owner_id', 'created_at'];
  immutable.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(changes, field) && changes[field] !== target.record[field]) {
      throw new Error('IMMUTABLE_FIELD: ' + field);
    }
  });
  if (changes.state !== undefined) {
    _nrmRequireEnum_(changes.state, NRM_WORKFLOW_STATES, 'state');
  }

  const updated = Object.assign({}, target.record, changes, {
    owner_id: ownerId,
    updated_at: currentDateTimeUtc()
  });
  _nrmValidateStagingContactIds_(updated, ownerId);
  _nrmWriteObjectAtRow_('Staging', target.rowNumber, updated);
  return updated;
}

function deleteStaging(review_id, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const reviewId = _nrmRequireString_(review_id, 'review_id');
  const target = _nrmReadOwnedRows_('Staging', ownerId).find(function (entry) {
    return entry.record.review_id === reviewId;
  });
  if (!target) {
    return false;
  }
  _nrmGetSheet_('Staging').deleteRow(target.rowNumber);
  return true;
}

function logEvent(eventData, owner_id) {
  const ownerId = _nrmRequireOwnerId_(owner_id);
  const data = _nrmOwnedCopy_(eventData, ownerId, 'EventLog');
  _nrmRequireFields_(data, ['event_type', 'status'], 'EventLog');
  _nrmRequireEnum_(data.status, NRM_EVENT_STATUSES, 'status');

  data.event_id = data.event_id || generateUuid();
  data.timestamp = data.timestamp ? normalizeDateTime(data.timestamp) : currentDateTimeUtc();
  return _nrmAppendObject_('EventLog', data);
}

function _nrmGetSpreadsheet_() {
  if (NRM_TEST_SPREADSHEET_ !== null) {
    return NRM_TEST_SPREADSHEET_;
  }
  const spreadsheetId = String(
    PropertiesService.getScriptProperties().getProperty(NRM_SPREADSHEET_ID_PROPERTY) || ''
  ).trim();
  if (!spreadsheetId) {
    throw new Error('MISSING_CONFIG: ' + NRM_SPREADSHEET_ID_PROPERTY);
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function _nrmGetSheet_(sheetName) {
  const sheet = _nrmGetSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('MISSING_SHEET: run setupNrmSheets() first (' + sheetName + ').');
  }
  return sheet;
}

function _nrmReadOwnedRows_(sheetName, ownerId) {
  const headers = NRM_HEADERS[sheetName];
  const values = _nrmGetSheet_(sheetName).getDataRange().getValues();
  if (values.length <= 1) {
    return [];
  }
  const ownerIndex = headers.indexOf('owner_id');
  const ownedRows = [];
  for (let index = 1; index < values.length; index += 1) {
    if (String(values[index][ownerIndex] || '') === ownerId) {
      ownedRows.push({
        rowNumber: index + 1,
        record: _nrmObjectFromRow_(headers, values[index])
      });
    }
  }
  return ownedRows;
}

function _nrmAppendObject_(sheetName, data) {
  const headers = NRM_HEADERS[sheetName];
  const row = headers.map(function (header) {
    return _nrmCellValue_(data[header]);
  });
  _nrmGetSheet_(sheetName).appendRow(row);
  return _nrmObjectFromRow_(headers, row);
}

function _nrmWriteObjectAtRow_(sheetName, rowNumber, data) {
  const headers = NRM_HEADERS[sheetName];
  const row = headers.map(function (header) {
    return _nrmCellValue_(data[header]);
  });
  _nrmGetSheet_(sheetName).getRange(rowNumber, 1, 1, headers.length).setValues([row]);
}

function _nrmObjectFromRow_(headers, row) {
  return headers.reduce(function (record, header, index) {
    record[header] = row[index] === undefined ? '' : row[index];
    return record;
  }, {});
}

function _nrmCellValue_(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]') {
    return JSON.stringify(value);
  }
  return value;
}

function _nrmOwnedCopy_(input, ownerId, label) {
  if (!input || Object.prototype.toString.call(input) !== '[object Object]') {
    throw new Error(label + ' data must be an object.');
  }
  if (input.owner_id !== undefined && input.owner_id !== ownerId) {
    throw new Error('OWNER_MISMATCH: ' + label + ' owner_id conflicts with required owner_id.');
  }
  return Object.assign({}, input, { owner_id: ownerId });
}

function _nrmValidateStagingContactIds_(data, ownerId) {
  if (data.selected_contact_id) {
    if (!findContactById(String(data.selected_contact_id), ownerId)) {
      throw new Error('OWNER_MISMATCH: selected_contact_id does not belong to owner_id.');
    }
  }

  const candidateIds = _nrmParseContactIdList_(data.candidate_contact_ids);
  candidateIds.forEach(function (contactId) {
    if (!findContactById(contactId, ownerId)) {
      throw new Error('OWNER_MISMATCH: candidate_contact_ids contains a contact outside owner_id.');
    }
  });
}

function _nrmParseContactIdList_(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error('INVALID_CONTACT_IDS: candidate_contact_ids must be a JSON array.');
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error('INVALID_CONTACT_IDS: candidate_contact_ids must be an array.');
  }
  return parsed.map(function (contactId) {
    return _nrmRequireString_(contactId, 'candidate_contact_id');
  });
}

function _nrmRequireOwnerId_(ownerId) {
  const passthrough = String(ownerId === undefined || ownerId === null ? '' : ownerId);
  if (!passthrough.trim()) {
    throw new Error('MISSING_REQUIRED_FIELD: owner_id');
  }
  return passthrough;
}

function _nrmRequireString_(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('MISSING_REQUIRED_FIELD: ' + fieldName);
  }
  return normalized;
}

function _nrmRequireFields_(data, fields, label) {
  fields.forEach(function (field) {
    if (data[field] === undefined || data[field] === null || String(data[field]).trim() === '') {
      throw new Error('MISSING_REQUIRED_FIELD: ' + label + '.' + field);
    }
  });
}

function _nrmRequireEnum_(value, allowed, fieldName) {
  if (allowed.indexOf(value) === -1) {
    throw new Error('INVALID_ENUM: ' + fieldName + '=' + value);
  }
}

function _nrmArraysEqual_(left, right) {
  return left.length === right.length && left.every(function (value, index) {
    return value === right[index];
  });
}
