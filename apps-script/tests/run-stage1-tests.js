'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

class MockRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    const values = [];
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const row = [];
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        row.push(this.sheet.valueAt(this.row + rowOffset, this.column + columnOffset));
      }
      values.push(row);
    }
    return values;
  }

  setValues(values) {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.setValueAt(
          this.row + rowOffset,
          this.column + columnOffset,
          values[rowOffset][columnOffset]
        );
      }
    }
    return this;
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.frozenRows = 0;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MockRange(this, row, column, rowCount, columnCount);
  }

  getDataRange() {
    const columns = this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 1);
    return new MockRange(this, 1, 1, Math.max(this.rows.length, 1), columns);
  }

  appendRow(row) {
    this.rows.push(row.map(coerceLikeGoogleSheet));
  }

  deleteRow(rowNumber) {
    this.rows.splice(rowNumber - 1, 1);
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }

  valueAt(row, column) {
    return this.rows[row - 1] && this.rows[row - 1][column - 1] !== undefined
      ? this.rows[row - 1][column - 1]
      : '';
  }

  setValueAt(row, column, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push('');
    this.rows[row - 1][column - 1] = coerceLikeGoogleSheet(value);
  }
}

function coerceLikeGoogleSheet(value) {
  // Google Sheets can persist an unformatted E.164-looking cell as a number,
  // dropping the leading plus. Model that boundary instead of retaining every
  // JavaScript string verbatim as the previous permissive shim did.
  if (typeof value === 'string' && /^\+\d+$/.test(value)) {
    return Number(value.slice(1));
  }
  return value;
}

class MockSpreadsheet {
  constructor(id) {
    this.id = id;
    this.sheets = new Map();
  }

  getId() {
    return this.id;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

let spreadsheetCounter = 0;
let uuidCounter = 0;
const activeSpreadsheet = new MockSpreadsheet('active');

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => activeSpreadsheet,
  create: () => new MockSpreadsheet(`test-${++spreadsheetCounter}`)
};

global.DriveApp = {
  getFileById: () => ({ setTrashed: () => true })
};

global.Utilities = {
  getUuid: () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
  }
};

global.Logger = {
  log: (message) => console.log(message)
};

global.ContentService = {
  MimeType: { XML: 'application/xml' },
  createTextOutput: (content) => ({
    content,
    mimeType: 'text/plain',
    setMimeType(mimeType) {
      this.mimeType = mimeType;
      return this;
    },
    getContent() {
      return this.content;
    }
  })
};

global.LockService = {
  getScriptLock: () => ({
    tryLock: () => true,
    releaseLock: () => undefined
  })
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (name) => process.env[name] || null
  })
};

global.UrlFetchApp = {
  fetch: (url, options) => {
    const args = ['-sS', '-X', String(options.method || 'get').toUpperCase()];
    if (options.contentType) args.push('-H', `Content-Type: ${options.contentType}`);
    Object.entries(options.headers || {}).forEach(([name, value]) => {
      args.push('-H', `${name}: ${value}`);
    });
    if (options.payload !== undefined) args.push('--data', options.payload);
    args.push('-w', '\n%{http_code}', url);
    const output = execFileSync('curl', args, { encoding: 'utf8' });
    const lines = output.split('\n');
    const statusCode = Number(lines.pop());
    const responseText = lines.join('\n');
    return {
      getResponseCode: () => statusCode,
      getContentText: () => responseText
    };
  }
};

function loadAppsScript(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

loadAppsScript('Utils.gs');
loadAppsScript('Sheets.gs');
loadAppsScript('Tests.gs');

if (require.main === module) {
  console.log('RUN runStage1Tests');
  runStage1Tests();
  console.log('RUN runCrossOwnerIsolationTest');
  runCrossOwnerIsolationTest();
}

module.exports = { loadAppsScript };
