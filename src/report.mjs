const dispositionNames = { accepted: '接纳', duplicate: '重复', review: '待复核', skipped: '跳过' };
const money = (cents) => cents == null ? '无法计算' : (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const reasons = (record) => record.issues.map((issue) => `${issue.code}: ${issue.message}`).join('；');
const fileNames = (result) => [...new Set([...(result.worksheets || []), ...result.sources, ...result.schemaIssues].map((item) => item.source?.file ?? item.file))].sort();

export function makeWorkbookSpec(result) {
  const count = result.accepted.length;
  const end = Math.max(2, count + 1);
  const customers = [...new Set(result.accepted.map((row) => row.values.customer))].sort();
  const customerGroups = new Map(customers.map((customer, index) => [customer, index + 1]));
  const detail = result.accepted.map(({ values: v, source: s, id, correction }) => [v.order_id, v.line_id, new Date(`${v.date}T00:00:00Z`), v.customer, v.sku, v.quantity,
    v.unit_price_cents / 100, v.amount_cents / 100, v.currency, v.status, s.file, s.sheet, s.row, id, correction?.reason || '', customerGroups.get(v.customer)]);
  const summary = [[], ['订单合并结果'], ['指标', '数值', null, '客户', '接纳金额（元）', '接纳行数'],
    ['输入文件', fileNames(result).length],
    ['数据行', result.summary.inputRows],
    ['接纳行', { formula: `COUNTA('明细'!A2:A${end})`, result: count }],
    ['重复行', result.duplicates.length], ['待复核行', result.review.length],
    ['接纳金额（元）', { formula: `SUM('明细'!H2:H${end})`, result: result.summary.acceptedAmountCents / 100 }],
    ['无法解析金额的行', result.summary.unparseableAmounts],
    ['行数差额', { formula: 'B5-SUM(B6:B8)', result: result.summary.inputRows - count - result.duplicates.length - result.review.length }]];
  customers.forEach((customer, index) => {
    const row = index + 3;
    const matches = result.accepted.filter((record) => record.values.customer === customer);
    summary[row] ||= [];
    summary[row][3] = customer;
    const group = customerGroups.get(customer);
    summary[row][4] = { formula: `SUMIFS('明细'!$H$2:$H$${end},'明细'!$P$2:$P$${end},${group})`, result: matches.reduce((sum, item) => sum + item.values.amount_cents, 0) / 100 };
    summary[row][5] = { formula: `COUNTIFS('明细'!$P$2:$P$${end},${group})`, result: matches.length };
  });
  summary.push([], ['接纳金额：仅 CNY，含退货；不代表已到账收入。'], ['原始值、币种、修正理由及来源见“来源”和 audit.json。'],
    ['处理结果为运行时快照；修改原表或明细后需重新运行。'], []);
  const auditHeaderRow = summary.length + 1;
  summary.push(['原币种', '可解析原金额', '接纳行原金额', '重复行原金额', '复核行原金额', '无法解析行数']);
  for (const audit of result.amountAudit || []) summary.push([audit.currency, audit.parsedInputCents / 100, audit.acceptedOriginalCents / 100,
    audit.duplicateOriginalCents / 100, audit.reviewOriginalCents / 100, audit.unparseableRows]);
  summary.push(['接纳行修正差额（CNY 元）', result.summary.adjustmentAmountCents == null ? '无法计算' : result.summary.adjustmentAmountCents / 100],
    ['接纳行无可解析原金额', result.summary.acceptedWithoutOriginalAmountRows ?? 0]);
  return { sheets: [
    { name: '汇总', headerRow: 3, extraHeaderRows: [auditHeaderRow], filter: false, widths: [30, 21, 22, 24, 23, 18], formats: { 5: '#,##0.00' }, rows: summary },
    { name: '明细', widths: [19, 10, 15, 24, 16, 12, 16, 17, 10, 14, 24, 18, 12, 28, 40, 12], formats: { 3: 'yyyy-mm-dd', 7: '#,##0.00', 8: '#,##0.00' }, rows: [
      ['订单号', '行号', '日期', '客户', '商品编码', '数量', '单价（元）', '金额（元）', '币种', '状态', '来源文件', '来源表', '原始行', '追溯 ID', '修正理由', '客户分组'], ...detail] },
    { name: '待复核', widths: [24, 18, 12, 19, 10, 56, 72, 30], rows: [
      ['来源文件', '来源表', '原始行', '订单号', '行号', '问题', '原始单元格', '追溯 ID'],
      ...result.review.map((row) => [row.source.file, row.source.sheet, row.source.row, row.values.order_id, row.values.line_id, reasons(row), JSON.stringify(row.raw), row.id])] },
    { name: '来源', widths: [24, 18, 12, 14, 19, 10, 12, 23, 12, 23, 30, 56, 72, 40, 30, 40, 80], formats: { 8: '#,##0.00', 10: '#,##0.00' }, rows: [
      ['来源文件', '来源表', '原始行', '处理结果', '订单号', '行号', '原币种', '原金额（原币种）', '处理后币种', '处理后金额', '重复指向', '说明', '原始单元格', '文件 SHA-256', '追溯 ID', '修正理由', '修正记录'],
      ...result.sources.map((row) => [row.source.file, row.source.sheet, row.source.row, dispositionNames[row.disposition], row.values.order_id, row.values.line_id,
        row.disposition === 'skipped' ? '' : row.originalCurrency, Number.isSafeInteger(row.originalAmountCents) && row.disposition !== 'skipped' ? row.originalAmountCents / 100 : null,
        row.values.currency, Number.isSafeInteger(row.values.amount_cents) ? row.values.amount_cents / 100 : null,
        row.duplicateOf || '', reasons(row), JSON.stringify(row.raw), row.source.sha256, row.id, row.correction?.reason || '', row.correction ? JSON.stringify(row.correction) : ''])] },
  ] };
}

function table(headers, rows, label) {
  return `<div class="table-wrap"><table aria-label="${escape(label)}"><thead><tr>${headers.map((heading) => `<th>${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${headers.length}">无记录</td></tr>`}</tbody></table></div>`;
}

export function makeReport(result) {
  const s = result.summary;
  const files = fileNames(result);
  const acceptedRows = result.accepted.map((row) => [row.values.order_id, row.values.line_id, row.values.date, row.values.customer, row.values.sku, row.values.quantity, money(row.values.amount_cents), `${row.source.file} / ${row.source.sheet} / ${row.source.row}`]);
  const reviewRows = result.review.map((row) => [row.values.order_id || '缺失', `${row.source.file} / ${row.source.sheet} / ${row.source.row}`, reasons(row), JSON.stringify(row.raw)]);
  const byId = new Map(result.sources.map((row) => [row.id, row]));
  const duplicateRows = result.duplicates.map((row) => {
    const original = byId.get(row.duplicateOf)?.source;
    return [row.values.order_id, row.values.line_id, money(row.values.amount_cents), `${row.source.file} / ${row.source.sheet} / ${row.source.row}`,
      original ? `${original.file} / ${original.sheet} / ${original.row}` : row.duplicateOf];
  });
  const auditRows = (result.amountAudit || []).map((audit) => [audit.currency, money(audit.parsedInputCents), money(audit.acceptedOriginalCents),
    money(audit.duplicateOriginalCents), money(audit.reviewOriginalCents), audit.unparseableRows]);
  const correctionRows = result.sources.filter((row) => row.correction).map((row) => [row.id, row.correction.reason,
    JSON.stringify(row.correction.before), JSON.stringify(row.correction.patch), JSON.stringify(row.correction.after)]);
  const fileRows = files.map((file) => {
    const all = result.sources.filter((row) => row.source.file === file);
    const count = (status) => all.filter((row) => row.disposition === status).length;
    return [file, count('accepted'), count('duplicate'), count('review'), count('skipped'), all[0]?.source.sha256 || result.worksheets?.find((sheet) => sheet.file === file)?.sha256 || ''];
  });
  const issues = (result.schemaIssues || []).map((issue) => `<li>${escape(JSON.stringify(issue))}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订单合并核对</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f8fa;color:#24292f;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}header{background:#fff;border-bottom:1px solid #d0d7de;padding:22px max(24px,calc((100vw - 1260px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}h1{font-size:22px;margin:0 0 4px}p{margin:0;color:#57606a}a{color:#0969da;text-decoration:none}header a{white-space:nowrap}main{max-width:1308px;margin:auto;padding:24px}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;border-bottom:1px solid #d0d7de;padding:0 0 22px;margin-bottom:20px}.metrics span{display:block;color:#57606a}.metrics strong{font-size:25px;font-weight:600;display:block;margin-top:6px}.warning{color:#9a6700}.toolbar{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:12px}nav{display:flex;gap:22px}button{border:0;border-bottom:2px solid transparent;background:none;padding:10px 0;color:#57606a;font:inherit;cursor:pointer}button[aria-selected=true]{border-color:#fd8c73;color:#24292f;font-weight:600}input{font:inherit;padding:8px 12px;background:#fff;border:1px solid #d0d7de;border-radius:5px;width:270px;max-width:100%}.table-wrap{overflow:auto;background:#fff;border:1px solid #d0d7de;border-radius:6px;max-height:590px}table{border-collapse:collapse;width:100%;font-size:13px}th{position:sticky;top:0;background:#f0f3f6;text-align:left;white-space:nowrap;color:#57606a;font-weight:600}th,td{padding:11px 14px;border-bottom:1px solid #eaeef2;vertical-align:top}td{min-width:90px;max-width:480px;overflow-wrap:anywhere}tbody tr:hover{background:#f6f8fa}.note{margin-top:18px;color:#57606a;line-height:1.8}.note strong{color:#24292f}details{margin-top:16px}summary{cursor:pointer}.hidden,[hidden]{display:none!important}@media(max-width:700px){header{padding:18px;align-items:flex-start}main{padding:18px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.metrics strong{font-size:23px}.toolbar input{width:100%}nav{gap:18px}th,td{padding:10px}}
h2{font-size:20px;margin:22px 0 12px}#accepted td:nth-child(1),#accepted td:nth-child(3),#accepted td:nth-child(7){white-space:nowrap}button:focus-visible,a:focus-visible{outline:2px solid #0969da;outline-offset:4px}
</style></head><body><header><div><h1>订单合并核对</h1><p>${files.length} 份工作簿 · 金额单位：人民币元</p></div><a href="summary.xlsx">下载 Excel 汇总</a></header><main>
<section class="metrics" aria-label="处理概览"><div><span>数据行</span><strong>${s.inputRows}</strong></div><div><span>接纳行</span><strong>${s.acceptedRows}</strong></div><div><span>重复行</span><strong>${s.duplicateRows}</strong></div><div><span>待复核行</span><strong class="warning">${s.reviewRows}</strong></div><div><span>接纳金额</span><strong>${money(s.acceptedAmountCents)}</strong></div></section>
<div class="toolbar"><nav aria-label="结果视图"><button data-tab="accepted" aria-selected="true">接纳明细</button><button data-tab="review" aria-selected="false">待复核 ${s.reviewRows}</button><button data-tab="duplicates" aria-selected="false">重复 ${s.duplicateRows}</button><button data-tab="files" aria-selected="false">文件对账</button></nav><input type="search" aria-label="搜索当前表格" placeholder="搜索订单、客户或来源"></div>
<section id="accepted">${table(['订单号', '行号', '日期', '客户', '商品', '数量', '金额', '来源文件 / 表 / 行'], acceptedRows, '接纳明细')}</section>
<section id="review" hidden>${table(['订单号', '来源文件 / 表 / 行', '原因', '原始单元格'], reviewRows, '待复核记录')}</section>
<section id="duplicates" hidden>${table(['订单号', '行号', '金额（CNY 元）', '重复来源', '保留来源'], duplicateRows, '重复记录')}</section>
<section id="files" hidden>${table(['文件', '接纳', '重复', '待复核', '跳过', 'SHA-256'], fileRows, '文件对账')}</section>
<div class="note"><strong>行数核对：</strong>${s.inputRows} = ${s.acceptedRows} 接纳 + ${s.duplicateRows} 重复 + ${s.reviewRows} 待复核。另有 ${s.skippedRows} 行表头、说明或合计等跳过记录。</div>
<h2>原币种金额对账</h2>${table(['原币种', '可解析原金额', '接纳行原金额', '重复行原金额', '复核行原金额', '无法解析行数'], auditRows, '原币种金额对账')}
<div class="note">每种原币种分别核对：可解析原金额 = 接纳行原金额 + 重复行原金额 + 复核行原金额。无法解析的原金额不进入等式。<br>接纳行修正差额：${money(s.adjustmentAmountCents)} CNY 元；${s.acceptedWithoutOriginalAmountRows ?? 0} 条接纳行的原金额无法解析。原币种被修正时不能将其差额理解为汇兑金额。<br>金额含负数量退货，不代表已到账收入。完整记录见 <a href="audit.json">audit.json</a>。</div>
${correctionRows.length ? `<details open><summary>人工修正 ${correctionRows.length} 条</summary>${table(['追溯 ID', '理由', '原字段', '修正字段', '重新校验结果'], correctionRows, '人工修正')}</details>` : ''}
${issues ? `<details open><summary>表结构问题</summary><ul>${issues}</ul></details>` : ''}
</main><script>
let active='accepted';const search=document.querySelector('input');function filter(){const q=search.value.toLocaleLowerCase();document.querySelectorAll('#'+active+' tbody tr').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase().includes(q)});}document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{document.getElementById(active).hidden=true;active=button.dataset.tab;document.getElementById(active).hidden=false;document.querySelectorAll('[data-tab]').forEach(item=>item.setAttribute('aria-selected',String(item===button)));filter();}));search.addEventListener('input',filter);
</script></body></html>`;
}
