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
