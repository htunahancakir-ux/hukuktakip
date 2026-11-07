const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateNewClientPayouts } = require('../lib/client-payout.cjs');
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
