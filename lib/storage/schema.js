/**
 * Schema + numbered migrations, written in portable SQL (SQLite and Postgres).
 *
 * v1 is the original 1.1 schema, kept verbatim so an existing local database
 * migrates in place. v2 adds capacity/slots, settings, the notification outbox
 * and the columns the 1.2 order flow needs.
 *
 * Rules that keep the statements portable:
 *  - TEXT ISO timestamps, TEXT UUID ids, INTEGER money and 0/1 booleans
 *  - no AUTOINCREMENT, no SERIAL, no engine-specific types
 *  - ALTERs are guarded by the runner against "duplicate column" errors
 */
export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS products (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        name_ar     TEXT NOT NULL,
        name_en     TEXT NOT NULL,
        desc_ar     TEXT NOT NULL,
        desc_en     TEXT NOT NULL,
        category    TEXT NOT NULL,
        base_price  INTEGER NOT NULL,
        image       TEXT NOT NULL,
        tags        TEXT NOT NULL,
        popular     INTEGER NOT NULL DEFAULT 0,
        active      INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE IF NOT EXISTS customers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        phone       TEXT NOT NULL UNIQUE,
        email       TEXT,
        orders      INTEGER NOT NULL DEFAULT 0,
        spent       INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS orders (
        id             TEXT PRIMARY KEY,
        code           TEXT NOT NULL UNIQUE,
        customer_id    TEXT NOT NULL REFERENCES customers(id),
        customer_name  TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        customer_email TEXT,
        notes          TEXT,
        currency       TEXT NOT NULL,
        subtotal       INTEGER NOT NULL,
        rush_fee       INTEGER NOT NULL,
        delivery_fee   INTEGER NOT NULL,
        total          INTEGER NOT NULL,
        status         TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        delivery_at    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS order_items (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id  TEXT NOT NULL,
        name_ar     TEXT NOT NULL,
        name_en     TEXT NOT NULL,
        config_json TEXT NOT NULL,
        quantity    INTEGER NOT NULL,
        unit_price  INTEGER NOT NULL,
        line_total  INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS order_events (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status     TEXT NOT NULL,
        actor      TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS admin_users (
        id         TEXT PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        pass_hash  TEXT NOT NULL,
        salt       TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)',
      'CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id)',
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`,
      `INSERT INTO counters (name, value) VALUES ('order_code', 1000) ON CONFLICT (name) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS delivery_slots (
        slot_date TEXT NOT NULL,
        window_id TEXT NOT NULL,
        capacity  INTEGER NOT NULL,
        booked    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (slot_date, window_id)
      )`,
      `CREATE TABLE IF NOT EXISTS notification_outbox (
        id         TEXT PRIMARY KEY,
        order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        channel    TEXT NOT NULL,
        audience   TEXT NOT NULL,
        recipient  TEXT NOT NULL,
        template   TEXT NOT NULL,
        body       TEXT NOT NULL,
        status     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at    TEXT
      )`,
      'ALTER TABLE orders ADD COLUMN slot_date TEXT',
      'ALTER TABLE orders ADD COLUMN slot_window TEXT',
      'ALTER TABLE orders ADD COLUMN capacity_released INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE order_items ADD COLUMN line_no INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX IF NOT EXISTS idx_outbox_order ON notification_outbox(order_id)',
      'CREATE INDEX IF NOT EXISTS idx_slots_date ON delivery_slots(slot_date)',
      'CREATE INDEX IF NOT EXISTS idx_orders_slot ON orders(slot_date)',
    ],
  },
];

const TOLERATED = /duplicate column|already exists/i;

export async function migrate(store) {
  await store.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { rows } = await store.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    for (const stmt of m.statements) {
      try {
        await store.query(stmt);
      } catch (err) {
        // A legacy database may already carry a column this migration adds.
        if (!TOLERATED.test(err.message)) throw err;
      }
    }
    await store.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, new Date().toISOString()]);
  }
  return { applied: MIGRATIONS.filter((m) => applied.has(m.version)).map((m) => m.version), latest: MIGRATIONS.at(-1).version };
}
