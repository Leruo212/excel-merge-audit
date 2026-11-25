#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { makeDemo } from './fixtures.mjs';
import { saveWorkbook } from './workbooks.mjs';
import { runMerge } from './pipeline.mjs';

const help = `Excel Merge Audit

生成十份模拟表并合并：
  npm run demo -- --out outputs/demo

处理自己的订单表：
  npm run merge -- --input path/to/xlsx --output outputs/run-01
  npm run merge -- --input path/to/xlsx --output outputs/run-02 --corrections fixes.json

选项：
  --fail-on-review    发现待复核行或表结构问题时，仍导出报告并返回状态码 2
  --help             显示帮助

仅支持 .xlsx。输出目录必须为空且位于输入目录外。错误状态码为 1。
`;

try {
  const { values, positionals } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, out: { type: 'string' }, corrections: { type: 'string' },
    'fail-on-review': { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: true, strict: true });
  if (values.help) console.log(help);
  else {
    const [command, ...extra] = positionals;
    if (extra.length || !['demo', 'merge'].includes(command)) throw new Error('请使用 demo 或 merge，详见 --help');
    let result;
    let destination;
    if (command === 'demo') {
      if (values.input || values.output || values.corrections) throw new Error('demo 只接受 --out 与 --fail-on-review');
      const base = path.resolve(values.out || 'outputs/demo');
      try { if ((await fs.readdir(base)).length) throw new Error('演示目录非空，请使用新的 --out 目录'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const { workbooks, expected } = makeDemo();
      for (const item of workbooks) await saveWorkbook(item.spec, path.join(base, 'input', item.file));
      await fs.writeFile(path.join(base, 'expected.json'), JSON.stringify(expected, null, 2));
      destination = path.join(base, 'result');
      result = await runMerge({ input: path.join(base, 'input'), output: destination });
    } else {
      if (!values.input || !values.output || values.out) throw new Error('merge 需要 --input 与 --output');
      const corrections = values.corrections ? JSON.parse(await fs.readFile(values.corrections, 'utf8')) : [];
      destination = path.resolve(values.output);
      result = await runMerge({ input: values.input, output: destination, corrections });
    }
    const s = result.summary;
    console.log(`数据行 ${s.inputRows}，接纳 ${s.acceptedRows}，重复 ${s.duplicateRows}，待复核 ${s.reviewRows}`);
    console.log(`接纳金额 CNY ${(s.acceptedAmountCents / 100).toFixed(2)} 元；结果位于 ${destination}`);
    if (result.review.length || result.schemaIssues.length) console.log('仍有待复核内容，请先检查报告。');
    if (values['fail-on-review'] && (result.review.length || result.schemaIssues.length)) process.exitCode = 2;
  }
} catch (error) {
  console.error(`处理失败：${error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `未知参数。${error.message}` : error.message}`);
  process.exitCode = 1;
}
