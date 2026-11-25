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
  let text = normalizeText(value);
  let negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  text = text.replace(/^(?:CNY\s*|RMB\s*|¥\s*)/i, '');
  if (text.startsWith('-')) {
    if (negative) return null;
    negative = true;
    text = text.slice(1);
  }
  const match = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.slice(2).replace(/0/g, '') ?? '')) return null;
  const whole = match[1].replace(/,/g, '');
  const fraction = (match[2] ?? '').padEnd(2, '0').slice(0, 2);
  let cents = BigInt(whole) * 100n + BigInt(fraction);
  if (negative) cents = -cents;
  return cents >= BigInt(Number.MIN_SAFE_INTEGER) && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function parseDate(value) {
  const text = normalizeText(value);
  const match = /^(\d{4})(?:-(\d{1,2})-(\d{1,2})|\/(\d{1,2})\/(\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] ?? match[4] ?? match[6]);
  const day = Number(match[3] ?? match[5] ?? match[7]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceRow(sheet, raw, index) {
  const source = { file: sheet.file, sha256: sheet.sha256, sheet: sheet.sheet, row: index + 1 };
  return {
    id: createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24),
    source,
    raw: structuredClone(raw),
    originalAmountCents: null,
    originalCurrency: 'UNKNOWN',
    values: {},
    issues: [],
    disposition: 'review',
  };
}

function parseValues(raw, mapping) {
  const values = Object.fromEntries(fields.map((field) => [field, normalizeText(raw[mapping[field]])]));
  values.date = parseDate(values.date);
  values.quantity = /^-?\d+(?:\.0+)?$/.test(values.quantity) && Number.isSafeInteger(Number(values.quantity)) ? Number(values.quantity) : null;
  values.unit_price_cents = parseMoney(values.unit_price);
  values.amount_cents = parseMoney(values.amount);
  const statuses = { 已完成: 'paid', 已支付: 'paid', paid: 'paid', 退货: 'refunded', refunded: 'refunded', 已取消: 'cancelled', cancelled: 'cancelled' };
  const statusKey = values.status.toLowerCase();
  values.status = Object.hasOwn(statuses, statusKey) ? statuses[statusKey] : null;
  values.currency = normaliseCurrency(values.currency);
  const issues = [];
  if (raw.some((value) => value && typeof value === 'object')) issues.push({ code: 'FORMULA', message: '包含公式或非标量单元格，需人工复核' });
  for (const field of ['order_id', 'line_id', 'date', 'customer', 'sku', 'quantity', 'unit_price_cents', 'amount_cents', 'status']) {
    if (values[field] === '' || values[field] === null) issues.push({ code: 'INVALID_VALUE', message: `${field} 缺失或格式错误` });
  }
  if (values.currency !== 'CNY') issues.push({ code: 'CURRENCY', message: '仅支持 CNY 人民币' });
  if (values.unit_price_cents !== null && values.unit_price_cents < 0) issues.push({ code: 'NEGATIVE_PRICE', message: '单价不可为负' });
  if (values.quantity !== null && values.quantity < 0 && values.status !== 'refunded') issues.push({ code: 'REFUND_STATUS', message: '负数量需要退款状态' });
  if (values.unit_price_cents !== null && values.quantity !== null && values.amount_cents !== null && BigInt(values.quantity) * BigInt(values.unit_price_cents) !== BigInt(values.amount_cents)) {
    issues.push({ code: 'AMOUNT_MISMATCH', message: '金额不等于数量乘单价' });
  }
  return { values, issues };
}

function readHeader(raw) {
  const mapping = {};
  const duplicate = [];
  raw.forEach((value, index) => {
    const field = aliases.get(headerName(value));
    if (!field) return;
    if (field in mapping) duplicate.push(field);
    else mapping[field] = index;
  });
  return { mapping, duplicate, count: Object.keys(mapping).length };
}

const isBlank = (value) => value == null || (typeof value === 'string' && !value.trim());
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function signature(values) {
  return JSON.stringify(fields.map((field) => field === 'unit_price' ? values.unit_price_cents : field === 'amount' ? values.amount_cents : values[field]));
}

function safeNumber(total) {
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('累计金额超出安全整数分范围');
  return Number(total);
}

function safeSum(rows, getter = (row) => row.values.amount_cents) {
  return safeNumber(rows.reduce((sum, row) => sum + BigInt(getter(row) ?? 0), 0n));
}

function normaliseCurrency(value) {
  const text = normalizeText(value).toUpperCase();
  return ['CNY', 'RMB', '人民币', '元'].includes(text) ? 'CNY' : text || 'UNKNOWN';
}

function validateCorrections(corrections) {
  if (!Array.isArray(corrections)) throw new Error('corrections 必须是数组');
  const seen = new Set();
  for (const change of corrections) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('修正记录必须是对象');
    if (Object.keys(change).some((key) => !['id', 'sha256', 'patch', 'reason'].includes(key))) throw new Error('修正记录包含未知字段');
    if (typeof change.id !== 'string' || !change.id.trim()) throw new Error('修正必须指定非空来源 ID');
    if (seen.has(change.id)) throw new Error(`重复修正 ID：${change.id}`);
    seen.add(change.id);
    if (typeof change.sha256 !== 'string' || !change.sha256.trim()) throw new Error('修正必须绑定源文件 sha256');
    if (typeof change.reason !== 'string' || !change.reason.trim()) throw new Error('人工修正必须填写理由');
    if (!change.patch || typeof change.patch !== 'object' || Array.isArray(change.patch) || !Object.keys(change.patch).length) throw new Error('patch 必须是非空字段对象');
    for (const [field, value] of Object.entries(change.patch)) {
      if (!fields.includes(field)) throw new Error(`修正包含未知字段：${field}`);
      if (!(value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)))) throw new Error(`修正字段 ${field} 必须是可序列化标量`);
    }
  }
}

