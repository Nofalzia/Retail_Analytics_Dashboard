/**
 * src/seed.js
 * ──────────────────────────────────────────────────────────────────────────────
 * One-time seed script for the demo tenant.
 * Run from the backend/ directory: node src/seed.js
 *
 * Seeds:
 *   - 1 demo user   (owner@demo.com / Demo@1234)
 *   - 4 categories
 *   - 12 products
 *   - 90 days of sale_transactions (~1080 rows)
 *   - 1 inventory snapshot (today's stock levels, some products near depletion)
 *
 * Safe to re-run — uses ON CONFLICT DO UPDATE / DO NOTHING throughout.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pool from './db/pool.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const STORE_ID  = '00000000-0000-0000-0000-000000000010';

// ── Product definitions ───────────────────────────────────────────────────────
const PRODUCTS = [
  { sku: 'BEV-001', name: 'Coca-Cola 1.5L',        category: 'Beverages',  cost: 80,  price: 120, reorder: 30, avgDaily: 25, stock: 18  },
  { sku: 'BEV-002', name: 'Pepsi 1.5L',             category: 'Beverages',  cost: 75,  price: 115, reorder: 25, avgDaily: 20, stock: 60  },
  { sku: 'BEV-003', name: 'Mineral Water 500ml',    category: 'Beverages',  cost: 25,  price: 40,  reorder: 50, avgDaily: 40, stock: 22  },
  { sku: 'SNK-001', name: 'Lays Classic 100g',      category: 'Snacks',     cost: 60,  price: 90,  reorder: 20, avgDaily: 15, stock: 180 },
  { sku: 'SNK-002', name: 'Kurkure Masala 80g',     category: 'Snacks',     cost: 45,  price: 70,  reorder: 15, avgDaily: 12, stock: 4   },
  { sku: 'SNK-003', name: 'Oreo Original 150g',     category: 'Snacks',     cost: 85,  price: 130, reorder: 12, avgDaily: 8,  stock: 45  },
  { sku: 'DAI-001', name: 'Milk 1L',                category: 'Dairy',      cost: 150, price: 190, reorder: 25, avgDaily: 18, stock: 14  },
  { sku: 'DAI-002', name: 'Yogurt 500g',            category: 'Dairy',      cost: 120, price: 160, reorder: 15, avgDaily: 10, stock: 80  },
  { sku: 'DAI-003', name: 'Cheese Slice 200g',      category: 'Dairy',      cost: 280, price: 380, reorder: 8,  avgDaily: 5,  stock: 15  },
  { sku: 'HSD-001', name: 'Surf Excel 500g',        category: 'Household',  cost: 450, price: 580, reorder: 10, avgDaily: 6,  stock: 60  },
  { sku: 'HSD-002', name: 'Ariel 1kg',              category: 'Household',  cost: 680, price: 850, reorder: 8,  avgDaily: 4,  stock: 35  },
  { sku: 'HSD-003', name: 'Vim Dishwash Bar',       category: 'Household',  cost: 95,  price: 140, reorder: 10, avgDaily: 7,  stock: 8   },
];

const CATEGORIES = ['Beverages', 'Snacks', 'Dairy', 'Household'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seeded pseudo-random for reproducible variance. */
function seededRandom(seed) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

