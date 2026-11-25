import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSheets, saveWorkbook } from './workbooks.mjs';
import { mergeSheets } from './core.mjs';
import { makeReport, makeWorkbookSpec } from './report.mjs';

async function canonicalPath(location) {
  try { return await fs.realpath(location); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    return path.join(await canonicalPath(parent), path.basename(location));
  }
}

export async function validateOutput(input, output) {
  const source = await canonicalPath(path.resolve(input));
  const destination = await canonicalPath(path.resolve(output));
  const relative = path.relative(source, destination);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('输出目录必须位于输入目录之外，以免下次将汇总表当成输入');
  }
  try {
    if ((await fs.readdir(destination)).length) throw new Error('输出目录非空，请换一个新目录，不覆盖已有文件');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { source, destination };
}

export async function runMerge({ input, output, corrections = [], writer = saveWorkbook }) {
  const { source, destination } = await validateOutput(input, output);
  const sheets = await loadSheets(source);
  const result = mergeSheets(sheets, { corrections });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), '.merge-'));
  try {
    await writer(makeWorkbookSpec(result), path.join(temporary, 'summary.xlsx'));
    await fs.writeFile(path.join(temporary, 'audit.json'), JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(temporary, 'report.html'), makeReport(result));
    await fs.writeFile(path.join(temporary, 'corrections.template.json'), JSON.stringify(result.review.map((row) => ({
      id: row.id, sha256: row.source.sha256, patch: {}, reason: '',
    })), null, 2));
    try { await fs.rmdir(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return result;
}
