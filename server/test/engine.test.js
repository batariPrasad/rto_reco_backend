import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normAwb, isAwbLike, ignoredPrefix, podLookup, sameShipment, reconcile, parseScanTokens, validatePod } from '../../shared/engine.js';

test('isAwbLike accepts real AWBs and rejects junk', () => {
  for (const a of ['FMPC6539003539', 'SF4118903092GOM', '515261298276', 'FMPP4305797960']) assert.ok(isAwbLike(a), a);
  for (const a of ['FMPC6x7p', 'ABCDEFGH', '12345', '']) assert.ok(!isAwbLike(a), a);
});

test('ignoredPrefix skips order ids only', () => {
  assert.equal(ignoredPrefix('OD338738305771', 'OD'), 'OD');
  assert.equal(ignoredPrefix('FMPC6539003539', 'OD'), undefined);
  assert.equal(ignoredPrefix('OD123', ['OD']), undefined);          // too short to be an order id
});

test('sameShipment: extra characters, never two different AWBs', () => {
  assert.ok(sameShipment('SF4118903092', 'SF4118903092GOM'));
  assert.ok(!sameShipment('FMPC6539003539', 'FMPC6539003540'));
  assert.ok(sameShipment('4118903092123450', '4118903092123456'.slice(0, 15) + '0'));
});

test('podLookup: on / near / off / no pod', () => {
  const pod = [{ awb: 'FMPC6539003539' }, { awb: '3539', partial: true }];
  assert.equal(podLookup([], 'X'), null);
  assert.equal(podLookup(pod, 'FMPC6539003539'), 'on');
  assert.equal(podLookup(pod, 'FMPC6539003538'), 'near');
  assert.equal(podLookup([{ awb: 'FMPC6539003539' }], 'ZZZZ9999999999'), 'off');
});

test('reconcile statuses', () => {
  const pod = [
    { awb: 'FMPC6539003539', mark: '' }, { awb: 'SF4118903092GOM', mark: 'D' }, { awb: '515257037933', mark: '' },
    { awb: '515261298276', mark: 'X' }, { awb: '515261298276', mark: '' }
  ];
  const r = reconcile(pod, ['FMPC6539003539', 'SF4118903092GOM', '515261298276', '999999999999']);
  const st = r.rows.map(x => x.status);
  assert.deepEqual(st, ['matched', 'damaged', 'pod_not_scanned', 'conflict', 'pod_duplicate']);
  assert.deepEqual(r.extras.map(x => x.awb), ['999999999999']);
});

test('parseScanTokens and normAwb', () => {
  assert.equal(normAwb(' fmpc-6539 003539 '), 'FMPC6539003539');
  assert.deepEqual(parseScanTokens(['FMPC6539003539, SF4118903092GOM', 4.118903092123e15, 'DELHIVERY-KWIKSHIP']), ['FMPC6539003539', 'SF4118903092GOM', '4118903092123000']);
});

test('validatePod flags missing serials and wrong counts', () => {
  const pod = [{ page: 1, section: 'A', sectionKey: 'S1', serial: 1, awb: 'FMPC6539003539' }, { page: 1, section: 'A', sectionKey: 'S1', serial: 3, awb: 'FMPC6539003540' }];
  const m = validatePod(pod, [{ key: 'S1', declared: 3 }]);
  assert.ok(m.some(x => /POD says 3 pkgs but 2 rows/.test(x.text)));
  assert.ok(m.some(x => /serial numbers missing: 2/.test(x.text)));
});
