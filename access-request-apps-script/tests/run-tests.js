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
const spreadsheets = new Map();

global.SpreadsheetApp = {
  create: () => {
    const spreadsheet = new MockSpreadsheet(`access-test-${++spreadsheetCounter}`);
    spreadsheets.set(spreadsheet.getId(), spreadsheet);
    return spreadsheet;
  },
  openById: (id) => {
    if (!spreadsheets.has(id)) throw new Error('SPREADSHEET_NOT_FOUND');
    return spreadsheets.get(id);
  }
};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: () => null
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
