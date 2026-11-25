const FIELDS = ['order_id', 'line_id', 'date', 'customer', 'sku', 'quantity', 'unit_price', 'amount', 'currency', 'status'];
const CHINESE = ['订单号', '行号', '下单日期', '客户名称', '商品编码', '数量', '单价', '订单金额', '币种', '订单状态'];
const ALTERNATIVE = ['订单编号', '明细行', '日期', '客户', 'SKU', '件数', '单价(元)', '金额(元)', '货币', '状态'];

export function makeDemo() {
  const truth = Array.from({ length: 120 }, (_, i) => {
    const quantity = i === 110 ? 0 : i === 111 ? -2 : 1 + i % 5;
    const priceCents = 1250 + i % 11 * 275;
    return {
      order_id: `SO-${String(i === 11 ? 11 : i + 1).padStart(4, '0')}`,
      line_id: i === 11 ? '2' : '1',
      date: `2026-11-${String(i % 25 + 1).padStart(2, '0')}`,
      customer: ['青禾文具', '远山书店', '星桥工作室', '松果商贸'][i % 4],
      sku: `SKU-${String(i % 9 + 1).padStart(3, '0')}`,
      quantity, unit_price: priceCents / 100, amount: quantity * priceCents / 100,
      currency: 'CNY', status: quantity < 0 ? 'refunded' : 'paid',
      cents: quantity * priceCents,
    };
  });
  const dirty = truth.map((record) => ({ ...record }));
  dirty[13].date = '11/12/2026';
  dirty[27].customer = '';
  dirty[38].amount += 1;
  dirty[59].amount = '12,34.00';
  dirty[73].amount = { formula: 'F3*G3', result: truth[73].amount };
  dirty[91].currency = 'USD';
  dirty[104].order_id = '';
  const duplicates = [0, 0, 0].map((i) => ({ ...dirty[i] }));
  const conflicts = [100, 200].map((delta) => ({ ...truth[5], unit_price: truth[5].unit_price + delta / 100, amount: truth[5].amount + truth[5].quantity * delta / 100 }));
  const workbooks = [];
  for (let batch = 0; batch < 10; batch++) {
    const fields = [...FIELDS];
    if (batch % 2) fields.reverse();
    const header = fields.map((field) => (batch % 3 === 0 ? FIELDS : batch % 3 === 1 ? CHINESE : ALTERNATIVE)[FIELDS.indexOf(field)]);
    const records = dirty.slice(batch * 12, batch * 12 + 12);
    if ([1, 4, 7].includes(batch)) records.push(duplicates[[1, 4, 7].indexOf(batch)]);
    if (batch === 2) records.push(conflicts[0]);
    if (batch === 8) records.push(conflicts[1]);
    const preface = batch % 3 ? [['模拟订单导出，不含真实客户数据'], ['金额单位：人民币元']] : [];
    const rows = [...preface, header];
    for (const [position, record] of records.entries()) {
      if (position === 4) rows.push([]);
      if (batch === 1 && position === 6) rows.push(header);
      rows.push(fields.map((field) => {
        let value = record[field];
        if (field === 'date' && /^\d{4}-/.test(value)) {
          const [y, m, d] = value.split('-');
          if (batch % 3 === 1) value = `${y}/${Number(m)}/${Number(d)}`;
          if (batch % 3 === 2) value = `${y}年${Number(m)}月${Number(d)}日`;
        }
        if (['unit_price', 'amount'].includes(field) && typeof value === 'number' && batch % 2) {
          value = `￥${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
        if (field === 'status') value = value === 'paid' ? '已支付' : '退货';
        if (field === 'currency' && value === 'CNY' && batch % 2) value = '人民币';
        if (field === 'customer' && value) value = ` ${value} `;
        return value;
      }));
    }
    rows.push(fields.map((field) => field === 'order_id' ? '合计' : field === 'amount' ? records.reduce((sum, row) => sum + (typeof row.amount === 'number' ? row.amount : 0), 0) : null));
    const definition = { name: '订单明细', rows, headerRow: preface.length + 1, widths: fields.map((field) => field === 'customer' ? 24 : 18) };
    workbooks.push({ file: `${String(batch + 1).padStart(2, '0')}-orders.xlsx`, spec: { sheets: [definition] } });
  }
  const invalidIndices = new Set([5, 13, 27, 38, 59, 73, 91, 104]);
  const accepted = truth.filter((_, i) => !invalidIndices.has(i));
  const expected = {
    notice: '所有客户、订单和金额均为模拟数据。控制值从生成前的业务真值独立计算，合并程序不得读取本文件。',
    files: 10, inputRows: 125, acceptedRows: 112, duplicateRows: 3, reviewRows: 10,
    acceptedAmountCents: accepted.reduce((sum, row) => sum + row.cents, 0),
    acceptedKeys: accepted.map((row) => `${row.order_id}|${row.line_id}`).sort(),
    invalidOriginalIndices: [...invalidIndices],
  };
  return { workbooks, expected };
}
