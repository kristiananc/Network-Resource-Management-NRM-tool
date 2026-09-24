#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const properties = {
  NRM_LOCAL_API_BASE_URL: 'https://nrm-api.example.com/',
  NRM_INTERNAL_API_TOKEN: 'fastapi-test-token',
  NRM_CF_ACCESS_CLIENT_ID: 'access-client-id',
  NRM_CF_ACCESS_CLIENT_SECRET: 'access-client-secret'
};

let capturedRequest = null;

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (name) => Object.prototype.hasOwnProperty.call(properties, name)
      ? properties[name]
      : null
  })
};

global.UrlFetchApp = {
  fetch: (url, options) => {
    capturedRequest = { url, options };
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        owner_id: 'own_access_test',
        review_id: 'review_access_test',
        schema_version: '1.0',
        draft: { schema_version: '1.0' }
      })
    };
  }
};

function loadAppsScript(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  vm.runInThisContext(fs.readFileSync(filePath, 'utf8'), { filename: filePath });
}

loadAppsScript('Config.gs');
loadAppsScript('LocalAI.gs');

processInteractionWithLocalAi_({
  owner_id: 'own_access_test',
  review_id: 'review_access_test',
  raw_body: 'Test request'
});

assert.strictEqual(
  capturedRequest.url,
  'https://nrm-api.example.com/process-interaction'
);
assert.strictEqual(
  capturedRequest.options.headers.Authorization,
  'Bearer fastapi-test-token'
);
assert.strictEqual(
  capturedRequest.options.headers['CF-Access-Client-Id'],
  'access-client-id'
);
assert.strictEqual(
  capturedRequest.options.headers['CF-Access-Client-Secret'],
  'access-client-secret'
);
console.log('PASS LocalAI request sends FastAPI bearer and Cloudflare Access service-token headers.');

delete properties.NRM_CF_ACCESS_CLIENT_ID;
assert.throws(
  () => getNrmLocalApiConfig_(),
  /MISSING_CONFIG: NRM_CF_ACCESS_CLIENT_ID/
);
console.log('PASS LocalAI configuration rejects a missing Cloudflare Access client ID.');

properties.NRM_CF_ACCESS_CLIENT_ID = 'access-client-id';
delete properties.NRM_CF_ACCESS_CLIENT_SECRET;
assert.throws(
  () => getNrmLocalApiConfig_(),
  /MISSING_CONFIG: NRM_CF_ACCESS_CLIENT_SECRET/
);
console.log('PASS LocalAI configuration rejects a missing Cloudflare Access client secret.');
