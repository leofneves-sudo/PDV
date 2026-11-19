const {DatabaseSync} = require('node:sqlite');
const {randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash} = require('node:crypto');
const {existsSync,mkdirSync} = require('node:fs');
const {dirname, resolve} = require('node:path');

const file = process.env.PDV_DB || resolve('data/pdv.sqlite');
const reportReader=process.env.PDV_REPORT_READER==='1';
if (!reportReader && file !== ':memory:') {
  process.umask(0o077);
  mkdirSync(dirname(file), {recursive: true});
}
const existing=existsSync(file);
const db = new DatabaseSync(file,{readOnly:reportReader});
if (reportReader) db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
else {
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator')),
    permissions TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS terminal_codes (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    code_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pairings (
    reader TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    terminal TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, barcode TEXT,
    name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0),
    cost INTEGER CHECK(cost >= 0), stock INTEGER NOT NULL CHECK(stock >= 0),
    minimum INTEGER NOT NULL, image TEXT, image_hash TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS product_barcode ON products(barcode) WHERE barcode IS NOT NULL;
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, document TEXT, phone TEXT NOT NULL,
    email TEXT, birthday TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY, number INTEGER UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS scan_grants (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    card_id INTEGER NOT NULL REFERENCES cards(id), PRIMARY KEY(session_id,card_id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL REFERENCES cards(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','cancelled','refunded')),
    user_id INTEGER NOT NULL REFERENCES users(id), opened_name TEXT NOT NULL, opened_at TEXT NOT NULL,
    customer_id INTEGER REFERENCES customers(id), customer_name TEXT, notes TEXT NOT NULL DEFAULT '',
    discount INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, subtotal INTEGER,
    total INTEGER, ended_at TEXT, ended_by INTEGER REFERENCES users(id), ended_name TEXT,
    ended_session TEXT, refunded_at TEXT, refunded_by INTEGER REFERENCES users(id), refunded_name TEXT, reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_order ON orders(card_id) WHERE status='open';
  CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id,status,ended_at);
  CREATE INDEX IF NOT EXISTS orders_period ON orders(status,ended_at);
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL,
    code TEXT NOT NULL, category TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
    price INTEGER NOT NULL CHECK(price >= 0), cost INTEGER CHECK(cost >= 0)
  );
  CREATE INDEX IF NOT EXISTS items_order ON items(order_id);
  CREATE INDEX IF NOT EXISTS items_product ON items(product_id);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), method TEXT NOT NULL,
    amount INTEGER NOT NULL, received INTEGER, change INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS payments_order ON payments(order_id);
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('deposit','use','deposit_reversal','use_reversal')),
    origin TEXT NOT NULL, reason TEXT NOT NULL, order_id INTEGER REFERENCES orders(id),
    original_id INTEGER REFERENCES ledger(id), user_id INTEGER NOT NULL REFERENCES users(id),
    user_name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_customer ON ledger(customer_id,created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_reversal ON ledger(original_id) WHERE kind IN ('deposit_reversal','use_reversal');
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_correction ON ledger(original_id) WHERE kind='deposit' AND original_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), amount INTEGER NOT NULL,
    before INTEGER NOT NULL, after INTEGER NOT NULL, reason TEXT NOT NULL, kind TEXT NOT NULL,
    order_id INTEGER REFERENCES orders(id), user_id INTEGER NOT NULL REFERENCES users(id),
    user_name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), user_name TEXT NOT NULL,
    created_at TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
    before TEXT, after TEXT, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_date ON audit(created_at);
