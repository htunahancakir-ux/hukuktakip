const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateNewClientPayouts, appendClientPayout } = require('../lib/client-payout.cjs');
const { handleDataRoutes } = require('../outputs/icrapro/access-data.cjs');
const actor = { id: 'ceo', name: 'Test', role: 'ceo' };
function fixture() {
  return { data: {
    'icrapro-v1': { docs: [{ id: 'd', client: 'c', status: 'İnfaz', amount: 1000, closedDate: '2026-01-01' }] },
    'hanhukuk-finance-v1': [{ id: 'collection', documentId: 'd', type: 'payment', amount: 100000 }],
    'hanhukuk-accounting-v1': { accounts: [{ id: 'cash', name: 'Kasa' }], entries: [{ id: 'deposit', type: 'in', accountId: 'cash', amount: 100000 }] }
  } };
}
function payment(amount, id = 'p') {
  return { id, type: 'clientPayout', documentId: 'd', clientId: 'c', accountId: 'cash', amount, date: '2026-01-02', note: 'Ödeme' };
}
function ledger(state, ...entries) {
  const result = structuredClone(state.data['hanhukuk-accounting-v1']);
  result.entries.push(...entries); return result;
}
test('Successive partial payments and final balance preserve finance events', () => {
  const state = fixture(), originalEvents = structuredClone(state.data['hanhukuk-finance-v1']);
  for (const [amount,id] of [[30000,'a'],[20000,'b'],[50000,'c']]) {
    const next = ledger(state, payment(amount,id)); validateNewClientPayouts(state,next,actor);
    state.data['hanhukuk-accounting-v1'] = next;
  }
  assert.equal(state.data['hanhukuk-accounting-v1'].entries.filter(e=>e.type==='clientPayout').reduce((s,e)=>s+e.amount,0),100000);
  assert.deepEqual(state.data['hanhukuk-finance-v1'],originalEvents);
  assert.throws(()=>validateNewClientPayouts(state,ledger(state,payment(1,'over')),actor),{code:400});
});
test('Reject invalid amounts, overpayment and insufficient funds', () => {
  for (const amount of [0,-1,0.5,100001,Number.MAX_SAFE_INTEGER+1]) {
    const state=fixture(); assert.throws(()=>validateNewClientPayouts(state,ledger(state,payment(amount)),actor),{code:400});
  }
  const state=fixture();state.data['hanhukuk-accounting-v1'].entries[0].amount=5000;
  assert.throws(()=>validateNewClientPayouts(state,ledger(state,payment(10000)),actor),{code:400});
});
test('Reject ineligible document, incorrect client and invalid date', () => {
  for(const change of [{clientId:'wrong'},{date:'2026-02-30'},{date:'2099-01-01'},{date:'2025-12-31'},{note:''}]) {
    const state=fixture(); assert.throws(()=>validateNewClientPayouts(state,ledger(state,{...payment(10000),...change}),actor),{code:400});
  }
  const state=fixture();state.data['icrapro-v1'].docs[0].status='Derdest';
  assert.throws(()=>validateNewClientPayouts(state,ledger(state,payment(10000)),actor),{code:400});
});
test('Legacy paid amount and parking commission reduce entitlement', () => {
  const state=fixture();state.data['icrapro-v1'].docs[0].clientPaidAmount=200;
  assert.throws(()=>validateNewClientPayouts(state,ledger(state,payment(80001)),actor),{code:400});
  validateNewClientPayouts(state,ledger(state,payment(80000)),actor);
  const parking=fixture();Object.assign(parking.data['icrapro-v1'].docs[0],{docType:'Yediemin Park Ücreti',parkingCommissionRate:20});
  assert.throws(()=>validateNewClientPayouts(parking,ledger(parking,payment(80001)),actor),{code:400});
  validateNewClientPayouts(parking,ledger(parking,payment(80000)),actor);
});
test('Reject batch overpayment, duplicated IDs and changing old ledger entries', () => {
  const state=fixture();
  for(const entries of [[payment(60000,'a'),payment(60000,'b')],[payment(10000),payment(10000)]])
    assert.throws(()=>validateNewClientPayouts(state,ledger(state,...entries),actor),{code:400});
  const next=ledger(state,payment(10000));next.entries[0].amount+=10000;
  assert.throws(()=>validateNewClientPayouts(state,next,actor),{code:400});
  const valid=ledger(state,{...payment(10000),operatorId:'forged'});validateNewClientPayouts(state,valid,actor);
  assert.equal(valid.entries.at(-1).operatorId,'ceo');
});
test('Accounting route validates partial payout and rejects stale ETag', async () => {
  const state=fixture();let version=1,persisted=0;
  const request=async(value,tag)=>{
    const ctx={state,dataKeys:['hanhukuk-accounting-v1'],u:actor,req:{method:'PUT',headers:{'if-match':tag}},res:{},url:new URL('http://localhost/api/data?key=hanhukuk-accounting-v1'),options:{requireRevision:true},revision:()=>JSON.stringify(version),body:async()=>({value}),fail:(code,message)=>Object.assign(Error(message),{code}),persist:next=>{state.data=next.data;version++;persisted++;},send:(res,status)=>{res.status=status;}};
    await handleDataRoutes(ctx);return ctx.res;
  };
  assert.equal((await request(ledger(state,payment(30000)),'1')).status,200);
  assert.equal(persisted,1);
  await assert.rejects(request(ledger(state,payment(20000,'b')),'1'),{code:409});
  await assert.rejects(request(ledger(state,payment(70001,'b')),'2'),{code:400});
  assert.equal(persisted,1);
});