function applyCorrections(corrections, rows, contexts) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const change of corrections) {
    const record = byId.get(change.id);
    if (!record) throw new Error(`修正来源 ID 不存在：${change.id}`);
    if (record.source.sha256 !== change.sha256) throw new Error(`修正的源文件哈希不匹配：${change.id}`);
    if (record.disposition === 'skipped') throw new Error('不能修正被跳过的表头或说明，请指定数据行');
    const context = contexts.get(record.id);
    if (!context) throw new Error('工作表结构错误不能逐行修正，请先修正原表表头');
    const correctedRaw = structuredClone(record.raw);
    const before = Object.fromEntries(fields.map((field) => [field, structuredClone(record.raw[context.mapping[field]] ?? null)]));
    for (const [field, value] of Object.entries(change.patch)) correctedRaw[context.mapping[field]] = value;
    Object.assign(record, parseValues(correctedRaw, context.mapping));
    record.correction = {
      reason: change.reason.trim(), before,
      patch: structuredClone(change.patch), after: structuredClone(record.values),
    };
  }
}

function auditByCurrency(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.originalCurrency)) groups.set(row.originalCurrency, []);
    groups.get(row.originalCurrency).push(row);
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([currency, group]) => ({
    currency,
    parsedInputCents: safeSum(group, (row) => row.originalAmountCents),
    acceptedOriginalCents: safeSum(group.filter((row) => row.disposition === 'accepted'), (row) => row.originalAmountCents),
    duplicateOriginalCents: safeSum(group.filter((row) => row.disposition === 'duplicate'), (row) => row.originalAmountCents),
    reviewOriginalCents: safeSum(group.filter((row) => row.disposition === 'review'), (row) => row.originalAmountCents),
    unparseableRows: group.filter((row) => row.originalAmountCents === null).length,
  }));
}

