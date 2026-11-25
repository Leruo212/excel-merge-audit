import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSheets, parseMoney, parseDate } from '../src/core.mjs';

const headers = ['订单号', '行号', '日期', '客户', 'SKU', '数量', '单价', '金额', '币种', '状态'];
const line = (id = 'O-1', number = '1', patch = {}) => {
  const values = { id, number, date: '2026-11-01', customer: '甲客户', sku: 'A-01', quantity: 2, price: '12.30', amount: '24.60', currency: 'CNY', status: '已支付', ...patch };
  return [values.id, values.number, values.date, values.customer, values.sku, values.quantity, values.price, values.amount, values.currency, values.status];
};
const sheet = (file, rows, extra = {}) => ({ file, sha256: `sha-${file}`, sheet: '订单', rows: [headers, ...rows], ...extra });

test('金额使用整数分，保留零', () => {
  assert.equal(parseMoney('12.30'), 1230);
  assert.equal(parseMoney(0), 0);
});

test('退款金额的负号允许在币种前后，拒绝双负号和重复符号', () => {
  for (const value of ['￥-36.00', '-¥36.00', 'RMB-36.00', '-CNY36.00']) assert.equal(parseMoney(value), -3600, value);
  for (const value of ['-¥-36.00', '¥--36.00', '--36.00', '¥¥36.00']) assert.equal(parseMoney(value), null, value);
});

test('日期转为明确 ISO 日期', () => {
  assert.equal(parseDate('2026/11/1'), '2026-11-01');
});

test('两个文件的有效订单可以汇总并追溯原始行', () => {
  const out = mergeSheets([sheet('a.xlsx', [line()]), sheet('b.xlsx', [line('O-2')])]);
  assert.equal(out.accepted.length, 2);
  assert.equal(out.summary.acceptedAmountCents, 4920);
  assert.equal(out.accepted[0].source.row, 2);
  assert.deepEqual(out.accepted[0].raw, line());
  assert.equal(out.summary.inputRows, 2);
});

test('缺失必要值保留在待复核，不补成零', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { amount: '' })])]);
  assert.equal(out.review.length, 1);
  assert.equal(out.review[0].values.amount_cents, null);
  assert.equal(out.summary.unparseableAmounts, 1);
});

test('状态只接受显式白名单，不接受对象原型属性', () => {
  for (const status of ['constructor', '__proto__', 'toString']) {
    const result = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { status })])]);
    assert.equal(result.accepted.length, 0, status);
    assert.equal(result.review.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('完全相同的订单行标记重复并保留来源', () => {
  const out = mergeSheets([sheet('a.xlsx', [line()]), sheet('b.xlsx', [line()])]);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.duplicates[0].duplicateOf, out.accepted[0].id);
  assert.equal(out.summary.parsedInputAmountCents, 4920);
});

test('同一订单的不同明细行不得误删', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1'), line('O-1', '2')])]);
  assert.equal(out.accepted.length, 2);
});

test('记录去向数量闭合', () => {
  const out = mergeSheets([sheet('a.xlsx', [line(), line(), line('O-2', '1', { customer: '' })])]);
  assert.equal(out.summary.inputRows, out.accepted.length + out.duplicates.length + out.review.length);
  assert.equal(out.sources.length, 4);
});

test('合并不改变输入对象', () => {
  const source = [sheet('a.xlsx', [line()])];
  const before = JSON.stringify(source);
  mergeSheets(source);
  assert.equal(JSON.stringify(source), before);
});

test('识别人民币千位金额、全角数字、仅尾零的额外精度', () => {
  assert.equal(parseMoney('￥１，２３４.５００'), 123450);
  assert.equal(parseMoney('CNY 1,234.50'), 123450);
  assert.equal(parseMoney('-¥1,234.50'), -123450);
});

test('拒绝错误千位分组、非人民币符号、科学计数文本和非零额外精度', () => {
  for (const value of ['1,23.45', '1,234,56', '$12.30', '1e3', '1.001', 'NaN', Infinity, '', null]) {
    assert.equal(parseMoney(value), null, String(value));
  }
});

