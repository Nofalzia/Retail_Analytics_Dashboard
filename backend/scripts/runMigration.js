import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query(`ALTER TABLE anomaly_alerts ADD CONSTRAINT uq_anomaly_per_product_per_day UNIQUE (tenant_id, store_id, product_id, alert_type, alert_date)`);
  console.log('Migration applied.');
} catch (err) {
  if (err.code === '42710') {
    console.log('Constraint already exists — OK.');
  } else {
    console.error('Failed:', err.message);
    process.exit(1);
  }
} finally {
  await pool.end();
}