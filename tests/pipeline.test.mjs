import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('十工作簿端到端结果匹配独立控制值，每行有且仅有一个去向', async () => {
  const { runMerge } = await import('../src/pipeline.mjs');
  const { makeDemo } = await import('../src/fixtures.mjs');
  const { saveWorkbook } = await import('../src/workbooks.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-e2e-'));
  try {
    const { workbooks, expected } = makeDemo();
    const input = path.join(dir, 'input');
    for (const item of workbooks) await saveWorkbook(item.spec, path.join(input, item.file));
    const hash = async () => Promise.all((await fs.readdir(input)).map(async (name) => createHash('sha256').update(await fs.readFile(path.join(input, name))).digest('hex')));
    const before = await hash();
    const result = await runMerge({ input, output: path.join(dir, 'result') });
    for (const key of ['inputRows', 'acceptedRows', 'duplicateRows', 'reviewRows', 'acceptedAmountCents']) assert.equal(result.summary[key], expected[key], key);
    assert.deepEqual(result.accepted.map((record) => `${record.values.order_id}|${record.values.line_id}`).sort(), expected.acceptedKeys);
    assert.equal(new Set(result.sources.map((record) => record.id)).size, result.sources.length);
    assert.equal(result.sources.length, result.accepted.length + result.duplicates.length + result.review.length + result.skipped.length);
    assert.deepEqual(await hash(), before);
    assert.ok((await fs.readFile(path.join(dir, 'result/report.html'), 'utf8')).includes('订单合并核对'));
    const second = await runMerge({ input, output: path.join(dir, 'second') });
    assert.deepEqual(second, result);
    for (const audit of result.amountAudit) assert.equal(audit.parsedInputCents, audit.acceptedOriginalCents + audit.duplicateOriginalCents + audit.reviewOriginalCents);
    const date = result.review.find((record) => record.values.order_id === 'SO-0014');
    const customer = result.review.find((record) => record.values.order_id === 'SO-0028');
    const corrections = [
      { id: date.id, sha256: date.source.sha256, patch: { date: '2026-11-14' }, reason: '对照模拟真值确认日期' },
      { id: customer.id, sha256: customer.source.sha256, patch: { customer: '松果商贸' }, reason: '对照模拟真值补全客户' },
    ];
    const fixed = await runMerge({ input, output: path.join(dir, 'fixed'), corrections });
    assert.equal(fixed.summary.acceptedRows, expected.acceptedRows + 2);
    assert.equal(fixed.summary.reviewRows, expected.reviewRows - 2);
    assert.equal(fixed.summary.acceptedAmountCents, expected.acceptedAmountCents + 15075);
    for (const change of corrections) {
      const item = fixed.accepted.find((record) => record.id === change.id);
      const beforeRecord = result.review.find((record) => record.id === change.id);
      assert.deepEqual(item.raw, beforeRecord.raw);
      assert.deepEqual(item.source, beforeRecord.source);
      assert.equal(item.correction.reason, change.reason);
    }
    for (const bad of [
      { ...corrections[0], sha256: 'stale' },
      { ...corrections[0], patch: { unknown: 1 } },
      { ...corrections[0], reason: '' },
    ]) {
      const target = path.join(dir, 'rejected');
      await assert.rejects(runMerge({ input, output: target, corrections: [bad] }));
      await assert.rejects(fs.access(target));
    }
    const strict = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'merge', '--input', input,
      '--output', path.join(dir, 'strict'), '--fail-on-review']);
    assert.equal(strict.status, 2);
    assert.ok((await fs.stat(path.join(dir, 'strict', 'summary.xlsx'))).size > 0);
    assert.deepEqual(await hash(), before);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('输出在输入目录内或已有非空输出会拒绝，不覆盖文件', async () => {
  const { runMerge } = await import('../src/pipeline.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-path-'));
  try {
    await assert.rejects(runMerge({ input: dir, output: path.join(dir, 'result') }), /输入/);
    const output = `${dir}-output`;
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'keep.txt'), 'keep');
    await assert.rejects(runMerge({ input: dir, output }), /非空/);
    assert.equal(await fs.readFile(path.join(output, 'keep.txt'), 'utf8'), 'keep');
    await fs.rm(output, { recursive: true, force: true });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('命令行未知参数失败，帮助不读写文件', () => {
  const file = new URL('../src/cli.mjs', import.meta.url).pathname;
  const bad = spawnSync(process.execPath, [file, 'merge', '--unknown']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr.toString(), /未知参数/);
  const help = spawnSync(process.execPath, [file, '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout.toString(), /merge/);
});
