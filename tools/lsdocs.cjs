// 用 Electron 的 Node 模式读 asar 里的目录（普通 node 读不了 asar）
// 用法: "DeepSeek Harness.exe" 带 ELECTRON_RUN_AS_NODE=1 运行本文件，参数为目录
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[2];
try {
  const items = fs.readdirSync(target, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(target, it.name);
    let size = '';
    try { size = it.isFile() ? '  ' + fs.statSync(full).size + 'B' : '/'; } catch (e) { size = '  ?'; }
    console.log(it.name + size);
  }
} catch (e) {
  console.log('ERR ' + e.message);
}