test('金额超过安全整数分范围拒绝，临界范围正确', () => {
  assert.equal(parseMoney('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseMoney('90071992547409.92'), null);
});

test('拒绝不存在日期和歧义日期，保留闰年日期', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('01/02/2026'), null);
  assert.equal(parseDate('2024年2月29日'), '2024-02-29');
  assert.equal(parseDate('2026-13-01'), null);
});

test('发现前置说明、空行、重复表头与合计行并逐行记录', () => {
  const rows = [['模拟销售表'], [], headers, line(), headers, line('O-2'), ['合计', '', '', '', '', '', '', '49.20']];
  const out = mergeSheets([sheet('a.xlsx', [], { rows })]);
  assert.equal(out.accepted.length, 2);
  assert.equal(out.summary.inputRows, 2);
  assert.equal(out.skipped.length, 5);
  assert.equal(out.accepted[0].source.row, 4);
  assert.deepEqual(out.skipped.map((row) => row.issues[0].code), ['PREAMBLE', 'EMPTY', 'HEADER', 'REPEATED_HEADER', 'TOTAL']);
});

test('中途重复表头换列顺序后更新映射，修正仍使用对应块的位置', () => {
  const secondHeader = [...headers];
  [secondHeader[3], secondHeader[4]] = [secondHeader[4], secondHeader[3]];
  const secondRow = line('O-2', '1', { customer: '乙客户', sku: 'B-02' });
  [secondRow[3], secondRow[4]] = [secondRow[4], secondRow[3]];
  const sources = [sheet('a.xlsx', [line(), secondHeader, secondRow])];
  const result = mergeSheets(sources);
  assert.equal(result.accepted[1].values.customer, '乙客户');
  assert.equal(result.accepted[1].values.sku, 'B-02');
  const item = result.accepted[1];
  const fixed = mergeSheets(sources, { corrections: [{ id: item.id, sha256: item.source.sha256, patch: { customer: '丙客户' }, reason: '核对客户' }] });
  assert.equal(fixed.accepted[1].values.customer, '丙客户');
  assert.equal(fixed.accepted[1].values.sku, 'B-02');
});

test('中途表头出现歧义列后隔离该块，直到下一个明确表头', () => {
  const result = mergeSheets([sheet('a.xlsx', [line(), [...headers, '客户名称'], line('O-2'), headers, line('O-3')])]);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.review.length, 1);
  assert.ok(result.review[0].issues.some((issue) => issue.code === 'SCHEMA'));
  assert.ok(result.schemaIssues.some((issue) => issue.row === 3));
});

test('完全相同字段的不同文本表示可以去重', () => {
  const out = mergeSheets([
    sheet('b.xlsx', [line('O-1', '1', { amount: '24.600', currency: '人民币', date: '2026年11月1日', status: 'PAID' })]),
    sheet('a.xlsx', [line()]),
  ]);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.accepted[0].source.file, 'a.xlsx');
});

test('同键不同内容整组待复核，没有自动选择赢家', () => {
  const out = mergeSheets([sheet('a.xlsx', [line()]), sheet('b.xlsx', [line('O-1', '1', { quantity: 3, amount: '36.90' })])]);
  assert.equal(out.accepted.length, 0);
  assert.equal(out.duplicates.length, 0);
  assert.equal(out.review.length, 2);
  assert.ok(out.review.every((row) => row.issues.some((issue) => issue.code === 'KEY_CONFLICT')));
  assert.equal(out.summary.reviewAmountCents, 6150);
});

test('同键存在非法值时有效行也进入待复核', () => {
  const out = mergeSheets([sheet('a.xlsx', [line()]), sheet('b.xlsx', [line('O-1', '1', { customer: '' })])]);
  assert.equal(out.accepted.length, 0);
  assert.equal(out.review.length, 2);
});

test('去重结果不依赖输入文件顺序，来源 ID 稳定', () => {
  const a = sheet('a.xlsx', [line()]);
  const b = sheet('b.xlsx', [line()]);
  assert.deepEqual(mergeSheets([a, b]), mergeSheets([b, a]));
});

test('同一内容副本具有不同来源 ID，能完整追踪', () => {
  const out = mergeSheets([sheet('a.xlsx', [line()], { sha256: 'same' }), sheet('b.xlsx', [line()], { sha256: 'same' })]);
  assert.equal(new Set(out.sources.map((row) => row.id)).size, out.sources.length);
});

