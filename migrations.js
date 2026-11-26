const {resolve,dirname,join}=require('node:path');
const {snapshot}=require('./backup');

function migrate(db,file,existing) {
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if (version>=6) return;
  if (existing && file!==':memory:') {
    const dir=resolve(process.env.PDV_BACKUP_DIR || join(dirname(file),'backups'));
    console.log('Backup pré-migração:',snapshot(db,dir,'pre-migracao-v6'));
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version<1) db.exec(`
      CREATE TABLE registers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
      INSERT INTO registers(name) VALUES('Caixa 1');
      CREATE TABLE shifts (
        id INTEGER PRIMARY KEY, register_id INTEGER NOT NULL REFERENCES registers(id),
        opened_by INTEGER NOT NULL REFERENCES users(id), opened_name TEXT NOT NULL, opened_at TEXT NOT NULL,
        opening INTEGER NOT NULL CHECK(opening>=0), closed_by INTEGER REFERENCES users(id), closed_name TEXT, closed_at TEXT,
        counted INTEGER, expected INTEGER, difference INTEGER, closing_summary TEXT, reason TEXT
      );
      CREATE UNIQUE INDEX shift_register_open ON shifts(register_id) WHERE closed_at IS NULL;
      CREATE UNIQUE INDEX shift_user_open ON shifts(opened_by) WHERE closed_at IS NULL;
      CREATE TABLE cash_moves (
        id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id),
        kind TEXT NOT NULL CHECK(kind IN ('supply','withdrawal','adjustment')),
        amount INTEGER NOT NULL CHECK(amount<>0), reason TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      ALTER TABLE users ADD COLUMN discount_limit INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE audit ADD COLUMN approved_by INTEGER REFERENCES users(id);
      ALTER TABLE audit ADD COLUMN approved_name TEXT;
      ALTER TABLE orders ADD COLUMN closed_shift_id INTEGER REFERENCES shifts(id);
      ALTER TABLE orders ADD COLUMN merged_into INTEGER REFERENCES orders(id);
      ALTER TABLE cards ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN state TEXT NOT NULL DEFAULT 'confirmed';
      ALTER TABLE payments ADD COLUMN shift_id INTEGER REFERENCES shifts(id);
      ALTER TABLE payments ADD COLUMN received_by INTEGER REFERENCES users(id);
      ALTER TABLE payments ADD COLUMN received_name TEXT;
      ALTER TABLE payments ADD COLUMN paid_at TEXT;
      ALTER TABLE payments ADD COLUMN confirmed_at TEXT;
      ALTER TABLE payments ADD COLUMN confirmed_by INTEGER REFERENCES users(id);
      ALTER TABLE payments ADD COLUMN payer TEXT;
      ALTER TABLE payments ADD COLUMN original_order_id INTEGER REFERENCES orders(id);
      UPDATE payments SET original_order_id=order_id,
        received_by=(SELECT ended_by FROM orders WHERE id=order_id),
        received_name=(SELECT ended_name FROM orders WHERE id=order_id),
        paid_at=(SELECT ended_at FROM orders WHERE id=order_id),
        confirmed_at=(SELECT ended_at FROM orders WHERE id=order_id),
        confirmed_by=(SELECT ended_by FROM orders WHERE id=order_id);
      CREATE INDEX payments_shift ON payments(shift_id,paid_at);
      CREATE TABLE payment_requests (
        order_id INTEGER NOT NULL REFERENCES orders(id), token TEXT NOT NULL, action TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), fingerprint TEXT NOT NULL, PRIMARY KEY(order_id,token)
      );
      CREATE TABLE returns (
        id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
        amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL,
        approved_by INTEGER REFERENCES users(id), approved_name TEXT
      );
      CREATE INDEX returns_order ON returns(order_id);
      CREATE TABLE return_items (
        return_id INTEGER NOT NULL REFERENCES returns(id), item_id INTEGER NOT NULL REFERENCES items(id),
        quantity INTEGER NOT NULL CHECK(quantity>0), amount INTEGER NOT NULL, restock INTEGER NOT NULL,
        PRIMARY KEY(return_id,item_id)
      );
      CREATE TABLE payment_reversals (
        id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id),
        return_id INTEGER REFERENCES returns(id), order_id INTEGER NOT NULL REFERENCES orders(id),
        shift_id INTEGER REFERENCES shifts(id), amount INTEGER NOT NULL CHECK(amount>0),
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL
      );
      CREATE INDEX payment_reversal_shift ON payment_reversals(shift_id,created_at);
      CREATE INDEX payment_reversal_original ON payment_reversals(payment_id);
      INSERT INTO payment_reversals(payment_id,order_id,amount,user_id,user_name,created_at,reason)
        SELECT p.id,o.id,p.amount,o.refunded_by,COALESCE(o.refunded_name,'Operador do estorno'),
          o.refunded_at,COALESCE(o.reason,'Estorno anterior à migração')
        FROM payments p JOIN orders o ON o.id=p.order_id
        WHERE o.status='refunded' AND o.refunded_by IS NOT NULL AND o.refunded_at IS NOT NULL AND p.amount>0;
      ALTER TABLE ledger ADD COLUMN source TEXT NOT NULL DEFAULT 'funded';
      ALTER TABLE ledger ADD COLUMN shift_id INTEGER REFERENCES shifts(id);
      ALTER TABLE ledger ADD COLUMN payment_id INTEGER REFERENCES payments(id);
      ALTER TABLE ledger ADD COLUMN payment_reversal_id INTEGER REFERENCES payment_reversals(id);
      CREATE UNIQUE INDEX ledger_payment_debit ON ledger(payment_id) WHERE kind='use';
      CREATE UNIQUE INDEX ledger_payment_return ON ledger(payment_reversal_id) WHERE payment_reversal_id IS NOT NULL;
      DROP INDEX ledger_reversal;
      CREATE UNIQUE INDEX ledger_reversal ON ledger(original_id) WHERE kind='deposit_reversal';
      UPDATE ledger SET source='spend' WHERE kind='use';
      UPDATE ledger SET source='return' WHERE kind='use_reversal';
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, document TEXT, contact TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE merchandise (
        id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id), customer_id INTEGER REFERENCES customers(id),
        product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity>0),
        unit_cost INTEGER NOT NULL CHECK(unit_cost>=0), created_at TEXT NOT NULL, reason TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, ledger_id INTEGER REFERENCES ledger(id)
      );
      CREATE TABLE stock_counts (
        id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
        expected INTEGER NOT NULL, counted INTEGER NOT NULL, reason TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE breakpacks (
        id INTEGER PRIMARY KEY, source INTEGER NOT NULL REFERENCES products(id), destination INTEGER NOT NULL REFERENCES products(id),
        consumed INTEGER NOT NULL, produced INTEGER NOT NULL, cost INTEGER NOT NULL, reason TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      ALTER TABLE products ADD COLUMN stock_value INTEGER;
      ALTER TABLE products ADD COLUMN game TEXT;
      ALTER TABLE products ADD COLUMN collection TEXT;
      ALTER TABLE products ADD COLUMN collector_number TEXT;
      ALTER TABLE products ADD COLUMN language TEXT;
      ALTER TABLE products ADD COLUMN condition TEXT;
      ALTER TABLE products ADD COLUMN rarity TEXT;
      ALTER TABLE products ADD COLUMN foil INTEGER;
      UPDATE products SET stock_value=cost*stock WHERE cost IS NOT NULL;
      ALTER TABLE stock_moves ADD COLUMN value_before INTEGER;
      ALTER TABLE stock_moves ADD COLUMN value_after INTEGER;
      ALTER TABLE stock_moves ADD COLUMN reference_id INTEGER;
      ALTER TABLE stock_moves ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
      CREATE TABLE favorites (
        user_id INTEGER NOT NULL REFERENCES users(id), product_id INTEGER NOT NULL REFERENCES products(id),
        PRIMARY KEY(user_id,product_id)
      );
      CREATE TABLE reconciliations (
        id INTEGER PRIMARY KEY, entity TEXT NOT NULL CHECK(entity IN ('payment','ledger','reversal')),
        entity_id INTEGER NOT NULL, reviewed INTEGER NOT NULL, reason TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX reconciliations_record ON reconciliations(entity,entity_id,id);
      PRAGMA user_version=1;
    `);
    if (version<2) db.exec(`
      ALTER TABLE returns ADD COLUMN exchange_order_id INTEGER REFERENCES orders(id);
      ALTER TABLE payments ADD COLUMN confirmed_name TEXT;
      UPDATE payments SET confirmed_name=received_name WHERE state='confirmed';
      PRAGMA user_version=2;
    `);
    if (version<3) require('./revision').migrateRevision(db);
    if (version<4) db.exec('ALTER TABLE products ADD COLUMN expires_on TEXT');
    if (version<5) db.exec(`
      CREATE TABLE web_product_sources (
        source_key TEXT PRIMARY KEY NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
        source_url TEXT NOT NULL, imported_at TEXT NOT NULL
      );
      CREATE INDEX web_product_sources_product ON web_product_sources(product_id);
    `);
    if (version<6) db.exec(`
      ALTER TABLE web_product_sources ADD COLUMN last_stock INTEGER;
      ALTER TABLE web_product_sources ADD COLUMN observed_at TEXT;
      ALTER TABLE web_product_sources ADD COLUMN observation_version INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE site_sync_jobs (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL, create_new INTEGER NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        next_run TEXT, last_started TEXT, last_finished TEXT, status TEXT NOT NULL DEFAULT 'idle', message TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX site_sync_jobs_due ON site_sync_jobs(enabled,deleted,next_run);
      CREATE TABLE site_sync_runs (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES site_sync_jobs(id),
        started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
        baselines INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
        conflicts INTEGER NOT NULL DEFAULT 0, report TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX site_sync_runs_job ON site_sync_runs(job_id,id DESC);
      CREATE TABLE site_sync_members (
        job_id INTEGER NOT NULL REFERENCES site_sync_jobs(id), source_key TEXT NOT NULL REFERENCES web_product_sources(source_key),
        PRIMARY KEY(job_id,source_key)
      );
    `);
    db.exec('PRAGMA user_version=6');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('A migração encontrou referências inválidas.');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports={migrate};
