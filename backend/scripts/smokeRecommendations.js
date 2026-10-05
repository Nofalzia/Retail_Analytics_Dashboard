/**
 * scripts/smokeRecommendations.js
 * ──────────────────────────────────────────────────────────────────────────────
 * End-to-end smoke test for the rule-based recommendations engine.
 *
 * Prerequisites:
 *   * The backend is running (npm run dev / npm start).
 *   * The demo tenant is seeded (node src/seed.js).
 *   * Migration 003 has been applied to the database.
 *
 * Run from backend/:  npm run smoke:recs
 *
 * Flow:
 *   1. Log in as manager@demo.com.
 *   2. POST /api/alerts/run-detection to (re)create alerts.
 *   3. GET /api/recommendations and print a compact table.
 *   4. PATCH the first recommendation complete.
 *   5. Re-GET and assert the completed one disappeared.
 * Exits 1 on any failed assertion.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const API_URL  = process.env.API_URL || 'http://localhost:3001';
const EMAIL    = 'manager@demo.com';
const PASSWORD = 'Demo@1234';
const TENANT   = 'demo-kiryana';
const STORE_ID = '00000000-0000-0000-0000-000000000010';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // 1. Log in
  const loginRes = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantSlug: TENANT }),
  });
  assert(loginRes.ok, `login returned ${loginRes.status}`);
  const { token } = await loginRes.json();
  assert(token, 'login did not return a token');
  console.log(`✔ Logged in as ${EMAIL}`);

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // 2. Run detection
  const detRes = await fetch(`${API_URL}/api/alerts/run-detection?storeId=${STORE_ID}`, {
    method: 'POST',
    headers: authHeaders,
  });
  assert(detRes.ok, `run-detection returned ${detRes.status}`);
  const det = await detRes.json();
  console.log(
    `✔ Detection complete — ${det.runSummary?.alertsCreated?.total ?? 0} alerts, ` +
    `${det.recommendationsCreated ?? 0} recommendations created`,
  );

  // 3. List pending recommendations
  const listRes = await fetch(`${API_URL}/api/recommendations?storeId=${STORE_ID}`, {
    headers: authHeaders,
  });
  assert(listRes.ok, `GET recommendations returned ${listRes.status}`);
  const { recommendations } = await listRes.json();

  console.log(`\nPending recommendations: ${recommendations.length}\n`);
  if (recommendations.length === 0) {
    console.log('  (none — is the demo seeded and did detection return alerts?)');
  } else {
    console.log('  priority | rec_type      | title                          | suggested_quantity');
    console.log('  ---------+---------------+--------------------------------+-------------------');
    for (const r of recommendations) {
      const type  = (r.rec_type ?? '').padEnd(13);
      const title = (r.title ?? '').padEnd(30).slice(0, 30);
      const qty   = r.suggested_quantity ?? '';
      console.log(`  ${String(r.priority).padStart(8)} | ${type} | ${title} | ${qty}`);
    }
  }

  assert(recommendations.length > 0, 'expected at least one recommendation after detection');

  // 4. Complete the first one
  const first = recommendations[0];
  const completeRes = await fetch(`${API_URL}/api/recommendations/${first.id}/complete`, {
    method: 'PATCH',
    headers: authHeaders,
  });
  assert(completeRes.ok, `PATCH complete returned ${completeRes.status}`);
  console.log(`\n✔ Marked "${first.title}" complete`);

  // 5. Re-GET and confirm it disappeared
  const reListRes = await fetch(`${API_URL}/api/recommendations?storeId=${STORE_ID}`, {
    headers: authHeaders,
  });
  assert(reListRes.ok, `re-GET recommendations returned ${reListRes.status}`);
  const re = await reListRes.json();
  const stillPresent = re.recommendations.some((r) => r.id === first.id);
  assert(!stillPresent, `completed recommendation ${first.id} should not appear in the pending list`);
  console.log(`✔ Confirmed it disappeared (${re.recommendations.length} remaining)\n`);

  console.log('✅ smokeRecommendations passed');
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