test('公式金额不执行，明确待复核', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { amount: { formula: 'F2*G2', result: 24.6 } })])]);
  assert.equal(out.review.length, 1);
  assert.ok(out.review[0].issues.some((issue) => issue.code === 'FORMULA'));
});

test('非业务列中的公式同样转复核', () => {
  const out = mergeSheets([sheet('a.xlsx', [], { rows: [[...headers, '备注'], [...line(), { formula: 'HYPERLINK("https://example.com")' }]] })]);
  assert.equal(out.accepted.length, 0);
  assert.ok(out.review[0].issues.some((issue) => issue.code === 'FORMULA'));
});

test('未知币种不能转换成人民币参与汇总', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { currency: 'USD' })])]);
  assert.equal(out.accepted.length, 0);
  assert.equal(out.review[0].values.currency, 'USD');
});

test('退货数量为负但单价非负，金额保持负号', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { quantity: -2, amount: '-24.60', status: '退货' })])]);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.summary.acceptedAmountCents, -2460);
});

test('负单价、非整数数量、非退款负数量都拒绝', () => {
  const out = mergeSheets([sheet('a.xlsx', [
    line('O-1', '1', { price: '-12.30', amount: '-24.60' }),
    line('O-2', '1', { quantity: '2.5', amount: '30.75' }),
    line('O-3', '1', { quantity: -2, amount: '-24.60' }),
  ])]);
  assert.equal(out.accepted.length, 0);
  assert.equal(out.review.length, 3);
});

test('合法零金额不被标成缺失', () => {
  const out = mergeSheets([sheet('a.xlsx', [line('O-1', '1', { price: 0, amount: 0 })])]);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.summary.unparseableAmounts, 0);
});

test('歧义列映射整表待复核', () => {
  const out = mergeSheets([sheet('a.xlsx', [], { rows: [[...headers, '订单编号'], [...line(), 'O-OTHER']] })]);
  assert.equal(out.schemaIssues[0].code, 'AMBIGUOUS_COLUMNS');
  assert.equal(out.accepted.length, 0);
  assert.equal(out.review.length, 2);
});

test('缺必要列和说明页不被默默忽略', () => {
  const out = mergeSheets([sheet('a.xlsx', [], { rows: [['说明'], ['这是示例文件']] })]);
  assert.equal(out.schemaIssues.length, 1);
  assert.equal(out.review.length, 2);
  assert.equal(out.sources.length, 2);
});

test('表头超过前20行，不扫描猜测', () => {
  const out = mergeSheets([sheet('a.xlsx', [], { rows: [...Array.from({ length: 20 }, () => ['说明']), headers, line()] })]);
  assert.equal(out.schemaIssues.length, 1);
  assert.equal(out.accepted.length, 0);
});

test('金额分类及不可解析数量对账闭合', () => {
  const out = mergeSheets([sheet('a.xlsx', [line(), line(), line('O-2', '1', { amount: 'bad' }), line('O-3', '1', { customer: '' })])]);
  assert.equal(out.summary.parsedInputAmountCents, out.summary.acceptedAmountCents + out.summary.duplicateAmountCents + out.summary.reviewAmountCents);
  assert.equal(out.summary.parsedInputAmountCents, 7380);
  assert.equal(out.summary.unparseableAmounts, 1);
});

test('多文件累计金额超过安全整数范围时显式失败', () => {
  assert.throws(() => mergeSheets([sheet('a.xlsx', [
    line('O-1', '1', { quantity: 1, price: '90071992547409.90', amount: '90071992547409.90' }),
    line('O-2', '1', { quantity: 1, price: '0.02', amount: '0.02' }),
  ])]), /安全整数|范围/);
});

const correction = (record, patch, reason = '根据原始凭据核对') => ({ id: record.id, sha256: record.source.sha256, patch, reason });

