const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');

process.env.PDV_DB=':memory:';
const {db,run,get,all}=require('../db');
const ops=require('../operations');
const inventory=require('../inventory');
const actor={id:1,name:'Administrador',role:'admin'};
run("INSERT INTO users(id,username,name,password,role) VALUES(1,'admin','Administrador','test','admin')");
const base={name:'Produto',price:500,cost:null,stock:0,minimum:0};

test('alimentação e bebidas exigem uma data real, independentemente de acentos ou caixa',()=>{
  for (const category of ['Alimentação','ALIMENTACAO','Alimento','Alimentos','Bebida','BEBIDAS','Alimentação e bebidas']) {
    assert.throws(()=>ops.saveProduct(actor,{...base,code:'INVALIDO',category}),/Informe a data de validade/);
    for (const expires_on of ['2027-02-29','2026-04-31','30/06/2027','inválida']) {
      assert.throws(()=>ops.saveProduct(actor,{...base,code:'INVALIDO',category,expires_on}),/Data de validade inválida/);
    }
  }
  assert.equal(get("SELECT COUNT(*) n FROM products WHERE code='INVALIDO'").n,0);
});

test('validade é salva, consultada, preservada e atualizada na edição',()=>{
  const product=ops.saveProduct(actor,{...base,code:'SUCO',category:'Bebidas',expires_on:'2028-02-29'});
  assert.equal(ops.products(actor).find(row=>row.id===product.id).expires_on,'2028-02-29');
  const values={...base,code:'SUCO',category:'Bebidas'};
  assert.equal(ops.saveProduct(actor,values,product.id).expires_on,'2028-02-29');
  assert.throws(()=>ops.saveProduct(actor,{...values,expires_on:''},product.id),/Informe a data de validade/);
  ops.saveProduct(actor,{...values,expires_on:'2029-06-30'},product.id);
  assert.equal(get('SELECT expires_on FROM products WHERE id=?',product.id).expires_on,'2029-06-30');
});

test('outras categorias continuam sem validade; mudar para alimentação exige preenchimento',()=>{
  const product=ops.saveProduct(actor,{...base,code:'CARTA',category:'TCG'});
  assert.equal(product.expires_on,null);
  assert.throws(()=>ops.saveProduct(actor,{...base,code:'CARTA',category:'Alimentação'},product.id),/Informe a data de validade/);
  assert.equal(get('SELECT category FROM products WHERE id=?',product.id).category,'TCG');
});

test('CSV mostra erros antes de importar e preserva validade quando a coluna é omitida',()=>{
  const invalid=inventory.previewImport(actor,{mode:'create',csv:'codigo;nome;categoria;preco;estoque\nSEM;Suco;Bebidas;5;0'});
  assert.match(invalid.errors[0].error,/Informe a data de validade/);
  const csv='codigo;nome;categoria;preco;estoque;validade\nCSV;Lanche;Alimentação;5;0;2027-06-30';
  const preview=inventory.previewImport(actor,{mode:'create',csv});
  assert.equal(preview.errors.length,0);
  inventory.applyImport(actor,{mode:'create',csv,fingerprint:preview.fingerprint});
  assert.equal(get("SELECT expires_on FROM products WHERE code='CSV'").expires_on,'2027-06-30');
  const update='codigo;nome;categoria;preco;estoque\nCSV;Lanche;Alimentação;5;0';
  const next=inventory.previewImport(actor,{mode:'update',csv:update});
  assert.equal(next.errors.length,0);
  inventory.applyImport(actor,{mode:'update',csv:update,fingerprint:next.fingerprint});
  assert.equal(get("SELECT expires_on FROM products WHERE code='CSV'").expires_on,'2027-06-30');
  const blank=inventory.previewImport(actor,{mode:'update',csv:update.replace('estoque\n','estoque;validade\n')+';'});
  assert.match(blank.errors[0].error,/Informe a data de validade/);
});

test('migração de banco existente preserva produtos e pode executar novamente',()=>{
  const legacy=new DatabaseSync(':memory:');
  try {
    legacy.exec("CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO products VALUES(1,'Lanche'); PRAGMA user_version=3;");
    const {migrate}=require('../migrations');
    migrate(legacy,':memory:',true);
    migrate(legacy,':memory:',true);
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version,6);
    const row=legacy.prepare('SELECT * FROM products').get();
    assert.equal(row.name,'Lanche');
    assert.equal(row.expires_on,null);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);
  } finally {legacy.close();}
});

test('formulário exige validade ao trocar categoria e lista exibe data brasileira',async()=>{
  const {productForm,updateProductExpiry}=await import('../modals.js');
  const {productRows}=await import('../views.js');
  const state={me:{...actor,permissions:{products:true,stock:true,operate:true}},products:all('SELECT *,stock available FROM products'),local:{productSearch:'',productStatus:''}};
  assert.match(productForm({category:'Bebidas'},state),/name="expires_on"[^>]*type="date" required/);
  assert.doesNotMatch(productForm({category:'TCG'},state),/name="expires_on"[^>]*required/);
  const hint={textContent:''};
  const form={elements:{category:{value:'ALIMENTAÇÃO'},expires_on:{}},querySelector:()=>hint};
  updateProductExpiry(form);
  assert.equal(form.elements.expires_on.required,true);
  form.elements.category.value='TCG';
  updateProductExpiry(form);
  assert.equal(form.elements.expires_on.required,false);
  assert.match(productRows(state),/30\/06\/2029/);
});
