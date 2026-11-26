const {createServer} = require('node:http');
const https = require('node:https');
const {randomInt} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const QRCode = require('qrcode');
const {
  get,all,run,tx,Problem,fail,record,integer,required,sha,permissions,defaults,methods,origins,
  can,allow,publicUser,audit,saveUser,checkPassword,session,findSession
} = require('./db');
const ops = require('./operations');
const reports = require('./reports');
const cash=require('./cash');
const finance=require('./finance');
const inventory=require('./inventory');
const extra=require('./extensions');
const intents=require('./intents');
const {db,file}=require('./db');
const {paths:reportPaths,createPool}=require('./report-pool');
const reportPool=createPool(file);
const backups=require('./backup').controller(db,file);
const siteImports=require('./site-import').createController({notify:(owner,id)=>{
  for(const socket of clients.get(owner) || [])event(socket,'site-import',{id});
}});
const siteSync=require('./site-sync').createScheduler({importer:siteImports,notify:changed=>{
  for(const [hash,sockets] of clients)if(findSession(hash)?.role==='admin')for(const socket of sockets)event(socket,'site-sync',{});
  if(changed)broadcast();
}});

const host = process.env.PDV_HOST || '127.0.0.1';
const port = Number(process.env.PDV_PORT || 3000);
const publicOrigin = process.env.PDV_ORIGIN ? new URL(process.env.PDV_ORIGIN).origin : null;
const tls = process.env.PDV_TLS_CERT && process.env.PDV_TLS_KEY;
if (Boolean(process.env.PDV_TLS_CERT) !== Boolean(process.env.PDV_TLS_KEY)) {
  throw new Error('Informe PDV_TLS_CERT e PDV_TLS_KEY juntos.');
}
const clients = new Map();
const attempts = new Map();
const assets = {
  '/':'index.html','/index.html':'index.html','/app.css':'app.css','/app.js':'app.js',
  '/views.js':'views.js','/updates.js':'updates.js','/modals.js':'modals.js','/scanner.js':'scanner.js','/ui.js':'ui.js','/brand.svg':'brand.svg',
  '/qr-scanner.min.js':'node_modules/qr-scanner/qr-scanner.min.js',
  '/qr-scanner-worker.min.js':'node_modules/qr-scanner/qr-scanner-worker.min.js',
  '/expiry.mjs':'expiry.mjs','/site-import-ui.js':'site-import-ui.js','/site-sync-ui.js':'site-sync-ui.js'
};
const contentTypes = {html:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',svg:'image/svg+xml'};
const okay = (data,changed=false) => ({data,changed});
function commitIntent(actor,path,body,action) {
  const outcome=intents.perform(actor,path,body,action);
  return okay(outcome.value,outcome.changed);
}
function secureRequest(req) {
  return !!req.socket.encrypted || publicOrigin?.startsWith('https:');
}
function cookie(req,value,clear=false) {
  return `pdv_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 43200}${secureRequest(req) ? '; Secure' : ''}`;
}
function sessionHash(req) {
  const token = req.headers.cookie?.match(/(?:^|;\s*)pdv_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token ? sha(token) : null;
}
function local(req) {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '');
}
function requiresPairing(req) {
  return !local(req) || !!req.headers.forwarded || !!req.headers['x-forwarded-for'] ||
    req.headers['sec-ch-ua-mobile']==='?1' || /mobile|android|iphone|ipad|ipod/i.test(req.headers['user-agent'] || '');
}
function linkedTerminal(actor) {
  const connection=get('SELECT terminal,name FROM pairings WHERE reader=?',actor.session_id);
  const target=connection && findSession(connection.terminal);
  return target && can(target,'operate') ? {connection,target} : null;
}
function requirePairing(req,actor,path) {
  if (!requiresPairing(req)) return;
  if (['events','pairing','pairing/link','pairing/unlink'].includes(path)) return;
  if (['pairing/code','pairing/revoke'].includes(path)) {
    fail('Gerencie os vínculos no computador do caixa, pelo endereço localhost.',403);
  }
  if (!linkedTerminal(actor)) fail('Vincule este celular ao caixa no computador para usar o sistema.',428);
}
function setupAllowed(req) {
  return local(req) && !req.headers.forwarded && !req.headers['x-forwarded-for'] &&
    !get('SELECT id FROM users LIMIT 1');
}
function originCheck(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Origem da requisição inválida.',403);
  const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (req.headers.origin && req.headers.origin !== (publicOrigin || origin) && !(local(req) && req.headers.origin === origin)) {
    fail('Origem da requisição inválida.',403);
  }
}
function throttle(key,limit,interval) {
  const time = Date.now();
  const state = attempts.get(key);
  if (!state || state.until<=time) {
    attempts.set(key,{count:1,until:time+interval});
    return true;
  }
  state.count++;
  return state.count<=limit;
}
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail('Envie dados em JSON.',415);
  let bytes=0;
  const parts=[];
  for await (const chunk of req) {
    bytes+=chunk.length;
    if (bytes>1_600_000) {
      req.resume();
      fail('Dados acima do limite de tamanho.',413);
    }
    parts.push(chunk);
  }
  let data;
  try {
    data=JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    fail('Dados inválidos.');
  }
  if (!data || typeof data!=='object' || Array.isArray(data)) fail('Dados inválidos.');
  return data;
}
function send(res,data,status=200) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
function event(res,event,data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function notifyReaders(hash) {
  for (const {reader} of all('SELECT reader FROM pairings WHERE terminal=?',hash)) {
    for (const res of clients.get(reader) || []) event(res,'pairing',{});
  }
}
function disconnect(hash) {
  for (const res of clients.get(hash) || []) {
    event(res,'locked',{});
    res.end();
  }
  clients.delete(hash);
  notifyReaders(hash);
}
function broadcast() {
  for (const [hash,streams] of clients) {
    if (!findSession(hash)) {
      disconnect(hash);
      continue;
    }
    for (const stream of streams) event(stream,'change',{});
  }
}
function stream(req,res,actor) {
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  const first=!clients.has(actor.session_id);
  const sockets = clients.get(actor.session_id) || new Set();
  sockets.add(res);
  clients.set(actor.session_id,sockets);
  event(res,'ready',{});
  if (first) notifyReaders(actor.session_id);
  const heartbeat = setInterval(() => {
    if (!findSession(actor.session_id)) disconnect(actor.session_id);
    else res.write(': keepalive\n\n');
  },12000);
  res.on('close',() => {
    clearInterval(heartbeat);
    sockets.delete(res);
    if (!sockets.size && clients.get(actor.session_id) === sockets) {
      clients.delete(actor.session_id);
      notifyReaders(actor.session_id);
    }
  });
}
function pairingInfo(actor) {
  const connection = linkedTerminal(actor)?.connection;
  return {
    reader:connection ? {name:connection.name,online:clients.has(connection.terminal) && !!findSession(connection.terminal)} : null,
    readers:all(`SELECT u.name,COUNT(*) count FROM pairings p JOIN sessions s ON s.id=p.reader JOIN users u ON u.id=s.user_id
      WHERE p.terminal=? AND s.expires>? AND u.active=1 GROUP BY u.id ORDER BY u.name`,actor.session_id,Date.now())
  };
}
function pairingCode(actor,body) {
  const name = required(body.name,'Nome do caixa',60,2);
  const expires = Date.now()+120000;
  const code = tx(() => {
    run('DELETE FROM terminal_codes WHERE expires<=?',Date.now());
    let candidate;
    do {
      candidate=String(randomInt(100000,1000000));
    } while (get('SELECT session_id FROM terminal_codes WHERE code_hash=?',sha(candidate)));
    run(`INSERT INTO terminal_codes(session_id,code_hash,name,expires) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET code_hash=excluded.code_hash,name=excluded.name,expires=excluded.expires`,
      actor.session_id,sha(candidate),name,expires);
    return candidate;
  });
  return {code,expires,name};
}
function pair(actor,body,ip) {
  if (!throttle(`pair:${actor.id}`,6,120000) || !throttle(`pair-ip:${ip}`,32,120000)) fail('Muitas tentativas. Aguarde dois minutos.',429);
  const code = required(body.code,'Código',6,6);
  if (!/^\d{6}$/.test(code)) fail('Informe os seis dígitos exibidos no caixa.');
  const result=tx(() => {
    const terminal = get('SELECT * FROM terminal_codes WHERE code_hash=? AND expires>?',sha(code),Date.now());
    if (!terminal || terminal.session_id === actor.session_id ||
        !findSession(terminal.session_id) || !clients.has(terminal.session_id)) {
      fail('Código inválido ou expirado. Confirme que o caixa está online.',409);
    }
    allow(findSession(terminal.session_id),'operate');
    run('DELETE FROM terminal_codes WHERE session_id=?',terminal.session_id);
    run(`INSERT INTO pairings(reader,terminal,name) VALUES(?,?,?)
      ON CONFLICT(reader) DO UPDATE SET terminal=excluded.terminal,name=excluded.name`,
      actor.session_id,terminal.session_id,terminal.name);
    audit(actor,'leitor.pareado','caixa',null,null,{name:terminal.name});
    return {terminal:terminal.session_id,info:pairingInfo(actor)};
  });
  for (const socket of clients.get(result.terminal) || []) {
    event(socket,'paired',{readerName:actor.name});
  }
  return result.info;
}
function scan(actor,body) {
  allow(actor,'operate');
  const card = ops.cardFromCode(body.code);
  if (body.mode === 'paired') {
    const pairing = get('SELECT * FROM pairings WHERE reader=?',actor.session_id);
    const target = pairing && findSession(pairing.terminal);
    const streams = target && clients.get(target.session_id);
    if (!streams?.size || !can(target,'operate')) fail('Caixa vinculado indisponível. Abra o sistema no computador e confira a conexão.',409);
    ops.grantCard(target.session_id,card.id);
    ops.grantCard(actor.session_id,card.id);
    for (const socket of streams) event(socket,'card',{id:card.id,number:card.number});
    return {sent:true,number:card.number,terminal:pairing.name,card:ops.cardDetail(actor,card.id)};
  }
  if (body.mode !== 'direct') fail('Modo de leitura inválido.');
  ops.grantCard(actor.session_id,card.id);
  return ops.cardDetail(actor,card.id);
}
function printCards(actor,query) {
  allow(actor,'cards');
  const ids = String(query.get('ids') || '').split(',').map(Number);
  if (!ids.length || ids.length>100) fail('Selecione até 100 cartões.');
  ids.forEach(id=>integer(id,'Cartão',1,Number.MAX_SAFE_INTEGER));
  const cards = all(`SELECT id,number FROM cards WHERE blocked=0 AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY number`,...ids);
  return cards;
}
function auditLog(actor,query) {
  allow(actor,'audit');
  const search = (query.get('q') || '').trim().slice(0,100).toLowerCase();
  const page = Math.max(1,parseInt(query.get('page'),10) || 1);
  const where = "WHERE (?='' OR INSTR(LOWER(action || ' ' || user_name || ' ' || entity || ' ' || COALESCE(reason,'') || ' ' || COALESCE(entity_id,'')),?)>0)";
  return {
    rows:all(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT 50 OFFSET ?`,search,search,(page-1)*50),
    total:get(`SELECT COUNT(*) n FROM audit ${where}`,search,search).n,page
  };
}
function route(actor,method,path,body,query,ip) {
  if (method === 'GET') {
    if (path === 'products') return okay(ops.products(actor));
    if (path === 'open-cards') return okay(ops.openCards(actor));
    if (path === 'cash') return okay(cash.cashOverview(actor));
    if (path === 'suppliers') return okay(inventory.suppliers(actor));
    if (path === 'merchandise') return okay(inventory.history(actor));
    if (path === 'favorites') {
      allow(actor,'operate');
      return okay(all('SELECT product_id FROM favorites WHERE user_id=?',actor.id).map(row=>row.product_id));
    }
    if (path==='backups') { allow(actor,'backup'); return okay(backups.status()); }
    if (path === 'customers') return okay(ops.customers(actor));
    if (path === 'cards') return okay(ops.cardList(actor));
    if (path === 'cards/print') return okay(printCards(actor,query));
    if (path === 'audit') return okay(auditLog(actor,query));
    if (path === 'pairing') return okay(pairingInfo(actor));
    if (path === 'users') {
      allow(actor,'users');
      return okay(all('SELECT * FROM users ORDER BY name COLLATE NOCASE').map(publicUser));
    }
  }
  if (method === 'POST') {
    if (path === 'products') return okay(ops.saveProduct(actor,body),true);
    if (path === 'customers') return okay(ops.saveCustomer(actor,body),true);
    if (path === 'cards') return okay(ops.createCards(actor,body),true);
    if (path === 'scan') return okay(scan(actor,body));
    if (path === 'scan/number') return okay(extra.manualScan(actor,body),true);
    if (path === 'cash/registers') return okay(cash.register(actor,body),true);
    if (path === 'cash/open') return commitIntent(actor,path,body,()=>cash.openShift(actor,body));
    if (path === 'suppliers') return okay(inventory.saveSupplier(actor,body),true);
    if (path === 'merchandise') return commitIntent(actor,path,body,()=>inventory.receive(actor,body));
    if (path === 'inventory/count') return okay(inventory.count(actor,body),true);
    if (path === 'inventory/breakpack') return commitIntent(actor,path,body,()=>inventory.breakpack(actor,body));
    if (path === 'import/preview') return okay(inventory.previewImport(actor,body));
    if (path === 'import/apply') return okay(inventory.applyImport(actor,body),true);
    if (path === 'reconcile') return okay(extra.reconcile(actor,body),true);
    if (path==='backups') {
      allow(actor,'backup');
      const result=backups.run();
      audit(actor,result.error?'backup.falha':'backup.gerado','backup',null,null,{file:result.file},result.error ?? null);
      return okay(result,true);
    }
    if (path === 'users') {
      allow(actor,'users');
      return okay(tx(()=>saveUser(actor,body)),true);
    }
    if (path.startsWith('pairing/')) {
      if (!['pairing/link','pairing/unlink'].includes(path)) allow(actor,'operate');
      if (path === 'pairing/code') return okay(pairingCode(actor,body));
      if (path === 'pairing/link') return okay(pair(actor,body,ip),true);
      if (path === 'pairing/unlink') {
        run('DELETE FROM pairings WHERE reader=?',actor.session_id);
        return okay(pairingInfo(actor),true);
      }
      if (path === 'pairing/revoke') {
        tx(()=>{
          run('DELETE FROM pairings WHERE terminal=?',actor.session_id);
          run('DELETE FROM terminal_codes WHERE session_id=?',actor.session_id);
          audit(actor,'leitor.desvinculado','caixa',null,null,null,required(body.reason,'Motivo',400,3));
        });
        return okay(pairingInfo(actor),true);
      }
    }
  }
  const match = /^([a-z]+)\/(\d+)(?:\/([a-z-]+))?$/.exec(path);
  if (match) {
    const [,collection,raw,action] = match;
    const id = integer(Number(raw),'Identificador',1,Number.MAX_SAFE_INTEGER);
    if (method==='GET') {
      if (collection==='customers' && !action) return okay(ops.customerDetail(actor,id));
      if (collection==='merchandise' && !action) return okay(inventory.history(actor,id));
      if (collection==='shifts' && !action) return okay(cash.shiftDetails(actor,id));
      if (collection==='cards' && !action) return okay(ops.cardDetail(actor,id));
      if (collection==='orders' && !action) return okay(ops.orderDetail(actor,ops.historyOrder(actor,id)));
      if (collection==='orders' && action==='receipt') {
        allow(actor,'checkout');
        const order=record(get(`${ops.orderQuery} WHERE o.id=? AND o.status='closed' AND o.ended_session=?`,id,actor.session_id),'Comprovante');
        return okay(ops.orderDetail(actor,order));
      }
      if (collection==='products' && action==='counts') {
        allow(actor,'stock');
        return okay(all('SELECT * FROM stock_counts WHERE product_id=? ORDER BY id DESC',id));
      }
      if (collection==='products' && action==='movements') {
        allow(actor,'stock');
        return okay(all('SELECT * FROM stock_moves WHERE product_id=? ORDER BY id DESC',id));
      }
    }
    if (method==='POST') {
      if (collection==='products' && !action) return okay(ops.saveProduct(actor,body,id),true);
      if (collection==='products' && action==='stock') return commitIntent(actor,path,body,()=>ops.adjustStock(actor,id,body));
      if (collection==='products' && action==='expiry-loss') return commitIntent(actor,path,body,()=>inventory.expiryLoss(actor,id,body));
      if (collection==='products' && action==='favorite') return okay(inventory.favorite(actor,id,body),true);
      if (collection==='shifts' && action==='close') return commitIntent(actor,path,body,()=>cash.closeShift(actor,id,body));
      if (collection==='shifts' && action==='move') return commitIntent(actor,path,body,()=>cash.cashMove(actor,id,body));
      if (collection==='suppliers' && !action) return okay(inventory.saveSupplier(actor,body,id),true);
      if (collection==='cards' && ['block','replace'].includes(action)) return okay(extra.cardSecurity(actor,id,body,action==='replace'),true);
      if (collection==='customers' && !action) return okay(ops.saveCustomer(actor,body,id),true);
      if (collection==='customers' && action==='deposit') return commitIntent(actor,path,body,()=>ops.deposit(actor,id,body));
      if (collection==='merchandise' && action==='correct') return commitIntent(actor,path,body,()=>inventory.correctTrade(actor,id,body));
      if (collection==='ledger' && action==='reverse') return commitIntent(actor,path,body,()=>ops.reverseDeposit(actor,id,body));
      if (collection==='ledger' && action==='correct') return commitIntent(actor,path,body,()=>ops.correctDeposit(actor,id,body));
      if (collection==='cards' && !action) return okay(ops.changeCard(actor,id,body),true);
      if (collection==='cards' && action==='open') return okay(ops.openOrder(actor,id),true);
      if (collection==='orders' && action==='items') return okay(ops.orderItem(actor,id,body),true);
      if (collection==='orders' && action==='update') return okay(ops.updateOrder(actor,id,body),true);
      if (collection==='orders' && action==='checkout') return okay(finance.pay(actor,id,body,true),true);
      if (collection==='orders' && action==='payments') return okay(finance.pay(actor,id,body),true);
      if (collection==='orders' && action==='pix') return okay(finance.confirmPix(actor,id,body),true);
      if (collection==='orders' && action==='void') return okay(finance.voidPayment(actor,id,body),true);
      if (collection==='orders' && action==='move') return okay(finance.move(actor,id,body),true);
      if (collection==='orders' && action==='cancel') return okay(finance.cancel(actor,id,body),true);
      if (collection==='orders' && action==='refund') return okay(finance.returns(actor,id,body),true);
      if (collection==='users' && !action) {
        allow(actor,'users');
        return okay(tx(()=>saveUser(actor,body,id)),true);
      }
    }
  }
  fail('Recurso não encontrado.',404);
}
async function handle(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(self), microphone=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
  const {pathname,searchParams} = new URL(req.url,'http://pdv.local');
  const {method} = req;
  if (Object.hasOwn(assets,pathname) && (method==='GET' || method==='HEAD')) {
    const file = assets[pathname];
    const kind = file.split('.').at(-1);
    res.writeHead(200,{'Content-Type':`${contentTypes[kind]}; charset=utf-8`,'Cache-Control':'no-cache'});
    res.end(method === 'HEAD' ? undefined : readFileSync(resolve(__dirname,file)));
    return;
  }
  if (!pathname.startsWith('/api/')) fail('Página não encontrada.',404);
  const path = pathname.slice(5);
  const hash = sessionHash(req);
  const ip = req.socket.remoteAddress;
  const actor = findSession(hash);
  if (method==='POST') originCheck(req);
  if (path==='session' && method==='GET') {
    return send(res,{user:actor ? publicUser(actor) : null,setup:setupAllowed(req),initialized:!!get('SELECT id FROM users LIMIT 1'),
      pairingRequired:requiresPairing(req),pairing:actor ? pairingInfo(actor) : null,
      timezone:reports.timezone,permissions,defaults,methods,origins});
  }
  if (path==='setup' && method==='POST') {
    if (!setupAllowed(req)) fail('A configuração inicial deve ser feita no computador do servidor, pelo localhost.',403);
    const body = await jsonBody(req);
    const user = tx(()=>{
      if (!setupAllowed(req)) fail('A configuração inicial já foi concluída.',409);
      return saveUser(null,{...body,role:'admin',active:true});
    });
    audit(user,'auth.login','usuario',user.id);
    const raw = session(user);
    res.setHeader('Set-Cookie',cookie(req,raw));
    return send(res,{user:publicUser(findSession(sha(raw)))});
  }
  if (path==='login' && method==='POST') {
    const body = await jsonBody(req);
    const login = String(body.username || '').trim().toLowerCase().slice(0,40);
    const user = get('SELECT * FROM users WHERE username=?',login);
    const attempt = {id:user?.id ?? null,name:user?.name ?? 'Identidade não verificada'};
    if (!throttle(`login-ip:${ip}`,40,300000) || !throttle(`login-user:${login}`,10,300000)) {
      audit(attempt,'auth.bloqueado','usuario',user?.id,null,null,'Limite de tentativas');
      fail('Muitas tentativas. Aguarde cinco minutos.',429);
    }
    const valid = checkPassword(body.password,user?.password);
    if (!user?.active || !valid) {
      audit(attempt,'auth.falha','usuario',user?.id,null,{username:login});
      fail('Usuário ou senha inválidos.',401);
    }
    if (hash) {
      run('DELETE FROM sessions WHERE id=?',hash);
      disconnect(hash);
    }
    attempts.delete(`login-user:${login}`);
    const raw = session(user);
    audit(user,'auth.login','usuario',user.id);
    res.setHeader('Set-Cookie',cookie(req,raw));
    return send(res,{user:publicUser(findSession(sha(raw)))});
  }
  if (path==='logout' && method==='POST') {
    if (actor) {
      run('DELETE FROM sessions WHERE id=?',hash);
      audit(actor,'auth.bloqueio','usuario',actor.id);
      disconnect(hash);
    }
    res.setHeader('Set-Cookie',cookie(req,'',true));
    send(res,{ok:true});
    broadcast();
    return;
  }
  if (!actor) fail('Entre com seu usuário para continuar.',401);
  requirePairing(req,actor,path);
  if (path==='events' && method==='GET') return stream(req,res,actor);
  if (method==='GET' && /^products\/\d+\/image$/.test(path)) {
    const id=integer(Number(path.split('/')[1]),'Produto',1,Number.MAX_SAFE_INTEGER);
    const {image,image_hash}=ops.productImage(actor,id);
    const marker='"'+image_hash+'"';
    res.setHeader('ETag',marker);
    res.setHeader('Cache-Control','private, no-cache');
    if (req.headers['if-none-match']===marker) {
      res.writeHead(304);
      return res.end();
    }
    const [,type,bytes]=/^data:(image\/[a-z]+);base64,(.+)$/i.exec(image);
    res.writeHead(200,{'Content-Type':type.toLowerCase()});
    return res.end(Buffer.from(bytes,'base64'));
  }
  if (method==='GET' && /^cards\/\d+\/qr$/.test(path)) {
    allow(actor,'cards');
    const card = record(get('SELECT number,token FROM cards WHERE id=?',Number(path.split('/')[1])),'Cartão');
    const png = await QRCode.toBuffer(`pdv:${card.token}`,{width:420,margin:4,errorCorrectionLevel:'M'});
    res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, no-store'});
    return res.end(png);
  }
  if (method==='GET' && path==='inventory/expiry.csv') {
    const csv=inventory.expiryCsv(actor);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="validade-estoque.csv"','Cache-Control':'no-store'});
    return res.end('\uFEFF'+csv);
  }
  if (method==='GET' && reportPaths.has(path)) {
    const value=await reportPool.query(path,actor,searchParams);
    const active=findSession(hash);
    if (!active) fail('Entre com seu usuário para continuar.',401);
    requirePairing(req,active,path);
    if (active.role!==actor.role || active.permissions!==actor.permissions) fail('As permissões mudaram. Atualize a página.',403);
    if (res.destroyed) return;
    if (path.endsWith('.csv')) {
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${path}"`,'Cache-Control':'no-store'});
      return res.end('﻿'+value);
    }
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(value);
  }
  const body = method==='POST' ? await jsonBody(req) : {};
  // Revalida o operador após receber o corpo, inclusive após um bloqueio noutro dispositivo.
  const current = findSession(hash);
  if (!current) fail('Entre com seu usuário para continuar.',401);
  requirePairing(req,current,path);
  if(path.startsWith('site-sync/')) {
    let result;
    if(method==='GET' && path==='site-sync/list')result=siteSync.list(current);
    else if(method==='POST' && path==='site-sync/save')result=siteSync.save(current,body);
    else if(method==='POST' && path==='site-sync/remove')result=siteSync.remove(current,body.id);
    else if(method==='POST' && path==='site-sync/run')result=siteSync.request(current,body.id,{interactive:body.interactive===true});
    else fail('Recurso não encontrado.',404);
    return send(res,result);
  }
  if(path.startsWith('site-import/')) {
    let result;
    if(method==='GET' && path==='site-import/config') {
      if(current.role!=='admin')fail('A importação do site é exclusiva do administrador.',403);
      result={defaultUrl:require('./site-catalog').DEFAULT_URL};
    } else if(method==='GET' && path==='site-import/status') result=siteImports.status(current,searchParams.get('id'),searchParams.get('details')==='1');
    else if(method==='POST' && path==='site-import/analyze') result=siteImports.start(current,body);
    else if(method==='POST' && path==='site-import/html') result=siteImports.fromHtml(current,body);
    else if(method==='POST' && path==='site-import/cancel') result=siteImports.cancel(current,body.id);
    else if(method==='POST' && path==='site-import/apply') {
      result=await siteImports.apply(current,body,actor=>requirePairing(req,actor,path));
      if(result.created || result.updated)broadcast();
    } else fail('Recurso não encontrado.',404);
    return send(res,result);
  }
  if (requiresPairing(req) && path==='scan' && method==='POST') body.mode='paired';
  const result=route(current,method,path,body,searchParams,ip);
  send(res,result.data);
  if (result.changed) broadcast();
}

