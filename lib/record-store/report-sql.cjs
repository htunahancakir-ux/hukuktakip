const definitions = require('../../outputs/icrapro/report-definitions.js');
const number = (expression) => `coalesce(nullif(${expression},'')::numeric,0)`;
const cents = (expression) => `round(${number(expression)}*100)`;
const text = (expression, fallback = '') => `coalesce(nullif(${expression},''),'${fallback}')`;
const date = (expression) => `han_data.report_date(${expression})`;
const displayDate = (expression) =>
  `CASE WHEN ${expression} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN substring(${expression} FROM 9 FOR 2)||'/'||substring(${expression} FROM 6 FOR 2)||'/'||left(${expression},4) ELSE ${expression} END`;
const common = {
  number: 'd.number',
  client: "coalesce(c.name,'—')",
  debtor: "d.body->>'debtor'",
};
const documentJoin = `LEFT JOIN han_data.documents d ON d.id=e.document_id AND d.active
  LEFT JOIN han_data.clients c ON c.id=d.client_id AND c.active`;
const documentFrom = `han_data.documents d LEFT JOIN han_data.clients c ON c.id=d.client_id AND c.active
  LEFT JOIN han_data.personnel p ON p.id=d.staff_id AND p.active`;
const balanceJoin = ' LEFT JOIN han_data.document_balances b ON b.document_id=d.id';
const paymentStaff =
  "coalesce(nullif(e.body->>'turnoverStaffId',''),nullif(e.body->>'collectionStaffId',''),d.staff_id,'')";
const paymentStaffName = `coalesce(nullif(e.body->>'turnoverStaffName',''),nullif(e.body->>'collectionStaffName',''),p.body->>'name','—')`;
const operatorName = "coalesce(nullif(e.body->>'operatorName',''),p.body->>'name','—')";
const accountName = "coalesce(nullif(e.body->>'accountName',''),a.body->>'name','Belirtilmedi')";
const operatorJoin = " LEFT JOIN han_data.personnel p ON p.id=e.body->>'operatorId' AND p.active";
const accountJoin = ' LEFT JOIN han_data.accounts a ON a.id=e.account_id AND a.active';

// Revenue is recognized on the last closing payment, using the entire payment
// history even when the displayed report covers only a narrower date range.
const revenueCTE = `payment_totals AS (
  SELECT document_id,sum(amount_cents) AS received,
    (array_agg(id ORDER BY ordinal DESC,id DESC))[1] AS last_id,
    (array_agg(id ORDER BY ordinal DESC,id DESC) FILTER(WHERE body->>'closes'='true'))[1] AS closing_id,
    sum(coalesce((body->>'revenuePart')::numeric,0)) AS legacy_revenue
  FROM han_data.financial_events WHERE active AND kind='payment' GROUP BY document_id
), revenues AS (
  SELECT e.id,e.document_id,CASE WHEN d.status='İade' THEN e.amount_cents
    WHEN e.id=CASE WHEN d.status='İnfaz' THEN t.last_id ELSE t.closing_id END THEN
      CASE WHEN nullif(e.body->>'parkingCommissionRate','') IS NOT NULL OR d.kind='Yediemin Park Ücreti'
        THEN round(t.received*coalesce(nullif(e.body->>'parkingCommissionRate','')::numeric,nullif(d.body->>'parkingCommissionRate','')::numeric,0)/100)
        WHEN e.body->>'principalAtCollection' IS NOT NULL OR d.id IS NOT NULL THEN
          greatest(0,t.received-coalesce((e.body->>'principalAtCollection')::numeric,${cents("d.body->>'amount'")}))
        ELSE t.legacy_revenue END ELSE 0 END AS revenue
  FROM han_data.financial_events e JOIN payment_totals t ON t.document_id=e.document_id
  LEFT JOIN han_data.documents d ON d.id=e.document_id AND d.active WHERE e.active AND e.kind='payment'
)`;
const payoutCTE = `payouts AS (SELECT document_id,sum(amount_cents) AS paid
  FROM han_data.ledger_entries WHERE active AND kind='clientPayout' GROUP BY document_id)`;