test('Atomic payout preserves intervening ledger changes and retries only once', async () => {
  let state=fixture(), writes=0;
  state.data['hanhukuk-accounting-v1'].entries.push({id:'intervening',type:'in',accountId:'cash',amount:100});
  const request=async(input,user=actor)=>{
    const ctx={state,u:user,req:{method:'POST',headers:{'if-match':'obsolete'}},res:{},url:new URL('http://localhost/api/client-payout'),body:async()=>input,persist:next=>{state=next;writes++;},send:(res,status)=>{res.status=status;}};
    await handleDataRoutes(ctx);return ctx.res.status;
  };
  const original=structuredClone(state);
  await assert.rejects(request(payment(60000),{...actor,role:'staff'}),{code:403});
  assert.deepEqual(state,original);
  assert.equal(await request(payment(60000)),200);
  assert.equal(await request(payment(60000)),200);
  assert.equal(writes,1);
  assert.deepEqual(state.data['hanhukuk-accounting-v1'].entries.slice(0,2),original.data['hanhukuk-accounting-v1'].entries);
  await assert.rejects(request(payment(50000,'second')),{code:400});
  await assert.rejects(request(payment(50000)),{code:409});
  assert.equal(writes,1);
  assert.equal(await request(payment(40000,'final')),200);
  assert.equal(writes,2);
});

test('Payout checks account balance after excluded finance events',()=>{
  const state=fixture();state.data['hanhukuk-accounting-v1'].entries=[];
  state.data['hanhukuk-finance-v1'][0].accountId='cash';
  state.data['hanhukuk-accounting-v1'].excludedFinanceIds=['collection'];
  assert.throws(()=>appendClientPayout(state,payment(100),actor),{code:400});
});