test('修正日期与空客户后重新校验，保留原值及理由', () => {
  const sources = [sheet('a.xlsx', [line('O-1', '1', { date: '11/01/2026', customer: '' })])];
  const original = JSON.stringify(sources);
  const record = mergeSheets(sources).review[0];
  const changes = [correction(record, { date: '2026-11-01', customer: '甲客户' })];
  const out = mergeSheets(sources, { corrections: changes });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.review.length, 0);
  assert.deepEqual(out.accepted[0].source, record.source);
  assert.deepEqual(out.accepted[0].raw, record.raw);
  assert.equal(out.accepted[0].correction.before.date, '11/01/2026');
  assert.equal(out.accepted[0].correction.after.date, '2026-11-01');
  assert.equal(out.accepted[0].correction.reason, '根据原始凭据核对');
  assert.equal(JSON.stringify(sources), original);
  assert.deepEqual(mergeSheets(sources, { corrections: changes }), out);
});

test('未知ID、旧哈希和重复修正ID整次调用失败', () => {
  const sources = [sheet('a.xlsx', [line()])];
  const record = mergeSheets(sources).accepted[0];
  const valid = correction(record, { customer: '乙客户' });
  assert.throws(() => mergeSheets(sources, { corrections: [{ ...valid, id: 'not-found' }] }), /ID|id|来源/);
  assert.throws(() => mergeSheets(sources, { corrections: [{ ...valid, sha256: 'stale' }] }), /哈希|sha256|源文件/);
  assert.throws(() => mergeSheets(sources, { corrections: [valid, valid] }), /重复/);
});

test('修正必须有理由、非空白名单字段和标量值', () => {
  const sources = [sheet('a.xlsx', [line()])];
  const record = mergeSheets(sources).accepted[0];
  for (const invalid of [
    correction(record, { customer: '乙客户' }, ''),
    correction(record, { customer: '乙客户' }, '   '),
    correction(record, {}),
    correction(record, { unexpected: 'x' }),
    correction(record, { amount_cents: 2460 }),
    correction(record, { customer: { formula: 'A1' } }),
    correction(record, { amount: NaN }),
  ]) {
    assert.throws(() => mergeSheets(sources, { corrections: [invalid] }));
  }
});

test('输入修正配置类型错误和未知顶层字段明确失败', () => {
  const sources = [sheet('a.xlsx', [line()])];
  const record = mergeSheets(sources).accepted[0];
  assert.throws(() => mergeSheets(sources, { corrections: {} }));
  assert.throws(() => mergeSheets(sources, { corrections: [{ ...correction(record, { customer: '乙客户' }), force: true }] }));
});

test('金额修正保留原始分币种审计与显式调整额', () => {
  const sources = [sheet('a.xlsx', [line('O-1', '1', { amount: '25.00' })])];
  const record = mergeSheets(sources).review[0];
  const out = mergeSheets(sources, { corrections: [correction(record, { amount: '24.60' })] });
  assert.equal(out.accepted[0].originalAmountCents, 2500);
  assert.equal(out.summary.acceptedAmountCents, 2460);
  assert.equal(out.summary.adjustmentAmountCents, -40);
  assert.equal(out.summary.acceptedWithoutOriginalAmountRows, 0);
  assert.deepEqual(out.amountAudit, [{ currency: 'CNY', parsedInputCents: 2500, acceptedOriginalCents: 2500, duplicateOriginalCents: 0, reviewOriginalCents: 0, unparseableRows: 0 }]);
});

test('原金额不可解析时修正仍可接纳，但调整额不可计算', () => {
  const sources = [sheet('a.xlsx', [line('O-1', '1', { amount: '待补' })])];
  const record = mergeSheets(sources).review[0];
  const out = mergeSheets(sources, { corrections: [correction(record, { amount: '24.60' })] });
  assert.equal(out.accepted[0].originalAmountCents, null);
  assert.equal(out.summary.adjustmentAmountCents, null);
  assert.equal(out.summary.acceptedWithoutOriginalAmountRows, 1);
  assert.equal(out.amountAudit[0].unparseableRows, 1);
  assert.equal(out.amountAudit[0].acceptedOriginalCents, 0);
});

test('人工修正不可绕过金额和退款业务校验', () => {
  const sources = [sheet('a.xlsx', [line()])];
  const record = mergeSheets(sources).accepted[0];
  const out = mergeSheets(sources, { corrections: [correction(record, { amount: '999.00' })] });
  assert.equal(out.accepted.length, 0);
  assert.ok(out.review[0].issues.some((issue) => issue.code === 'AMOUNT_MISMATCH'));
});

