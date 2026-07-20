/**
 * src/index.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Retail Analytics Dashboard — Express API Server
 * Phase 2: Backend Foundation
 *
 * Route map:
 *   POST /api/auth/login           — issue JWT (Phase 2)
 *   GET  /api/overview             — BusinessOwnerDashboard data
 *   GET  /api/alerts               — anomaly alerts (StoreManagerDashboard)
 *   PATCH /api/alerts/:id/ack      — acknowledge alert
 *   PATCH /api/alerts/:id/dismiss  — dismiss alert
 *   GET  /api/stockout             — stockout prediction
 *   POST /api/upload               — CSV/XLSX file ingest
 *   GET  /api/upload/:jobId/status — poll ingest job progress
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import express          from 'express';
import cors             from 'cors';
import helmet           from 'helmet';
import rateLimit        from 'express-rate-limit';
import pool             from './db/pool.js';
import overviewRouter   from './routes/overview.js';
import alertsRouter     from './routes/alerts.js';
import stockoutRouter   from './routes/stockout.js';
import uploadRouter     from './routes/upload.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id'],
}));

// Rate limiting — 200 requests per 15 minutes per IP.
// Tighten this for production; loosen for development if needed.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json({ limit: '1mb' }));

// ── Health check (no auth required) ──────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch {
    return res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/overview', overviewRouter);
app.use('/api/alerts',   alertsRouter);
app.use('/api/stockout', stockoutRouter);
app.use('/api/upload',   uploadRouter);

// ── Minimal auth endpoint ─────────────────────────────────────────────────────
// A full auth system is out of Phase 2 scope, but we need something to issue
// tokens for testing. Replace with a proper registration/login flow in Phase 3.
import jwt       from 'jsonwebtoken';
import bcrypt    from 'bcryptjs';
import { query } from './db/pool.js';

app.post('/api/auth/login', async (req, res) => {
  const { email, password, tenantSlug } = req.body;

  if (!email || !password || !tenantSlug) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: 'email, password, and tenantSlug are required.' });
  }

  try {
    const { rows } = await query(
      `SELECT u.id, u.password_hash, u.role, u.store_id, u.tenant_id
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND t.slug = $2 AND u.is_active = TRUE AND t.is_active = TRUE`,
      [email.toLowerCase(), tenantSlug],
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    }

    const user = rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    }

    // Update last login timestamp
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      {
        sub:      user.id,
        tenantId: user.tenant_id,
        role:     user.role,
        storeId:  user.store_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
    );

    return res.json({ token, role: user.role, tenantId: user.tenant_id });
  } catch (err) {
    console.error('[auth/login] Error:', err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route does not exist.' });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches any unhandled errors thrown by route handlers.
// Never leaks stack traces to the client in production.
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message, err.stack);

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'FILE_TOO_LARGE',
      message: `File exceeds the ${process.env.MAX_FILE_SIZE_MB || 25}MB limit.`,
    });
  }

  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : err.message,
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Retail Analytics API running on port ${PORT}`);
  console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   CORS origin : ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});

export default app;
