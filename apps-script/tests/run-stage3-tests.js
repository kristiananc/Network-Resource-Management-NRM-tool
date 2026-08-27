'use strict';

const { loadAppsScript } = require('./run-stage1-tests');

loadAppsScript('Config.gs');
loadAppsScript('LocalAI.gs');
loadAppsScript('StateMachine.gs');
loadAppsScript('Code.gs');
loadAppsScript('StateMachineTests.gs');

console.log('RUN Stage 1 regression suite');
runStage1Tests();
console.log('RUN Stage 3 state-machine suite');
runStage3Tests();
console.log('RUN Stage 3 standalone cross-owner loop');
runStage3CrossOwnerLoopTest();
if (process.env.NRM_STAGE3_LIVE_FASTAPI === '1') {
  console.log('RUN Stage 3 real FastAPI integration');
  runStage3FastApiIntegrationTest();
}