test('修正造成或未解决的同键冲突仍整组待复核', () => {
  const sources = [sheet('a.xlsx', [line('O-1'), line('O-2')])];
  const record = mergeSheets(sources).accepted[1];
  const out = mergeSheets(sources, { corrections: [correction(record, { order_id: 'O-1', customer: '乙客户' })] });
  assert.equal(out.accepted.length, 0);
  assert.equal(out.review.length, 2);
  assert.ok(out.review.every((row) => row.issues.some((issue) => issue.code === 'KEY_CONFLICT')));
});

test('修正解决冲突后规范相同行重新去重', () => {
  const sources = [sheet('a.xlsx', [line(), line('O-1', '1', { customer: '错名' })])];
  const record = mergeSheets(sources).review[1];
  const out = mergeSheets(sources, { corrections: [correction(record, { customer: '甲客户' })] });
  assert.equal(out.accepted.length, 1);
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.review.length, 0);
});

test('原币种分组核对，不将美元与人民币加成一个业务金额', () => {
  const sources = [sheet('a.xlsx', [line(), line(), line('O-2', '1', { currency: 'USD' }), line('O-3', '1', { currency: '', amount: 'bad' })])];
  const out = mergeSheets(sources);
  assert.equal(out.summary.acceptedAmountCents, 2460);
  assert.deepEqual(out.amountAudit, [
    { currency: 'CNY', parsedInputCents: 4920, acceptedOriginalCents: 2460, duplicateOriginalCents: 2460, reviewOriginalCents: 0, unparseableRows: 0 },
    { currency: 'UNKNOWN', parsedInputCents: 0, acceptedOriginalCents: 0, duplicateOriginalCents: 0, reviewOriginalCents: 0, unparseableRows: 1 },
    { currency: 'USD', parsedInputCents: 2460, acceptedOriginalCents: 0, duplicateOriginalCents: 0, reviewOriginalCents: 2460, unparseableRows: 0 },
  ]);
  for (const row of out.amountAudit) assert.equal(row.parsedInputCents, row.acceptedOriginalCents + row.duplicateOriginalCents + row.reviewOriginalCents);
});

test('币种修正保持原币种审计分组', () => {
  const sources = [sheet('a.xlsx', [line('O-1', '1', { currency: 'USD' })])];
  const record = mergeSheets(sources).review[0];
  const out = mergeSheets(sources, { corrections: [correction(record, { currency: '人民币' })] });
  assert.equal(out.accepted[0].values.currency, 'CNY');
  assert.equal(out.accepted[0].originalCurrency, 'USD');
  assert.equal(out.amountAudit[0].currency, 'USD');
  assert.equal(out.amountAudit[0].acceptedOriginalCents, 2460);
  assert.equal(out.summary.adjustmentAmountCents, null, '原币种不同不能相减得到人民币调整额');
  assert.equal(out.summary.acceptedWithChangedCurrencyRows, 1);
});

test('原表说明和结构异常不能通过逐行修正跳过审查', () => {
  const validSources = [sheet('a.xlsx', [line()])];
  const headerRecord = mergeSheets(validSources).skipped[0];
  assert.throws(() => mergeSheets(validSources, { corrections: [correction(headerRecord, { customer: '甲客户' })] }), /跳过|表头|数据行/);
  const invalidSources = [sheet('a.xlsx', [], { rows: [['说明']] })];
  const schemaRecord = mergeSheets(invalidSources).review[0];
  assert.throws(() => mergeSheets(invalidSources, { corrections: [correction(schemaRecord, { customer: '甲客户' })] }), /结构|表头/);
});

test('修正结果可 JSON 往返并独立保留修正内容', () => {
  const sources = [sheet('a.xlsx', [line()])];
  const record = mergeSheets(sources).accepted[0];
  const patch = correction(record, { customer: '乙客户' });
  const out = mergeSheets(sources, { corrections: [patch] });
  patch.patch.customer = '后来被修改';
  assert.equal(out.accepted[0].correction.patch.customer, '乙客户');
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});
