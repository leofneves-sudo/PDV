const {portion,allocate}=require('./amount');

function linkCancelledShifts(db) {
  db.exec(`
    UPDATE orders AS o SET closed_shift_id=(
      SELECT s.id FROM shifts s WHERE s.opened_by=o.ended_by AND s.opened_at<=o.ended_at
        AND (s.closed_at IS NULL OR s.closed_at>=o.ended_at) GROUP BY s.opened_by HAVING COUNT(*)=1
    ) WHERE o.status='cancelled' AND o.closed_shift_id IS NULL AND o.ended_at IS NOT NULL;
    UPDATE returns AS r SET shift_id=(
      SELECT MIN(p.shift_id) FROM payment_reversals p WHERE p.return_id=r.id AND p.shift_id IS NOT NULL
      HAVING COUNT(DISTINCT p.shift_id)=1
    );
  `);
}
function restoreRecordedCosts(db) {
  const sold=db.prepare(`SELECT order_id,product_id,SUM(-amount) units,SUM(value_before-value_after) cost
    FROM stock_moves WHERE kind='sale' AND order_id IS NOT NULL
    GROUP BY order_id,product_id HAVING COUNT(*)=COUNT(value_before) AND COUNT(*)=COUNT(value_after)`);
  const saleLines=db.prepare('SELECT id,quantity FROM items WHERE order_id=? AND product_id=? ORDER BY id');
  const setCost=db.prepare('UPDATE items SET cost_total=? WHERE id=?');
  for (const row of sold.iterate()) {
    const lines=saleLines.all(row.order_id,row.product_id);
    const quantities=lines.map(line=>line.quantity);
    if (quantities.reduce((sum,q)=>sum+q,0)!==row.units || row.cost<0) continue;
    const costs=allocate(row.cost,quantities);
    lines.forEach((line,index)=>setCost.run(costs[index],line.id));
  }
  const returned=db.prepare(`SELECT ri.*,i.quantity sold_quantity,i.cost_total sold_cost,i.product_id,r.order_id
    FROM return_items ri JOIN items i ON i.id=ri.item_id JOIN returns r ON r.id=ri.return_id
    ORDER BY ri.item_id,ri.return_id`);
  const moves=db.prepare(`SELECT m.id,m.amount,m.before,m.value_before,m.value_after FROM stock_moves m
    WHERE m.kind='refund' AND m.order_id=? AND m.reference_id=? AND m.product_id=? AND m.amount=?`);
  const setReturn=db.prepare('UPDATE return_items SET cost_allocated=?,cost_restocked=? WHERE return_id=? AND item_id=?');
  const usedMoves=new Set();
  let itemId=null,remainingUnits=0,remainingCost=null;
  for (const row of returned.iterate()) {
    if (row.item_id!==itemId) {
      itemId=row.item_id;
      remainingUnits=row.sold_quantity;
      remainingCost=row.sold_cost;
    }
    let allocated=null,restocked=null;
    if (row.restock) {
      const candidates=moves.all(row.order_id,row.return_id,row.product_id,row.quantity).filter(move=>!usedMoves.has(move.id));
      if (candidates.length===1) {
        const move=candidates[0];
        usedMoves.add(move.id);
        const before=move.value_before ?? (move.before===0?0:null);
        if (before!=null && move.value_after!=null && move.value_after>=before) {
          restocked=move.value_after-before;
          allocated=restocked;
        }
      }
    } else if (remainingCost!=null && remainingUnits>=row.quantity) {
      allocated=portion(remainingCost,row.quantity,remainingUnits);
    }
    setReturn.run(allocated,restocked,row.return_id,row.item_id);
    remainingCost=allocated==null || remainingCost==null ? null : Math.max(0,remainingCost-allocated);
    remainingUnits-=row.quantity;
  }
}
function migrateRevision(db) {
  db.exec(`
    CREATE TABLE operation_intents (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
      fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE merchandise_corrections (
      id INTEGER PRIMARY KEY, original_id INTEGER NOT NULL UNIQUE REFERENCES merchandise(id),
      replacement_id INTEGER UNIQUE REFERENCES merchandise(id), ledger_reversal_id INTEGER NOT NULL REFERENCES ledger(id),
      reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), user_name TEXT NOT NULL,
      approved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
    );
    ALTER TABLE items ADD COLUMN cost_total INTEGER CHECK(cost_total IS NULL OR cost_total>=0);
    ALTER TABLE return_items ADD COLUMN cost_allocated INTEGER CHECK(cost_allocated IS NULL OR cost_allocated>=0);
    ALTER TABLE return_items ADD COLUMN cost_restocked INTEGER CHECK(cost_restocked IS NULL OR cost_restocked>=0);
    ALTER TABLE returns ADD COLUMN shift_id INTEGER REFERENCES shifts(id);
    CREATE INDEX orders_closed_time ON orders(ended_at DESC,id DESC) WHERE status<>'open';
    CREATE INDEX orders_closed_shift ON orders(closed_shift_id,ended_at DESC,id DESC);
    CREATE INDEX orders_closed_by ON orders(ended_by,ended_at DESC,id DESC);
    CREATE INDEX items_product_order ON items(product_id,order_id);
    CREATE INDEX items_category_order ON items(category,order_id);
    CREATE INDEX return_items_item ON return_items(item_id);
    CREATE INDEX returns_created ON returns(created_at,order_id);
    CREATE INDEX returns_shift ON returns(shift_id,created_at);
    CREATE INDEX payment_confirm_time ON payments(confirmed_at);
    CREATE INDEX reversal_created ON payment_reversals(created_at);
    CREATE INDEX ledger_created ON ledger(created_at);
    CREATE INDEX stock_moves_order_kind ON stock_moves(order_id,kind,reference_id,product_id);
  `);
  linkCancelledShifts(db);
  restoreRecordedCosts(db);
}
module.exports={migrateRevision};