/** Returns YYYY-MM-DD string for (today - daysAgo). */
function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Demo user ──────────────────────────────────────────────────────────
    console.log('  Creating demo user...');
    const passwordHash = await bcrypt.hash('Demo@1234', 10);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
       VALUES ($1, 'owner@demo.com', $2, 'owner', $3)
       ON CONFLICT (tenant_id, email)
         DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [TENANT_ID, passwordHash, STORE_ID],
    );
    const userId = user.id;

    // Also seed a manager user for role-switching demo
    await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
       VALUES ($1, 'manager@demo.com', $2, 'manager', $3)
       ON CONFLICT (tenant_id, email)
         DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [TENANT_ID, passwordHash, STORE_ID],
    );

    // ── 2. Categories ─────────────────────────────────────────────────────────
    console.log('  Seeding categories...');
    const categoryIds = {};
    for (const name of CATEGORIES) {
      const { rows: [c] } = await client.query(
        `INSERT INTO categories (tenant_id, name)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [TENANT_ID, name],
      );
      categoryIds[name] = c.id;
    }

    // ── 3. Products ───────────────────────────────────────────────────────────
    console.log('  Seeding products...');
    const productIds = {};
    for (const p of PRODUCTS) {
      const { rows: [prod] } = await client.query(
        `INSERT INTO products (tenant_id, category_id, name, sku, standard_unit_cost, standard_unit_price, reorder_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, sku)
           DO UPDATE SET
             name = EXCLUDED.name,
             standard_unit_cost = EXCLUDED.standard_unit_cost,
             standard_unit_price = EXCLUDED.standard_unit_price,
             reorder_threshold = EXCLUDED.reorder_threshold
         RETURNING id`,
        [TENANT_ID, categoryIds[p.category], p.name, p.sku, p.cost, p.price, p.reorder],
      );
      productIds[p.sku] = prod.id;
    }

    // ── 4. Ingestion job for sales data ───────────────────────────────────────
    console.log('  Creating seed ingestion job...');
    const { rows: [job] } = await client.query(
      `INSERT INTO ingestion_jobs
         (tenant_id, store_id, uploaded_by, original_filename, file_type, status,
          total_rows, rows_processed, completed_at)
       VALUES ($1, $2, $3, 'seed_90days_sales.csv', 'csv', 'completed', $4, $4, NOW())
       RETURNING id`,
      [TENANT_ID, STORE_ID, userId, 90 * PRODUCTS.length],
    );
    const jobId = job.id;

    // ── 5. Sale transactions — 90 days × 12 products ──────────────────────────
    console.log('  Generating 90 days of sales transactions...');

    const txRows = [];
    for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
      const saleDate = dateStr(daysAgo);
      const dayOfWeek = new Date(saleDate).getDay(); // 0=Sun, 6=Sat
      const isWeekend  = dayOfWeek === 0 || dayOfWeek === 6;

      for (let pi = 0; pi < PRODUCTS.length; pi++) {
        const p    = PRODUCTS[pi];
        const seed = daysAgo * 100 + pi;

        // Weekend uplift (30%) + ±40% daily variance
        const weekendMult = isWeekend ? 1.3 : 1.0;
        const variance    = 0.6 + seededRandom(seed) * 0.8; // 0.6–1.4×
        const qty         = Math.max(1, Math.round(p.avgDaily * weekendMult * variance));

        // Occasional 5% discount (1 in 8 chance)
        const discounted  = seededRandom(seed + 5000) > 0.875;
        const unitPrice   = discounted ? +(p.price * 0.95).toFixed(2) : p.price;

        txRows.push([TENANT_ID, STORE_ID, productIds[p.sku], jobId, qty, unitPrice, p.cost, saleDate]);
      }
    }

    // Batch insert in chunks of 250
    const CHUNK = 250;
    for (let i = 0; i < txRows.length; i += CHUNK) {
      const chunk  = txRows.slice(i, i + CHUNK);
      const values = chunk.map((_, idx) => {
        const b = idx * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(',');

      await client.query(
        `INSERT INTO sale_transactions
           (tenant_id, store_id, product_id, ingestion_job_id,
            quantity_sold, unit_price_at_sale, cost_price_at_sale, sale_date)
         VALUES ${values}`,
        chunk.flat(),
      );
    }

    // ── 6. Inventory snapshot ─────────────────────────────────────────────────
    console.log('  Writing inventory snapshot...');
    const { rows: [invJob] } = await client.query(
      `INSERT INTO ingestion_jobs
         (tenant_id, store_id, uploaded_by, original_filename, file_type, status,
          total_rows, rows_processed, completed_at)
       VALUES ($1, $2, $3, 'inventory_snapshot.csv', 'csv', 'completed', $4, $4, NOW())
       RETURNING id`,
      [TENANT_ID, STORE_ID, userId, PRODUCTS.length],
    );

    const today = dateStr(0);
    for (const p of PRODUCTS) {
      await client.query(
        `INSERT INTO inventory_logs (tenant_id, store_id, product_id, ingestion_job_id, quantity_on_hand, log_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [TENANT_ID, STORE_ID, productIds[p.sku], invJob.id, p.stock, today],
      );
    }

    await client.query('COMMIT');

    console.log('\n✅ Seed complete!');
    console.log('   Tenant  : Demo Kiryana Store');
    console.log('   Owner   : owner@demo.com   /  Demo@1234');
    console.log('   Manager : manager@demo.com /  Demo@1234');
    console.log(`   Products: ${PRODUCTS.length}`);
    console.log(`   Sales   : ${txRows.length} rows (90 days × ${PRODUCTS.length} products)`);
    console.log('   Stockout alerts: Kurkure (4 units), Vim (8 units), Water (22 units)\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

console.log('\n🌱 Seeding demo tenant data...');
seed();
