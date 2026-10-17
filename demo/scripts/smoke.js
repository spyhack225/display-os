import { smoke } from './http-check.js';

try {
  const count = await smoke();
  console.log('PASS: ' + count + ' real HTTP checks on a disposable loopback server.');
  console.log('Claim, separate approval, rejects, cross-device isolation, publish, download, explicit synthetic ACK, replay, expiration, and revoke verified.');
  console.log('The smoke client simulates ACK. It does not prove browser painting or tablet compatibility.');
} catch (error) {
  console.error('FAIL: ' + error.message);
  process.exitCode = 1;
}