const listener = (req,res) => handle(req,res).catch(error=>{
  if (res.headersSent) return res.destroy();
  if (!(error instanceof Problem)) console.error(error);
  send(res,{error:error instanceof Problem ? error.message : 'Falha ao confirmar a operação. Confira o estado antes de tentar novamente.'},
    error instanceof Problem ? error.status : 500);
});
const server = tls ? https.createServer({cert:readFileSync(process.env.PDV_TLS_CERT),key:readFileSync(process.env.PDV_TLS_KEY)},listener) : createServer(listener);
const cleanup = setInterval(()=>{
  for (const [key,state] of attempts) if (state.until<Date.now()) attempts.delete(key);
},300000);
cleanup.unref();
server.listen(port,host,()=>{
  const address = server.address();
  const printed = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? 'localhost' : host;
  backups.start(result=>audit(null,result.error?'backup.falha':'backup.automatico','backup',null,null,{file:result.file},result.error ?? null));
  siteSync.start();
  console.log(`Balcão PDV • ${tls ? 'https' : 'http'}://${printed}:${address.port}`);
});
async function stop() {
  await siteSync.close();
  await siteImports.close();
  reportPool.close();
  for (const streams of clients.values()) for (const response of streams) response.end();
  clients.clear();
  server.close(()=>process.exit());
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);
