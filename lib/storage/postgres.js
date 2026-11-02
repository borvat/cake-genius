/**
 * PostgreSQL driver (optional runtime dependency: `pg`).
 *
 * Loaded lazily, only when DATABASE_URL is set, so the default local run stays
 * dependency-free on SQLite. Same async interface as the SQLite driver; `?`
 * placeholders are rewritten to `$1..$n` once per statement.
 *
 * SSL: managed providers (Neon/Aiven/Supabase) require TLS. `sslmode=require`
 * in the connection string enables TLS without demanding a local CA bundle.
 */
export async function createPostgresDriver(connectionString, { readOnly = false } = {}) {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    throw Object.assign(new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg'), {
      code: 'PG_DRIVER_MISSING', status: 503,
    });
  }

  const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(connectionString);
  // client_encoding is pinned explicitly: a cluster created under a Windows locale
  // (e.g. Arabic_Lebanon.1252) otherwise negotiates WIN1252 and rejects Arabic text.
  const options = ['-c client_encoding=UTF8', ...(readOnly ? ['-c default_transaction_read_only=on'] : [])].join(' ');
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'cake-genius',
    options,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

  function toPg(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async function query(sql, params = []) {
    const res = await pool.query(toPg(sql), params);
    // Multi-statement DDL returns an array of results; callers only need counts.
    if (Array.isArray(res)) return { rows: [], rowCount: 0 };
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        dialect: 'postgres',
        async query(sql, params = []) {
          const res = await client.query(toPg(sql), params);
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        },
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already down */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    dialect: 'postgres',
    readOnly,
    target: maskConnectionString(connectionString),
    query,
    transaction,
    async close() { await pool.end(); },
  };
}

export function maskConnectionString(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'postgres://***';
  }
}
