// Google Apps Script example for your Contact Tracker + SMS input with Twilio
// This is designed for Google Sheets and optional SMS integration (Twilio)

// --- CONFIGURATION ---
const SHEET_NAME = 'Dataset'; // Name of your Sheet tab

function doPost(e) {
  if (!e || !e.parameter || !e.parameter.Body) {
    return ContentService
      .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error: No post data received</Message></Response>')
      .setMimeType(ContentService.MimeType.XML);
  }

  const params = e.parameter.Body;
  const parsed = parseIncomingSMS(params);

  let resultMessage = '';

  if (parsed.action === 'new') {
    resultMessage = addOrUpdateContact(parsed.name, parsed.phoneNumber, parsed.date);
  } else if (parsed.action === 'update') {
    resultMessage = addOrUpdateContact(parsed.name, '', parsed.date);
  }

  return ContentService
    .createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + resultMessage + '</Message></Response>')
    .setMimeType(ContentService.MimeType.XML);
}

function parseIncomingSMS(text) {
  text = text.toLowerCase();

  if (text.includes('new:')) {
    const parts = text.split('new:')[1].trim().split(',');
    return {
      action: 'new',
      name: parts[0].trim(),
      phoneNumber: parts[1].trim(),
      date: parts[2].trim()
    };
  } else if (text.includes('update:')) {
    const parts = text.split('update:')[1].trim().split(',');
    return {
      action: 'update',
      name: parts[0].trim(),
      date: parts[1].trim()
    };
  } else {
    throw new Error('Invalid message format.');
  }
}

function addOrUpdateContact(name, phoneNumber, dateStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return 'Error: Sheet not found.';
  }

  const data = sheet.getDataRange().getValues();
  const dateInput = parseDateSafely(dateStr);
  if (!dateInput) {
    return 'Error: Invalid date format. Please use YYYY-MM-DD.';
  }

  let found = false;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString().toLowerCase() === name.toLowerCase()) {
      sheet.getRange(i + 1, 3).setValue(dateInput);
      sheet.getRange(i + 1, 3).setNumberFormat('yyyy-mm-dd');
      found = true;
      break;
    }
  }

  if (!found) {
    sheet.appendRow([name, phoneNumber, dateInput, '=TODAY()-C' + (data.length + 1)]);
    sheet.getRange(sheet.getLastRow(), 3).setNumberFormat('yyyy-mm-dd');
  }

  refreshPivotTables();

  return found ? `Updated ${name}'s connection date.` : `Added new contact: ${name}.`;
}

function parseDateSafely(dateStr) {
  const parts = dateStr.trim().split('-');
  if (parts.length !== 3) return null;

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
  const day = parseInt(parts[2], 10);

  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  return new Date(year, month, day);
}

function refreshPivotTables() {
  // Pivot Table refresh is disabled because Apps Script does not fully support it reliably.
  // Please manually refresh pivots inside Google Sheets if needed.
}

function findPersonToReconnect() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();

  let maxDays = -1;
  let person = '';

  for (let i = 1; i < data.length; i++) {
    const daysSince = data[i][3];
    if (daysSince > maxDays) {
      maxDays = daysSince;
      person = data[i][0];
    }
  }

  return { name: person, days: maxDays };
}

function dailyReconnectReminder() {
  const personInfo = findPersonToReconnect();
  const email = Session.getActiveUser().getEmail();
  const subject = 'Reminder: Reconnect with ' + personInfo.name;
  const message = `It has been ${personInfo.days} days since you last connected with ${personInfo.name}. Time to reach out!`;

  MailApp.sendEmail(email, subject, message);
}

// --- HOW TWILIO WORKS ---
// 1. Set up a Twilio phone number.
// 2. In Twilio Console -> Manage Numbers -> your number -> Messaging Settings:
//    - Set "A message comes in" webhook to your Google Apps Script Web App URL
//    - Method: POST
// 3. Incoming SMS gets parsed and added/updated in your Google Sheet!
// 4. Twilio receives the returned message and texts it back to you.
