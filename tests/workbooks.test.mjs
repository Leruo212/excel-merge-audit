import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

test('带命名空间前缀的标准 XLSX 可读取，文本中的前缀保持原样', async () => {
  const { loadSheets } = await import('../src/workbooks.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-namespaces-'));
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', '<x:workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="订单" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>000123 x:foo &amp; &lt;x:tag&gt;</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>');
    await fs.writeFile(path.join(dir, 'prefixed.xlsx'), await zip.generateAsync({ type: 'nodebuffer' }));
    const sheets = await loadSheets(dir);
    assert.equal(sheets[0].sheet, '订单');
    assert.equal(sheets[0].rows[0][0], '000123 x:foo & <x:tag>');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('XLSX 往返保留标识文本、日期、数值、公式与真实行号', async () => {
  const { saveWorkbook, loadSheets } = await import('../src/workbooks.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-test-'));
  try {
    await saveWorkbook({ sheets: [{ name: '订单', rows: [
      ['订单号', '日期', '数量', '金额'],
      ['000123', new Date('2026-11-01T00:00:00Z'), 2, { formula: 'C2*10', result: 20 }],
    ] }] }, path.join(dir, 'orders.xlsx'));
    const sheets = await loadSheets(dir);
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].rows[1][0], '000123');
    assert.equal(sheets[0].rows[1][1], '2026-11-01');
    assert.equal(sheets[0].rows[1][2], 2);
    assert.equal(sheets[0].rows[1][3].formula, 'C2*10');
    assert.match(sheets[0].sha256, /^[a-f0-9]{64}$/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('目录没有工作簿和损坏工作簿均明确失败', async () => {
  const { loadSheets } = await import('../src/workbooks.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-test-'));
  try {
    await assert.rejects(loadSheets(dir), /xlsx/);
    await fs.writeFile(path.join(dir, 'broken.xlsx'), 'not-a-zip');
    await assert.rejects(loadSheets(dir), /broken.xlsx/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('制表工具导出的十文件样例可读且包含全部模拟订单', async () => {
  const { loadSheets } = await import('../src/workbooks.mjs');
  const { mergeSheets } = await import('../src/core.mjs');
  const { makeDemo } = await import('../src/fixtures.mjs');
  const sheets = await loadSheets(new URL('../demo/input', import.meta.url).pathname);
  const result = mergeSheets(sheets);
  const { expected } = makeDemo();
  assert.equal(new Set(sheets.map((sheet) => sheet.file)).size, 10);
  for (const key of ['inputRows', 'acceptedRows', 'reviewRows', 'duplicateRows', 'acceptedAmountCents']) assert.equal(result.summary[key], expected[key], key);
});
