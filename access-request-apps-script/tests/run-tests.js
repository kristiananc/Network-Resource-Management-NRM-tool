'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

  setValue(value) {
    this.sheet.setValueAt(this.row, this.column, value);
    return this;
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

  setNumberFormat(format) {
    this.sheet.numberFormats.push({
      row: this.row,
      column: this.column,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
      format
    });
    return this;
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.frozenRows = 0;
    this.numberFormats = [];
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
    const columnCount = this.rows.reduce((maximum, row) => Math.max(maximum, row.length), 1);
    return new MockRange(this, 1, 1, Math.max(this.rows.length, 1), columnCount);
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
    this.rows[row - 1][column - 1] = value;
  }
}

class MockSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.sheets = new Map();
  }

  getId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  getUrl() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit`;
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
const spreadsheets = new Map();
const scriptProperties = new Map();
const openByIdCalls = [];

global.SpreadsheetApp = {
  create: (name) => {
    const spreadsheet = new MockSpreadsheet(`access-test-${++spreadsheetCounter}`, name);
    spreadsheets.set(spreadsheet.getId(), spreadsheet);
    return spreadsheet;
  },
  openById: (id) => {
    openByIdCalls.push(id);
    if (!spreadsheets.has(id)) throw new Error('SPREADSHEET_NOT_FOUND');
    return spreadsheets.get(id);
  }
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (name) => scriptProperties.has(name) ? scriptProperties.get(name) : null,
    setProperty: (name, value) => scriptProperties.set(name, String(value)),
    deleteProperty: (name) => scriptProperties.delete(name)
  })
};

global.LockService = {
  getScriptLock: () => ({
    tryLock: () => true,
    releaseLock: () => undefined
  })
};

global.Utilities = {
  getUuid: () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
  }
};

global.HtmlService = {
  XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
  createHtmlOutput: (content) => ({
    content,
    xFrameOptionsMode: null,
    setXFrameOptionsMode(mode) {
      this.xFrameOptionsMode = mode;
      return this;
    },
    getContent() {
      return this.content;
    }
  })
};

global.DriveApp = {
  getFileById: () => ({ setTrashed: () => true })
};

global.Logger = {
  log: (message) => console.log(message)
};

function load(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

load('Code.gs');
load('Tests.gs');

console.log('RUN runAccessRequestTests');
runAccessRequestTests();

console.log('RUN configured spreadsheet web-request test');
const configuredSpreadsheet = SpreadsheetApp.create('NRM Production');
scriptProperties.set('NRM_SPREADSHEET_ID', configuredSpreadsheet.getId());
NRM_ACCESS_REQUEST_TEST_SPREADSHEET_ = null;
NRM_ACCESS_REQUEST_TEST_NOW_ = new Date('2026-09-15T12:34:56.000Z');
const setupResult = setupNrmAccessRequestSheet();
if (setupResult.id !== configuredSpreadsheet.getId() || setupResult.sheet_exists !== true) {
  throw new Error('Production setup diagnostic did not identify and provision the configured spreadsheet.');
}
const configuredResponse = doPost(_nrmAccessRequestEvent_(
  'Production Path',
  '+19097719380',
  'yes',
  'submission-configured-path'
));
const configuredSheet = configuredSpreadsheet.getSheetByName('AccessRequests');
if (configuredResponse.getContent().indexOf('"ok":true') === -1) {
  throw new Error('Configured spreadsheet request did not return success.');
}
if (openByIdCalls[openByIdCalls.length - 1] !== configuredSpreadsheet.getId()) {
  throw new Error('Configured spreadsheet ID was not opened with SpreadsheetApp.openById().');
}
if (!configuredSheet || configuredSheet.getLastRow() !== 2) {
  throw new Error('Configured spreadsheet did not receive the AccessRequests header and row.');
}
console.log('PASS configured spreadsheet web request: setup identified the openById target, created AccessRequests, and the request appended one row.');