test('Full payout selection fills remaining amount and restores typed partial amount', () => {
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require('node:path').join(__dirname,'../outputs/icrapro/finance-operations.js'),'utf8');
 const helper=source.slice(source.indexOf('function configureClientPayoutAmount'),source.indexOf('function clientPayoutForm(id)'));
 const ctx={formatAmountInput:v=>String(v)};vm.createContext(ctx);vm.runInContext(helper,ctx);
 let change,updates=0;
 const amount={value:'250',_moneyProxy:{value:'250',setCustomValidity(v){this.error=v;}}};
 const mode={value:'partial',addEventListener(event,handler){change=handler;}};
 ctx.configureClientPayoutAmount({elements:{amount,paymentMode:mode}},100000,()=>updates++);
 assert.equal(amount.max,'1000');
 mode.value='full';change();assert.equal(amount.value,'1000');assert.equal(amount.readOnly,true);assert.equal(amount._moneyProxy.value,'1000');assert.equal(amount._moneyProxy.readOnly,true);
 mode.value='partial';change();assert.equal(amount.value,'250');assert.equal(amount.readOnly,false);assert.equal(amount._moneyProxy.value,'250');assert.equal(amount._moneyProxy.readOnly,false);assert.equal(updates,2);
 amount.value='';mode.value='full';change();mode.value='partial';change();assert.equal(amount.value,'');
});

test('Accounting save displays the actual rejection and does not change local balance',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'../outputs/icrapro/workspace-accounting.js'),'utf8');const helper=source.slice(source.indexOf('function saveAccounting'),source.indexOf('function accountOptions'));
 let message='';const accounting={entries:[]};const ctx={accounting,localStorage:{setItem(){throw Error('Kayıt başka bir işlemle değişti. Sayfayı yenileyip tekrar deneyin.');}},toast:value=>message=value};vm.createContext(ctx);vm.runInContext(helper,ctx);assert.equal(ctx.saveAccounting({entries:[{amount:100}]}),false);assert.equal(ctx.accounting,accounting);assert(message.includes('Kayıt başka bir işlemle değişti'));
});

test('Client debtor report shows client entitlement, partial payouts and remaining instead of borrower collections',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const read=name=>fs.readFileSync(path.join(__dirname,'../outputs/icrapro',name),'utf8');
 const finance=read('finance-operations.js'), reports=read('workspace-reports.js');
 const document={id:'d',client:'c',debtor:'Test',amount:1000,status:'İnfaz',created:'2026-01-01'};
 const ctx={db:{clients:[{id:'c',name:'Test Client'}],docs:[document]},personnel:[],accounting:{accounts:[],entries:[]},
   financeCents:v=>Math.round(Number(v||0)*100),docFinance:()=>({principal:100000,received:150000,remaining:0}),
   debtorStatus:d=>d.status,displayDate:v=>v,isParkingDocument:d=>d.docType==='Yediemin Park Ücreti',
   validParkingRate:d=>Number.isFinite(d.parkingCommissionRate),parkingCommission:(amount,rate)=>Math.round(amount*rate/100)};
 vm.createContext(ctx);
 vm.runInContext(finance.slice(finance.indexOf('function clientPayoutTotals(d)'),finance.indexOf('function clientPayoutSection(d)')),ctx);
 vm.runInContext(reports.slice(0,reports.indexOf('function filterReportRows')),ctx);
 const check=(expected)=>{const cells=ctx.reportRows('clientDebtorInfo')[0].cells;assert.equal(Object.hasOwn(cells,'clientEntitlement'),false);assert.equal(cells.clientPaid,expected[1]);assert.equal(cells.clientRemaining,expected[2]);assert.equal(Object.hasOwn(cells,'received'),false);};
 check([100000,0,100000]);
 ctx.accounting.entries.push({id:'p1',type:'clientPayout',documentId:'d',amount:25000});check([100000,25000,75000]);
 document.clientPaidAmount=100;check([100000,35000,65000]);
 ctx.accounting.entries.push({id:'p2',type:'clientPayout',documentId:'d',amount:65000});check([100000,100000,0]);
 Object.assign(document,{docType:'Yediemin Park Ücreti',parkingCommissionRate:20,clientPaidAmount:0});ctx.accounting.entries=[];check([120000,0,120000]);
});
