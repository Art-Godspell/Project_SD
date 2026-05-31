/**
 * test_client.js — Integration test client for falconDB
 * 
 * Tests the full CRUD cycle through the RP, including:
 *   - Create a key
 *   - Read the key
 *   - Update with --delete-- semantics
 *   - Read again to verify update
 *   - Delete the key
 *   - Verify deletion
 * 
 * Usage: node app/src/test/test_client.js [rp_host] [rp_port]
 */

'use strict';

const axios = require('axios');

const RP_HOST = process.argv[2] || '127.0.0.1';
const RP_PORT = process.argv[3] || 3000;
const BASE_URL = `http://${RP_HOST}:${RP_PORT}`;

const TEST_KEY = 'test_user_001';
const TEST_VALUE = {
  name: 'Alice',
  age: 30,
  city: 'New York',
  email: 'alice@example.com'
};

// ── Helper ──────────────────────────────────────────────────────────

function log(label, data) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(60));
  console.log(JSON.stringify(data, null, 2));
}

function logPass(test) {
  console.log(`  ✅ PASS: ${test}`);
}

function logFail(test, reason) {
  console.log(`  ❌ FAIL: ${test} — ${reason}`);
}

// ── Tests ───────────────────────────────────────────────────────────

async function run() {
  console.log(`\nfalconDB Integration Test`);
  console.log(`RP: ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;

  // 1. Check RP status
  try {
    const resp = await axios.get(`${BASE_URL}/status`);
    log('1. GET /status', resp.data);
    if (resp.data.error === 0) { logPass('RP status'); passed++; }
    else { logFail('RP status', 'unexpected error'); failed++; }
  } catch (err) {
    logFail('RP status', err.message);
    console.error('RP is not reachable. Is the system running?');
    process.exit(1);
  }

  // 2. Create
  try {
    const resp = await axios.post(`${BASE_URL}/db/c`, { key: TEST_KEY, value: TEST_VALUE });
    log('2. POST /db/c (Create)', resp.data);
    if (resp.data.error === 0) { logPass('Create'); passed++; }
    else { logFail('Create', JSON.stringify(resp.data.error)); failed++; }
  } catch (err) {
    const data = err.response?.data;
    log('2. POST /db/c (Create) — ERROR', data || err.message);
    logFail('Create', data?.error?.message || err.message);
    failed++;
  }

  // 3. Read
  try {
    const resp = await axios.get(`${BASE_URL}/db/r`, { params: { key: TEST_KEY } });
    log('3. GET /db/r (Read)', resp.data);
    if (resp.data.error === 0 && resp.data.data.value.name === 'Alice') {
      logPass('Read');
      passed++;
    } else {
      logFail('Read', 'data mismatch');
      failed++;
    }
  } catch (err) {
    logFail('Read', err.response?.data?.error?.message || err.message);
    failed++;
  }

  // 4. Update with --delete-- semantics
  const updateValue = {
    age: '--delete--',                    // Should remove 'age' member
    country: 'US',                        // Should add new member
    tag: '\\-\\-delete\\-\\-'            // Should set to literal "--delete--"
  };

  try {
    const resp = await axios.post(`${BASE_URL}/db/u`, { key: TEST_KEY, value: updateValue });
    log('4. POST /db/u (Update with --delete--)', resp.data);
    if (resp.data.error === 0) { logPass('Update'); passed++; }
    else { logFail('Update', JSON.stringify(resp.data.error)); failed++; }
  } catch (err) {
    logFail('Update', err.response?.data?.error?.message || err.message);
    failed++;
  }

  // 5. Read again to verify update semantics
  try {
    const resp = await axios.get(`${BASE_URL}/db/r`, { params: { key: TEST_KEY } });
    log('5. GET /db/r (Read after update)', resp.data);

    const val = resp.data.data.value;
    let updateOk = true;

    if (val.age !== undefined) {
      logFail('Update verification', '"age" should have been deleted');
      updateOk = false;
    }
    if (val.country !== 'US') {
      logFail('Update verification', '"country" should be "US"');
      updateOk = false;
    }
    if (val.tag !== '--delete--') {
      logFail('Update verification', '"tag" should be literal "--delete--"');
      updateOk = false;
    }
    if (val.name !== 'Alice') {
      logFail('Update verification', '"name" should still be "Alice"');
      updateOk = false;
    }

    if (updateOk) { logPass('Update --delete-- semantics'); passed++; }
    else { failed++; }
  } catch (err) {
    logFail('Update verification', err.response?.data?.error?.message || err.message);
    failed++;
  }

  // 6. Delete
  try {
    const resp = await axios.get(`${BASE_URL}/db/d`, { params: { key: TEST_KEY } });
    log('6. GET /db/d (Delete)', resp.data);
    if (resp.data.error === 0) { logPass('Delete'); passed++; }
    else { logFail('Delete', JSON.stringify(resp.data.error)); failed++; }
  } catch (err) {
    logFail('Delete', err.response?.data?.error?.message || err.message);
    failed++;
  }

  // 7. Verify deletion — read should fail
  try {
    const resp = await axios.get(`${BASE_URL}/db/r`, { params: { key: TEST_KEY } });
    log('7. GET /db/r (Read after delete — should fail)', resp.data);
    if (resp.data.error !== 0) { logPass('Delete verification'); passed++; }
    else { logFail('Delete verification', 'key should not exist'); failed++; }
  } catch (err) {
    if (err.response?.status === 404) {
      logPass('Delete verification (404)');
      passed++;
    } else {
      logFail('Delete verification', err.message);
      failed++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
