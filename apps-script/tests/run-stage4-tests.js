'use strict';

const { loadAppsScript } = require('./run-stage1-tests');

loadAppsScript('Config.gs');
loadAppsScript('LocalAI.gs');
loadAppsScript('StateMachine.gs');
loadAppsScript('Code.gs');
loadAppsScript('Twilio.gs');
loadAppsScript('StateMachineTests.gs');
loadAppsScript('TwilioTests.gs');

console.log('RUN Stage 1 regression suite');
runStage1Tests();
console.log('RUN Stage 3 regression suite');
runStage3Tests();
console.log('RUN Stage 5 Apps Script gateway regression suite');
runStage4Tests();