export function mergeSheets(sheets, { corrections = [] } = {}) {
  validateCorrections(corrections);
  const out = { accepted: [], duplicates: [], review: [], skipped: [], sources: [], schemaIssues: [], worksheets: [] };
  const dataRows = [];
  const contexts = new Map();
  const inputIds = new Set();
  const sortedSheets = [...sheets].sort((a, b) => compare(a.file, b.file) || compare(a.sheet, b.sheet));
  for (const sheet of sortedSheets) {
    out.worksheets.push({ file: sheet.file, sha256: sheet.sha256, sheet: sheet.sheet, rowCount: sheet.rows.length });
    const candidates = sheet.rows.slice(0, 20).map((raw, index) => ({ ...readHeader(raw), index }));
    const header = candidates.find((candidate) => candidate.count === fields.length) ?? candidates.sort((a, b) => b.count - a.count || a.index - b.index)[0];
    let mapping = header?.mapping ?? {};
    const schemaOK = header?.count === fields.length && header.duplicate.length === 0;
    let blockValid = schemaOK;
    if (!schemaOK) out.schemaIssues.push({
      file: sheet.file, sheet: sheet.sheet,
      code: header?.duplicate.length ? 'AMBIGUOUS_COLUMNS' : 'MISSING_COLUMNS',
      message: header?.duplicate.length ? `多列映射到同一字段：${header.duplicate.join(', ')}` : `缺少必要列：${fields.filter((field) => !(field in mapping)).join(', ')}`,
    });
    sheet.rows.forEach((raw, index) => {
      const record = sourceRow(sheet, raw, index);
      const nextHeader = readHeader(raw);
      const repeatedHeader = schemaOK && index > header.index && nextHeader.count === fields.length;
      if (repeatedHeader) {
        blockValid = !nextHeader.duplicate.length;
        if (blockValid) mapping = nextHeader.mapping;
        else out.schemaIssues.push({ file: sheet.file, sheet: sheet.sheet, row: index + 1, code: 'AMBIGUOUS_COLUMNS', message: '中途表头包含歧义列，后续块需复核' });
      }
      record.originalAmountCents = parseMoney(raw[mapping.amount]);
      record.originalCurrency = normaliseCurrency(raw[mapping.currency]);
      if (inputIds.has(record.id)) throw new Error('输入工作表来源重复，无法建立唯一审计 ID');
      inputIds.add(record.id);
      out.sources.push(record);
      const totalMarker = blockValid && ['合计', '总计', '小计', 'total', 'subtotal'].includes(headerName(raw[mapping.order_id]));
      const isTotal = totalMarker && ['line_id', 'date', 'customer', 'sku', 'currency', 'status'].every((field) => isBlank(raw[mapping[field]]));
      const skipCode = raw.every(isBlank) ? 'EMPTY' : schemaOK && index < header.index ? 'PREAMBLE' : schemaOK && index === header.index ? 'HEADER' : repeatedHeader ? 'REPEATED_HEADER' : isTotal ? 'TOTAL' : null;
      if (skipCode) {
        record.disposition = 'skipped';
        record.issues = [{ code: skipCode, message: { EMPTY: '空行', PREAMBLE: '表头前说明', HEADER: '表头', REPEATED_HEADER: '重复表头', TOTAL: '原表合计行' }[skipCode] }];
        out.skipped.push(record);
        return;
      }
      if (!blockValid) {
        record.issues = [{ code: 'SCHEMA', message: '工作表缺少必要列，未猜测字段' }];
        dataRows.push(record);
        return;
      }
      Object.assign(record, parseValues(raw, mapping));
      contexts.set(record.id, { mapping });
      dataRows.push(record);
    });
  }
  applyCorrections(corrections, out.sources, contexts);
  const groups = new Map();
  for (const record of dataRows) {
    const key = record.values.order_id && record.values.line_id ? JSON.stringify([record.values.order_id, record.values.line_id]) : record.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const group of groups.values()) {
    const conflict = group.length > 1 && (group.some((record) => record.issues.length) || new Set(group.map((record) => signature(record.values))).size > 1);
    for (let index = 0; index < group.length; index++) {
      const record = group[index];
      if (conflict) record.issues.push({ code: 'KEY_CONFLICT', message: '同一订单行存在不同内容或无效记录，整组待复核' });
      if (record.issues.length) out.review.push(record);
      else if (index > 0) {
        record.disposition = 'duplicate';
        record.duplicateOf = group[0].id;
        out.duplicates.push(record);
      } else {
        record.disposition = 'accepted';
        out.accepted.push(record);
      }
    }
  }
  out.amountAudit = auditByCurrency(dataRows);
  const acceptedWithoutOriginalAmountRows = out.accepted.filter((row) => row.originalAmountCents === null).length;
  const acceptedWithChangedCurrencyRows = out.accepted.filter((row) => row.originalCurrency !== row.values.currency).length;
  const singleCurrency = out.amountAudit.length <= 1;
  out.summary = {
    inputRows: dataRows.length,
    acceptedRows: out.accepted.length,
    duplicateRows: out.duplicates.length,
    reviewRows: out.review.length,
    skippedRows: out.skipped.length,
    acceptedAmountCents: safeSum(out.accepted),
    parsedInputAmountCents: singleCurrency ? safeSum(dataRows, (row) => row.originalAmountCents) : null,
    duplicateAmountCents: singleCurrency ? safeSum(out.duplicates, (row) => row.originalAmountCents) : null,
    reviewAmountCents: singleCurrency ? safeSum(out.review, (row) => row.originalAmountCents) : null,
    unparseableAmounts: dataRows.filter((row) => row.originalAmountCents === null).length,
    adjustmentAmountCents: acceptedWithoutOriginalAmountRows || acceptedWithChangedCurrencyRows ? null : safeNumber(out.accepted.reduce((total, row) => total + BigInt(row.values.amount_cents) - BigInt(row.originalAmountCents), 0n)),
    acceptedWithoutOriginalAmountRows,
    acceptedWithChangedCurrencyRows,
  };
  return out;
}