`);
require('./migrations').migrate(db,file,existing);
}

const permissions = {
  operate:'Ler e operar comandas', checkout:'Receber e fechar vendas',
  item_reduce:'Reduzir quantidades sem remover itens', item_remove:'Remover itens', item_price:'Alterar preço na comanda',
  discount:'Conceder desconto', cancel:'Cancelar comandas abertas', refund:'Estornar vendas',
  products:'Gerenciar produtos e custos', stock:'Movimentar estoque',
  customer_read:'Consultar clientes e saldo', customer_create:'Cadastrar clientes',
  customers:'Editar e inativar clientes', credit_statement:'Consultar extrato de créditos', credit:'Adicionar créditos', credit_reverse:'Estornar recargas', credit_correct:'Corrigir recargas',
  history_own:'Consultar histórico do próprio turno', history_all:'Consultar todo o histórico',
  reports:'Acessar dashboard e relatórios', cards:'Gerenciar e imprimir cartões',
  users:'Gerenciar operadores e permissões', audit:'Consultar auditoria',
  cashier:'Abrir e fechar o próprio caixa', cash_manage:'Gerenciar caixas e ajustes', payment_confirm:'Confirmar PIX',
  order_transfer:'Dividir comandas e transferir itens', order_merge:'Unir comandas', scan_number:'Abrir cartão pelo número',
  suppliers:'Gerenciar fornecedores e compras', credit_grant:'Conceder créditos sem recebimento', reconcile:'Conferir recebimentos', backup:'Gerenciar backups'
};
const defaults = {operate:true,checkout:true,item_reduce:true,customer_read:true,customer_create:true,history_own:true,cashier:true,order_transfer:true};
const methods = {cash:'Dinheiro',debit:'Cartão de débito',credit:'Cartão de crédito',pix:'PIX',store:'Crédito da loja'};
const origins = {cash:methods.cash,debit:methods.debit,credit:methods.credit,pix:'Pix',transfer:'Transferência',other:'Outro'};
const now = () => new Date().toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = row => row && {...row};
const get = (sql,...args) => plain(db.prepare(sql).get(...args));
const all = (sql,...args) => db.prepare(sql).all(...args).map(plain);
const run = (sql,...args) => db.prepare(sql).run(...args);
const idOf = result => Number(result.lastInsertRowid);
function tx(action) {
  if (db.isTransaction) return action();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    if (error.afterRollback) error.afterRollback();
    throw error;
  }
}
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message,status=400) => { throw new Problem(status,message); };
function required(value,label,max=200,min=1) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (str.length < min || str.length > max) fail(`${label} deve ter entre ${min} e ${max} caracteres.`);
  return str;
}
function optional(value,label,max=200) {
  return value === undefined || value === null || value === '' ? null : required(value,label,max);
}
function integer(value,label,min=0,max=100_000_000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} inválido.`);
  return value;
}
function record(row,label) {
  if (!row) fail(`${label} não encontrado.`,404);
  return row;
}
function can(user,key) {
  if (user.role === 'admin' || user.approval?.permission===key) return true;
  return JSON.parse(user.permissions || '{}')[key] ?? !!defaults[key];
}
function allow(user,key) {
  if (!can(user,key)) fail('Seu perfil não tem permissão para esta ação.',403);
}
function publicUser(user) {
  return {
    id:user.id, username:user.username, name:user.name, role:user.role, active:!!user.active,
    permissions:Object.fromEntries(Object.keys(permissions).map(key => [key,can(user,key)])),
    started_at:user.started_at,discount_limit:user.discount_limit || 0
  };
}
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    fail('A senha deve ter entre 10 e 128 caracteres.');
  }
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
const dummyHash = passwordHash(randomUUID());
function checkPassword(password, encoded = dummyHash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt,hash] = encoded.split(':');
  return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex'));
}
function audit(user,action,entity,id,before=null,after=null,reason=null) {
  run(`INSERT INTO audit(user_id,user_name,created_at,action,entity,entity_id,before,after,reason,approved_by,approved_name)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    user?.id ?? null,user?.name ?? 'Sistema',now(),action,entity,id ?? null,
    before == null ? null : JSON.stringify(before),after == null ? null : JSON.stringify(after),reason,user?.approval?.id ?? null,user?.approval?.name ?? null);
}
function userFields(body,old) {
  const username = required(body.username,'Usuário',40,3).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) fail('Use letras sem acento, números, ponto, hífen ou sublinhado no usuário.');
  if (!['admin','operator'].includes(body.role)) fail('Perfil inválido.');
  if (get('SELECT id FROM users WHERE username=? AND id<>?',username,old?.id ?? 0)) fail('Usuário já cadastrado.',409);
  if (body.password != null && typeof body.password !== 'string') fail('Senha inválida.');
  const grants = Object.fromEntries(Object.keys(permissions)
    .filter(key => typeof body.permissions?.[key] === 'boolean').map(key => [key,body.permissions[key]]));
  return {username,name:required(body.name,'Nome',120),role:body.role,active:body.active === false ? 0 : 1,
    discount_limit:body.discount_limit===undefined ? old?.discount_limit ?? 0 : integer(body.discount_limit,'Limite de desconto'),
    permissions:JSON.stringify(grants),password:body.password || !old ? passwordHash(body.password) : old.password};
}
function saveUser(actor,body,id) {
  const old = id ? record(get('SELECT * FROM users WHERE id=?',id),'Usuário') : null;
  const next = userFields(body,old);
  if (actor?.role !== 'admin' && actor && (next.role === 'admin' || old?.role === 'admin' ||
      Object.keys(permissions).some(key => can(next,key) && !can(actor,key)) || next.discount_limit>(actor.discount_limit || 0))) fail('Apenas um administrador pode conceder essas permissões.',403);
  if (old && old.id === actor?.id && (!next.active || next.role !== old.role)) fail('Outro administrador deve alterar seu perfil ou desativar sua conta.');
  if (old?.role === 'admin' && old.active && (!next.active || next.role !== 'admin') &&
      get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").n <= 1) fail('Mantenha pelo menos um administrador ativo.');
  if (old) {
    run('UPDATE users SET username=?,name=?,role=?,active=?,permissions=?,password=?,discount_limit=? WHERE id=?',
      next.username,next.name,next.role,next.active,next.permissions,next.password,next.discount_limit,id);
    if (!next.active || old.password !== next.password) run('DELETE FROM sessions WHERE user_id=?',id);
  } else {
    id = idOf(run('INSERT INTO users(username,name,role,active,permissions,password,discount_limit) VALUES(?,?,?,?,?,?,?)',
      next.username,next.name,next.role,next.active,next.permissions,next.password,next.discount_limit));
  }
  const saved = publicUser({...next,id});
  audit(actor || saved,old ? 'usuario.alterado' : 'usuario.criado','usuario',id,old && publicUser(old),saved);
  return saved;
}
function session(user) {
  const raw = randomBytes(32).toString('hex');
  run('DELETE FROM sessions WHERE expires<=?',Date.now());
  run('INSERT INTO sessions(id,user_id,started_at,expires) VALUES(?,?,?,?)',
    sha(raw),user.id,now(),Date.now()+12*60*60*1000);
  return raw;
}
function findSession(hash) {
  return hash && get(`SELECT u.*,s.id session_id,s.started_at,s.expires FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.expires>? AND u.active=1`,hash,Date.now());
}

module.exports = {db,file,get,all,run,idOf,tx,Problem,fail,record,integer,required,optional,now,sha,randomUUID,
  permissions,defaults,methods,origins,can,allow,publicUser,audit,saveUser,checkPassword,session,findSession};
