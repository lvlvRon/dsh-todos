// 在 asar 内递归搜索字符串（Electron 的 fs 补丁能直接读 asar）
// 用法: ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" asar-grep.js <asar 内目录> <关键词>
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const needle = process.argv[3];
if (!target || !needle) {
  console.log('usage: asar-grep.js <dir> <needle>');
  process.exit(1);
}

let hits = 0;
function walk(dir, depth) {
  if (depth > 8) return;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) { walk(full, depth + 1); continue; }
    if (!/\.(js|mjs|cjs|json)$/.test(it.name)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    const idx = text.indexOf(needle);
    if (idx < 0) continue;
    hits += 1;
    const from = Math.max(0, idx - 400);
    console.log('=== ' + full.replace(/^.*@deepseek-ai[\\/]/, ''));
    console.log(text.slice(from, idx + 400).replace(/\s+/g, ' '));
    console.log('');
  }
}
walk(target, 0);
console.log('共 ' + hits + ' 处命中');
