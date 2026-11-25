import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSheets } from '../src/core.mjs';
import { makeReport, makeWorkbookSpec } from '../src/report.mjs';

test('报告保留异常和来源，客户文本不成为 HTML 脚本', async () => {
  const { makeReport, makeWorkbookSpec } = await import('../src/report.mjs');
  const record = { id: 'row-1', source: { file: 'sample.xlsx', sheet: '订单', row: 2 }, raw: ['<script>alert(1)</script>'],
    values: { order_id: '0001', line_id: '1', date: '2026-11-01', customer: '<script>alert(1)</script>', sku: 'A', quantity: 1, unit_price_cents: 100, amount_cents: 100, currency: 'CNY', status: 'paid' }, issues: [], disposition: 'accepted' };
  const result = { accepted: [record], duplicates: [], review: [], skipped: [], sources: [record], schemaIssues: [], summary: { inputRows: 1, acceptedRows: 1, duplicateRows: 0, reviewRows: 0, skippedRows: 0, acceptedAmountCents: 100, parsedInputAmountCents: 100, duplicateAmountCents: 0, reviewAmountCents: 0, unparseableAmounts: 0 } };
  const html = makeReport(result);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('sample.xlsx'));
  const spec = makeWorkbookSpec(result);
  assert.deepEqual(spec.sheets.map((sheet) => sheet.name), ['汇总', '明细', '待复核', '来源']);
  assert.ok(spec.sheets[0].rows.some((row) => row.some((cell) => cell?.formula?.includes('SUM('))));
  assert.equal(spec.sheets[1].rows[1][0], '0001');
});

const header = ['order_id', 'line_id', 'date', 'customer', 'sku', 'quantity', 'unit_price', 'amount', 'currency', 'status'];
const row = (id, currency = 'CNY') => [id, '1', '2026-11-01', '测试客户', 'A', 1, 10, 10, currency, 'paid'];
const input = (rows) => [{ file: 'sample.xlsx', sha256: 'a'.repeat(64), sheet: '订单', rows: [header, ...rows] }];

test('报告按原币种分别对账，不把空值显示为零或混合币种总额', () => {
  const result = mergeSheets(input([row('1'), row('2', 'USD')]));
  const html = makeReport(result);
  assert.match(html, /原币种金额对账/);
  assert.match(html, /USD/);
  assert.ok(!html.includes('可解析金额核对：'));
  const spec = makeWorkbookSpec(result);
  const sources = spec.sheets.find((sheet) => sheet.name === '来源');
  assert.ok(sources.rows[0].includes('原币种'));
  assert.ok(sources.rows.some((cells) => cells.includes('USD')));
});

test('原金额不可解析的修正保留空原值，展示理由和无法计算的调整额', () => {
  const sheets = input([row('1')]);
  sheets[0].rows[1][7] = '坏金额';
  const original = mergeSheets(sheets).review[0];
  const result = mergeSheets(sheets, { corrections: [{ id: original.id, sha256: original.source.sha256, patch: { amount: 10 }, reason: '核对模拟原单' }] });
  const html = makeReport(result);
  assert.match(html, /核对模拟原单/);
  assert.match(html, /无法计算/);
  const sources = makeWorkbookSpec(result).sheets.find((sheet) => sheet.name === '来源');
  const amountColumn = sources.rows[0].indexOf('原金额（原币种）');
  assert.ok(amountColumn >= 0);
  assert.equal(sources.rows[2][amountColumn], null);
});

test('客户较多时不覆盖金额对账或说明，行数差额用公式核对', () => {
  const result = mergeSheets(input(Array.from({ length: 20 }, (_, i) => {
    const cells = row(String(i));
    cells[3] = `客户${i}`;
    return cells;
  })));
  const summary = makeWorkbookSpec(result).sheets[0];
  assert.equal(summary.rows.filter((cells) => /^客户\d+$/.test(cells[3])).length, 20);
  assert.ok(summary.rows.some((cells) => cells[0] === '行数差额' && cells[1]?.formula));
});

test('客户名为条件符号时汇总公式使用数值分组，大小写不同的名称保持分离', () => {
  const cells = row('1');
  cells[3] = '*';
  const acme = row('3'); acme[3] = 'ACME';
  const lower = row('4'); lower[3] = 'acme';
  const spec = makeWorkbookSpec(mergeSheets(input([cells, row('2'), acme, lower])));
  const summary = spec.sheets[0];
  const customer = summary.rows.find((cells) => cells[3] === '*');
  assert.equal(customer[4].result, 10);
  assert.equal(customer[5].result, 1);
  assert.match(customer[4].formula, /\$P\$2/);
  assert.notEqual(spec.sheets[1].rows[3][15], spec.sheets[1].rows[4][15]);
});

test('空工作表进入文件清单和结构问题，不遗漏文件', () => {
  const result = mergeSheets([{ file: 'empty.xlsx', sha256: 'b'.repeat(64), sheet: '空表', rows: [] }]);
  const spec = makeWorkbookSpec(result);
  assert.equal(spec.sheets[0].rows[3][1], 1);
  const html = makeReport(result);
  assert.match(html, /1 份工作簿/);
  assert.match(html, /empty.xlsx/);
  assert.match(html, /bbbbbbbbbbbbbbbb/);
});
