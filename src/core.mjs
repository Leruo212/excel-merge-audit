import { createHash } from 'node:crypto';

export const DEFAULT_ALIASES = {
  order_id: ['order_id', '订单号', '订单编号'],
  line_id: ['line_id', '行号', '明细行'],
  date: ['date', '日期', '下单日期'],
  customer: ['customer', '客户', '客户名称'],
  sku: ['sku', '商品编码'],
  quantity: ['quantity', '数量', '件数'],
  unit_price: ['unit_price', '单价', '单价(元)'],
  amount: ['amount', '金额', '订单金额', '金额(元)'],
  currency: ['currency', '币种', '货币'],
  status: ['status', '状态', '订单状态'],
};

export const normalizeText = (value) => value == null || typeof value === 'object'
  ? '' : String(value).normalize('NFKC').trim();

const headerName = (value) => normalizeText(value).toLowerCase().replace(/\s/g, '');
const fields = Object.keys(DEFAULT_ALIASES);
const aliases = new Map(Object.entries(DEFAULT_ALIASES).flatMap(([field, names]) => names.map((name) => [headerName(name), field])));

export function parseMoney(value) {
  const text = normalizeText(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parseDate(value) {
  const text = normalizeText(value);
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function sourceRow(sheet, raw, index) {
  const source = { file: sheet.file, sha256: sheet.sha256, sheet: sheet.sheet, row: index + 1 };
  return {
    id: createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24),
    source,
    raw: structuredClone(raw),
    values: {},
    issues: [],
    disposition: 'review',
  };
}

function parseValues(raw, mapping) {
  const values = Object.fromEntries(fields.map((field) => [field, normalizeText(raw[mapping[field]])]));
  values.date = parseDate(values.date);
  values.quantity = /^-?\d+$/.test(values.quantity) ? Number(values.quantity) : null;
  values.unit_price_cents = parseMoney(values.unit_price);
  values.amount_cents = parseMoney(values.amount);
  const statuses = { 已完成: 'paid', 已支付: 'paid', paid: 'paid', 退货: 'refunded', refunded: 'refunded', 已取消: 'cancelled', cancelled: 'cancelled' };
  values.status = statuses[values.status.toLowerCase()] ?? null;
  values.currency = ['CNY', 'RMB', '人民币', '元'].includes(values.currency.toUpperCase()) ? 'CNY' : values.currency;
  const issues = [];
  for (const field of ['order_id', 'line_id', 'date', 'customer', 'sku', 'quantity', 'unit_price_cents', 'amount_cents', 'status']) {
    if (values[field] === '' || values[field] === null) issues.push({ code: 'INVALID_VALUE', message: `${field} 缺失或格式错误` });
  }
  if (values.currency !== 'CNY') issues.push({ code: 'CURRENCY', message: '仅支持 CNY 人民币' });
  if (values.unit_price_cents !== null && values.quantity !== null && values.amount_cents !== null && values.quantity * values.unit_price_cents !== values.amount_cents) {
    issues.push({ code: 'AMOUNT_MISMATCH', message: '金额不等于数量乘单价' });
  }
  return { values, issues };
}

export function mergeSheets(sheets, { corrections = [] } = {}) {
  if (corrections.length) throw new Error('当前版本尚不支持人工修正');
  const out = { accepted: [], duplicates: [], review: [], skipped: [], sources: [], schemaIssues: [] };
  const seen = new Map();
  for (const sheet of sheets) {
    const header = sheet.rows[0] ?? [];
    const mapping = {};
    header.forEach((value, i) => { if (aliases.has(headerName(value))) mapping[aliases.get(headerName(value))] = i; });
    const schemaOK = fields.every((field) => field in mapping);
    if (!schemaOK) out.schemaIssues.push({ file: sheet.file, sheet: sheet.sheet, code: 'MISSING_COLUMNS', message: '缺少必要列' });
    sheet.rows.forEach((raw, index) => {
      const record = sourceRow(sheet, raw, index);
      out.sources.push(record);
      if ((index === 0 && schemaOK) || raw.every((value) => normalizeText(value) === '')) {
        record.disposition = 'skipped';
        record.issues = [{ code: index === 0 ? 'HEADER' : 'EMPTY', message: index === 0 ? '表头' : '空行' }];
        out.skipped.push(record);
        return;
      }
      if (!schemaOK) {
        record.issues = [{ code: 'SCHEMA', message: '工作表缺少必要列，未猜测字段' }];
        out.review.push(record);
        return;
      }
      Object.assign(record, parseValues(raw, mapping));
      if (record.issues.length) {
        out.review.push(record);
        return;
      }
      const key = JSON.stringify([record.values.order_id, record.values.line_id]);
      if (seen.has(key)) {
        record.disposition = 'duplicate';
        record.duplicateOf = seen.get(key).id;
        out.duplicates.push(record);
      } else {
        record.disposition = 'accepted';
        seen.set(key, record);
        out.accepted.push(record);
      }
    });
  }
  const sum = (rows) => rows.reduce((total, row) => total + (row.values.amount_cents ?? 0), 0);
  const dataRows = [...out.accepted, ...out.duplicates, ...out.review];
  out.summary = {
    inputRows: dataRows.length,
    acceptedRows: out.accepted.length,
    duplicateRows: out.duplicates.length,
    reviewRows: out.review.length,
    skippedRows: out.skipped.length,
    acceptedAmountCents: sum(out.accepted),
    parsedInputAmountCents: sum(dataRows),
    duplicateAmountCents: sum(out.duplicates),
    reviewAmountCents: sum(out.review),
    unparseableAmounts: dataRows.filter((row) => row.values.amount_cents == null).length,
  };
  return out;
}
