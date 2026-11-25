import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';

const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlAttribute = (value) => xmlText(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// ExcelJS expects unprefixed SpreadsheetML tags. Adapt a read-only copy by URI.
async function compatibleBytes(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const entry of zip.file(/^xl\/.*\.(?:xml|rels)$/)) {
    const original = await entry.async('string');
    if (!original.includes(spreadsheetNamespace) && !entry.name.endsWith('.rels')) continue;
    const parser = new SaxesParser({ xmlns: true });
    const parts = [];
    let modified = false;
    const tagName = (tag) => tag.uri === spreadsheetNamespace ? tag.local : tag.name;
    parser.on('opentag', (tag) => {
      if (tag.uri === spreadsheetNamespace && tag.prefix) modified = true;
      parts.push(`<${tagName(tag)}`);
      for (const attribute of Object.values(tag.attributes)) {
        let value = attribute.value;
        if (entry.name.startsWith('xl/worksheets/_rels/') && tag.local === 'Relationship' && attribute.local === 'Target' &&
          tag.attributes.Type?.value.endsWith('/table') && value.startsWith('/xl/tables/')) {
          value = `../tables/${value.slice('/xl/tables/'.length)}`;
          modified = true;
        }
        parts.push(` ${attribute.name}="${xmlAttribute(value)}"`);
      }
      if (tag.uri === spreadsheetNamespace && tag.prefix && !tag.attributes.xmlns) parts.push(` xmlns="${spreadsheetNamespace}"`);
      parts.push('>');
    });
    parser.on('closetag', (tag) => parts.push(`</${tagName(tag)}>`));
    parser.on('text', (value) => parts.push(xmlText(value)));
    parser.on('cdata', (value) => parts.push(xmlText(value)));
    parser.on('doctype', () => { throw new Error('工作簿 XML 不应包含 DOCTYPE'); });
    parser.write(original).close();
    if (modified) { zip.file(entry.name, parts.join('')); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer' }) : bytes;
}

function plainCell(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === 'object') {
    if (value.formula || value.sharedFormula) return { formula: value.formula || value.sharedFormula };
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.error) return { error: value.error };
    if (value.hyperlink) return value.text || value.hyperlink;
  }
  return value ?? null;
}

export async function loadSheets(directory) {
  const names = (await fs.readdir(directory)).filter((name) => /\.xlsx$/i.test(name) && !name.startsWith('~$')).sort();
  if (!names.length) throw new Error('输入目录中没有 .xlsx 文件');
  const sheets = [];
  for (const file of names) {
    try {
      const bytes = await fs.readFile(path.join(directory, file));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await compatibleBytes(bytes));
      for (const sheet of workbook.worksheets) {
        const rows = [];
        for (let row = 1; row <= sheet.rowCount; row++) {
          const values = [];
          for (let col = 1; col <= sheet.columnCount; col++) values.push(plainCell(sheet.getCell(row, col).value));
          rows.push(values);
        }
        sheets.push({ file, sha256, sheet: sheet.name, rows });
      }
    } catch (error) { throw new Error(`无法读取 ${file}：${error.message}`, { cause: error }); }
  }
  return sheets;
}

export async function saveWorkbook(spec, filename) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'excel-merge-audit';
  workbook.created = new Date('2026-11-25T00:00:00Z');
  for (const definition of spec.sheets) {
    const sheet = workbook.addWorksheet(definition.name, { views: [{ state: 'frozen', ySplit: definition.headerRow || 1, showGridLines: false }] });
    for (const row of definition.rows) {
      sheet.addRow(row.map((value) => value === undefined ? null : value));
    }
    const count = Math.max(1, ...definition.rows.map((row) => row.length));
    sheet.columns.forEach((column, index) => { column.width = definition.widths?.[index] || 18; });
    sheet.eachRow((row) => { row.height = 24; row.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 11 };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      if (typeof cell.value === 'string') {
        const length = (text) => Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 2 : 1), 0);
        const lines = cell.value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(length(line) / Math.max(8, sheet.getColumn(cell.col).width - 2))), 0);
        row.height = Math.max(row.height, lines * 16 + 6);
      }
    }); });
    for (const headerNumber of [definition.headerRow || 1, ...(definition.extraHeaderRows || [])]) {
      const header = sheet.getRow(headerNumber);
      header.height = Math.max(header.height, 30);
      header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243B53' } };
        cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      });
    }
    if (definition.filter !== false) sheet.autoFilter = { from: { row: definition.headerRow || 1, column: 1 }, to: { row: definition.rows.length, column: count } };
    for (const [column, format] of Object.entries(definition.formats || {})) sheet.getColumn(Number(column)).numFmt = format;
    if (definition.name === '汇总') {
      sheet.views = [{ showGridLines: false }];
      sheet.getCell('A2').font = { name: 'Arial', size: 16, bold: true };
      sheet.getCell('B9').numFmt = '#,##0.00';
      sheet.eachRow((row) => {
        if (row.cellCount === 1 && row.number > 11) {
          row.height = 24;
          row.getCell(1).alignment = { vertical: 'middle', wrapText: false };
        }
      });
      for (const headerRow of definition.extraHeaderRows || []) {
        for (let row = headerRow + 1; row <= definition.rows.length - 2; row++) {
          for (let col = 2; col <= 5; col++) sheet.getCell(row, col).numFmt = '#,##0.00';
        }
      }
    }
  }
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await workbook.xlsx.writeFile(filename);
}