const payoutPaid = `(${cents("d.body->>'clientPaidAmount'")}+coalesce(pay.paid,0))`;
const entitlement = `CASE WHEN d.kind='Yediemin Park Ücreti' THEN
  CASE WHEN nullif(d.body->>'parkingCommissionRate','') IS NOT NULL AND (d.body->>'parkingCommissionRate')::numeric BETWEEN 0 AND 100
  THEN greatest(0,b.received_cents-round(b.received_cents*(d.body->>'parkingCommissionRate')::numeric/100)) ELSE 0 END
  ELSE b.principal_cents END`;

// Every identifier/expression comes from this fixed registry. Request values
// are added only as bound parameters by reports.cjs.
function row(
  type,
  {
    from,
    where = '',
    id = 'd.id',
    date: day = "d.body->>'created'",
    client = "coalesce(d.client_id,'')",
    staff = "coalesce(d.staff_id,'')",
    status = "coalesce(d.status,'')",
    account = "''",
    document = 'd.id',
    cells,
  },
) {
  const money = new Set(definitions[type].columns.filter((c) => c[2] === 'money').map((c) => c[0]));
  const projection = Object.entries(cells)
    .flatMap(([key, value]) => [`'${key}'`, money.has(key) ? `(${value})::text` : value])
    .join(',');
  return `SELECT (${id})::text AS id,${date(day)} AS date,${client} AS client_id,${staff} AS staff_id,
    ${status} AS status,${account} AS account_id,${document} AS document_id,jsonb_build_object(${projection}) AS cells
    FROM ${from}${where ? ' WHERE ' + where : ''}`;
}
function source(type) {
  let cte = '';
  let sql;
  if (type === 'documents') {
    cte =
      revenueCTE +
      `, profits AS (SELECT e.document_id,sum(coalesce(r.revenue,0)-CASE WHEN e.kind IN ('expense','costOnly') THEN e.amount_cents ELSE 0 END) AS profit
      FROM han_data.financial_events e LEFT JOIN revenues r ON r.id=e.id WHERE e.active GROUP BY e.document_id)`;
    sql = row(type, {
      from: documentFrom + balanceJoin + ' LEFT JOIN profits f ON f.document_id=d.id',
      where: 'd.active',
      cells: {
        ...common,
        type: 'd.kind',
        status: 'd.status',
        original: text("d.body->>'originalDocument'", 'Belirtilmedi'),
        staff: "coalesce(p.body->>'name','—')",
        principal: 'b.principal_cents',
        total: 'b.target_cents',
        received: 'b.received_cents',
        remaining: 'b.remaining_cents',
        profit: 'coalesce(f.profit,0)',
      },
    });
  } else if (type === 'excel' || type === 'finance') {
    cte = revenueCTE;
    const payment = "e.kind='payment'",
      expense = "CASE WHEN e.kind IN ('expense','costOnly') THEN e.amount_cents ELSE 0 END";
    sql = row(type, {
      from: `han_data.financial_events e ${documentJoin}${accountJoin}
      LEFT JOIN han_data.personnel p ON p.id=CASE WHEN ${payment} THEN ${paymentStaff} ELSE e.body->>'operatorId' END AND p.active
      LEFT JOIN revenues r ON r.id=e.id`,
      where: 'e.active' + (type === 'excel' ? " AND e.kind='payment'" : ''),
      id: "'finance:'||e.id",
      date: 'e.occurred_on',
      staff: `CASE WHEN ${payment} THEN ${paymentStaff} ELSE coalesce(nullif(e.body->>'operatorId',''),d.staff_id,'') END`,
      account: "coalesce(e.account_id,'')",
      cells:
        type === 'excel'
          ? {
              account: accountName,
              number: 'd.number',
              trackingDate: displayDate(
                `coalesce(nullif(d.body->>'trackingDate',''),${date("d.body->>'created'")})`,
              ),
              principal: `coalesce((e.body->>'principalAtCollection')::numeric,${cents("d.body->>'amount'")})`,
              collection: 'e.amount_cents',
              gross: 'coalesce(r.revenue,0)',
              debtor: "d.body->>'debtor'",
              creditor: "coalesce(nullif(c.body->>'tradeName',''),c.name)",
              staff: `coalesce(nullif(e.body->>'turnoverStaffName',''),nullif(e.body->>'collectionStaffName',''),p.body->>'name',d.body->>'relatedStaffName')`,
              status: "coalesce(d.status,'')",
              department: "p.body->>'department'",
            }
          : {
              ...common,
              kind: `CASE WHEN ${payment} THEN 'Tahsilat' WHEN e.kind='costOnly' THEN 'Borca eklenmeyen masraf' ELSE 'Borçlu masrafı' END`,
              account: accountName,
              staff: `CASE WHEN ${payment} THEN ${paymentStaffName} ELSE ${operatorName} END`,
              category: `CASE WHEN (${expense})<>0 THEN 'Borçlu Masrafı' ELSE '—' END`,
              collection: `CASE WHEN ${payment} THEN e.amount_cents ELSE 0 END`,
              revenue: 'coalesce(r.revenue,0)',
              expense,
              profit: `coalesce(r.revenue,0)-(${expense})`,
              note: "e.body->>'note'",
            },
    });
    if (type === 'finance')
      sql +=
        ' UNION ALL ' +
        row(type, {
          from: 'han_data.ledger_entries e' + accountJoin + operatorJoin,
          where: "e.active AND e.kind='out' AND nullif(e.body->>'financeEventId','') IS NULL",
          id: "'ledger:'||e.id",
          date: 'e.occurred_on',
          client: "''",
          staff: text("e.body->>'operatorId'"),
          status: "''",
          account: text('e.account_id'),
          document: 'NULL::text',
          cells: {
            kind: "'Muhasebe gideri'",
            account: "coalesce(a.body->>'name','Belirtilmedi')",
            staff: operatorName,
            category: text("e.body->>'expenseCategory'", 'Belirtilmedi'),
            collection: '0',
            revenue: '0',
            expense: 'e.amount_cents',
            profit: '-e.amount_cents',
            note: "e.body->>'note'",
          },
        });
  } else if (type === 'clientPayouts') {
    sql = row(type, {
      from: `han_data.ledger_entries e ${documentJoin}${accountJoin}${operatorJoin}`,
      where: "e.active AND e.kind='clientPayout'",
      id: 'e.id',
      date: 'e.occurred_on',
      staff: text("e.body->>'operatorId'"),
      account: text('e.account_id'),
      cells: {
        ...common,
        account: accountName,
        staff: operatorName,
        amount: 'e.amount_cents',
        note: "e.body->>'note'",
      },
    });
  } else if (type === 'clientDebtorInfo') {
    cte = payoutCTE;
    const asset = (k) =>
      `CASE WHEN nullif(d.body->>'${k}Status','') IS NULL THEN 'Belirtilmedi' ELSE d.body->>'${k}Status'||CASE WHEN d.body->>'${k}Status'='Var' AND nullif(d.body->>'${k}Details','') IS NOT NULL THEN ' · '||(d.body->>'${k}Details') ELSE '' END END`;
    sql = row(type, {
      from:
        documentFrom +
        balanceJoin +
        ' LEFT JOIN payouts pay ON pay.document_id=d.id' +
        ` LEFT JOIN LATERAL (SELECT count(*)::text AS count FROM han_data.conversations v WHERE v.active AND v.document_id=d.id) notes ON true`,
      where: 'd.active',
      date: "coalesce(nullif(d.due_on,''),d.body->>'created')",
      cells: {
        status: 'd.status',
        debtor: "d.body->>'debtor'",
        due: `coalesce(nullif(${displayDate('d.due_on')},''),'—')`,
        principal: 'b.principal_cents',
        enforcement: "CASE WHEN d.status='İcra' THEN 'İcra Açıldı' ELSE '- İdari Takip' END",
        identity: text("d.body->>'identity'", '—'),
        sgk: asset('sgk'),
        vehicle: asset('vehicle'),
        tapu: asset('tapu'),
        clientPaid: payoutPaid,
        clientRemaining: `greatest(0,(${entitlement})-${payoutPaid})`,
        note: "CASE WHEN d.body->'conversationReport'->>'version'='2' AND d.body->'conversationReport'->>'sourceCount'=notes.count THEN left(coalesce(d.body->'conversationReport'->>'text',''),300) ELSE '' END",
        reportPending:
          "(notes.count<>'0' AND (d.body->'conversationReport'->>'version' IS DISTINCT FROM '2' OR d.body->'conversationReport'->>'sourceCount' IS DISTINCT FROM notes.count))",
      },
    });
  } else if (type === 'calls') {
    sql = row(type, {
      from: `han_data.conversations e JOIN han_data.documents d ON d.id=e.document_id AND d.active
      LEFT JOIN han_data.clients c ON c.id=d.client_id AND c.active LEFT JOIN han_data.personnel p ON p.id=e.body->'value'->>'staff' AND p.active`,
      where: 'e.active',
      id: 'e.id',
      date: "e.body->'value'->>'date'",
      staff: text("e.body->'value'->>'staff'"),
      cells: {
        ...common,
        time: "e.body->'value'->>'time'",
        staff: "coalesce(nullif(e.body->'value'->>'staffName',''),p.body->>'name','—')",
        result: "e.body->'value'->>'result'",
        note: "e.body->'value'->>'note'",
      },
    });
  } else if (type === 'installments') {
    const amount = "(v.value->>'amount')::numeric",
      paid = `least(greatest(0,b.received_cents-${number("d.body->'repaymentPlan'->>'receivedAtCreation'")}-coalesce(v.previous,0)),${amount})`;
    const status = `CASE WHEN (${paid})=${amount} THEN 'Ödendi' WHEN v.value->>'due'<$1 THEN 'Gecikmiş' WHEN (${paid})<>0 THEN 'Kısmi Ödendi' ELSE 'Bekliyor' END`;
    sql = row(type, {
      from:
        documentFrom +
        balanceJoin +
        ` CROSS JOIN LATERAL (SELECT value,ordinality,sum((value->>'amount')::numeric) OVER(ORDER BY ordinality ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous FROM jsonb_array_elements(coalesce(d.body->'repaymentPlan'->'installments','[]'::jsonb)) WITH ORDINALITY) v`,
      where: 'd.active',
      id: "d.id||':'||v.ordinality",
      date: "v.value->>'due'",
      status,
      cells: {
        ...common,
        sequence: 'v.ordinality',
        method: "CASE WHEN d.body->'repaymentPlan'->>'method'='equal' THEN 'Eşit' ELSE 'Manuel' END",
        amount,
        paid,
        remaining: `${amount}-(${paid})`,
        status,
      },
    });
  } else if (type === 'discounts' || type === 'guarantors') {
    const field = type === 'discounts' ? 'discountHistory' : 'guarantors';
    sql = row(type, {
      from:
        documentFrom +
        ` CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.body->'${field}','[]'::jsonb)) WITH ORDINALITY v(value,ordinality)`,
      where: 'd.active',
      id: "d.id||':'||v.ordinality",
      date: `v.value->>'${type === 'discounts' ? 'date' : 'createdAt'}'`,
      cells:
        type === 'discounts'
          ? {
              ...common,
              before: number("v.value->>'before'"),
              discount: number("v.value->>'amount'"),
              after: number("v.value->>'after'"),
              note: "v.value->>'reason'",
            }
          : {
              ...common,
              name: "v.value->>'name'",
              identity: "v.value->>'identity'",
              phone: "coalesce(nullif(v.value->>'phone1',''),v.value->>'phone')",
              phone2: "v.value->>'phone2'",
              city: "v.value->>'city'",
              district: "v.value->>'district'",
              address: "v.value->>'address'",
              tapu: text("v.value->>'tapuStatus'", 'Belirtilmedi'),
              vehicle: text("v.value->>'vehicleStatus'", 'Belirtilmedi'),
              sgk: text("v.value->>'sgkStatus'", 'Belirtilmedi'),
            },
    });
  } else if (type === 'clients' || type === 'clientList') {
    if (type === 'clients')
      cte =
        payoutCTE +
        `, client_totals AS (SELECT d.client_id,count(*) AS count,sum(${cents("d.body->>'amount'")}) AS principal,sum(${payoutPaid}) AS paid FROM han_data.documents d LEFT JOIN payouts pay ON pay.document_id=d.id WHERE d.active GROUP BY d.client_id)`;
    sql = row(type, {
      from:
        'han_data.clients c' + (type === 'clients' ? ' LEFT JOIN client_totals t ON t.client_id=c.id' : ''),
      where: 'c.active',
      id: 'c.id',
      date: "coalesce(nullif(c.body->>'createdAt',''),c.body->>'created')",
      client: 'c.id',
      staff: text("c.body->>'collectionStaff'"),
      status: "''",
      document: 'NULL::text',
      cells:
        type === 'clients'
          ? {
              name: 'c.name',
              category: "c.body->>'clientCategory'",
              type: "c.body->>'type'",
              identity: "c.body->>'identity'",
              phone: "c.body->>'phone'",
              city: "c.body->>'city'",
              district: "c.body->>'district'",
              count: 'coalesce(t.count,0)',
              principal: 'coalesce(t.principal,0)',
              paid: 'coalesce(t.paid,0)',
            }
          : {
              name: "coalesce(c.body->>'fullName',CASE WHEN coalesce(c.body->>'type','Şahıs')='Şahıs' THEN c.name ELSE '' END)",
              category: text("c.body->>'clientCategory'"),
              tradeName:
                "coalesce(c.body->>'tradeName',CASE WHEN coalesce(c.body->>'type','Şahıs')<>'Şahıs' THEN c.name ELSE '' END)",
              city: text("c.body->>'city'"),
              district: text("c.body->>'district'"),
            },
    });
  } else if (type === 'personnel') {
    const official = cents("p.body->>'officialSalary'"),
      unofficial = cents("p.body->>'unofficialSalary'"),
      bonus = cents("p.body->>'bonus'");
    sql = row(type, {
      from: 'han_data.personnel p',
      where: 'p.active',
      id: 'p.id',
      date: "p.body->>'createdAt'",
      client: "''",
      staff: 'p.id',
      status: "CASE WHEN p.body->>'active'='true' THEN 'Aktif' ELSE 'Pasif' END",
      document: 'NULL::text',
      cells: {
        name: "p.body->>'name'",
        department: "p.body->>'department'",
        status: "CASE WHEN p.body->>'active'='true' THEN 'Aktif' ELSE 'Pasif' END",
        phone: "p.body->>'phone'",
        official,
        unofficial,
        salary: `${official}+${unofficial}`,
        bonus,
        total: `${official}+${unofficial}+${bonus}`,
      },
    });
  } else if (type === 'accounts') {
    cte = require('./account-movements.cjs').movementCTE;
    sql = row(type, {
      from: `movements e ${documentJoin}${accountJoin}${operatorJoin}`,
      id: 'e.id',
      date: 'e.occurred_on',
      staff: text("e.body->>'operatorId'"),
      account: text('e.account_id'),
      cells: {
        account: "coalesce(a.body->>'name','Belirtilmedi')",
        kind: 'e.label',
        category: text("e.body->>'expenseCategory'", '—'),
        staff: operatorName,
        incoming: 'greatest(0,e.signed)',
        outgoing: 'greatest(0,-e.signed)',
        note: "e.body->>'note'",
      },
    });
  } else throw Object.assign(Error('Rapor türü geçersiz.'), { status: 400 });
  return { cte, sql };
}
module.exports = { source, revenueCTE, date, displayDate, payoutCTE, payoutPaid, entitlement };
