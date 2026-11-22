// 生成 1900–2100 农历离线表（数据源：lunar-javascript，MIT，6tail）
// 做法：逐日走公历，用库取农历月日，按月分组推出每个农历月长度 —— 只用已验证的 Solar→Lunar 转换
// 用法: node gen.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { Solar, Lunar } = require('lunar-javascript');

const FROM = 1900, TO = 2100;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
/* 闰月号必须定宽单字符：10/11/12 用 a/b/c，否则整条串会错位 */
const leapChar = n => (n === 0 ? '0' : n < 10 ? String(n) : 'abc'[n - 10]);
const lunarAt = t => {
  const dt = new Date(t * 86400000);
  return Solar.fromYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()).getLunar();
};

const nyDays = [], leaps = [], lens = [];
let broken = 0;

for (let y = FROM; y <= TO; y++) {
  const s = Lunar.fromYmd(y, 1, 1).getSolar();
  const start = dayNum(s.getYear(), s.getMonth(), s.getDay());
  nyDays.push(start);

  // 从正月初一逐日走，直到农历年变化；按月分组得到月份顺序与长度
  const seq = [];
  let t = start;
  while (true) {
    const l = lunarAt(t);
    if (l.getYear() !== y) break;
    const m = l.getMonth(); // 负数表示闰月
    if (!seq.length || seq[seq.length - 1].m !== m) seq.push({ m, len: 0 });
    seq[seq.length - 1].len++;
    if (t - start > 400) { broken++; break; } // 防御：不该发生
    t++;
  }

  const leapEntry = seq.find(x => x.m < 0);
  const leap = leapEntry ? Math.abs(leapEntry.m) : 0;
  leaps.push(leapChar(leap));

  let row = '';
  for (let m = 1; m <= 12; m++) {
    const hit = seq.find(x => x.m === m);
    row += hit ? (hit.len === 30 ? '3' : '2') : '0'; // 3=三十天 2=廿九天 0=该月不存在
  }
  row += leapEntry ? (leapEntry.len === 30 ? '3' : '2') : '0';
  lens.push(row);

  if (seq.length !== (leap ? 13 : 12)) {
    broken++;
    console.log(`  ! ${y} 月数异常 ${seq.length}: ${seq.map(x => x.m + '×' + x.len).join(' ')}`);
  }
}

const table = { from: FROM, to: TO, ny: nyDays, leap: leaps.join(''), lens: lens.join('') };

function lunarOfSolar(y, m, d) {
  const target = dayNum(y, m, d);
  let i = -1;
  for (let k = 0; k < table.ny.length; k++) { if (table.ny[k] <= target) i = k; else break; }
  if (i < 0) return null;
  let offset = target - table.ny[i];
  const lc = table.leap[i];
  const leap = lc === '0' ? 0 : ('abc'.includes(lc) ? 10 + 'abc'.indexOf(lc) : Number(lc));
  const row = table.lens.slice(i * 13, i * 13 + 13);
  for (let mth = 1; mth <= 12; mth++) {
    const days = row[mth - 1] === '3' ? 30 : row[mth - 1] === '2' ? 29 : 0;
    if (offset < days) return { year: FROM + i, month: mth, day: offset + 1, leap: false };
    offset -= days;
    if (leap === mth) {
      const ld = row[12] === '3' ? 30 : row[12] === '2' ? 29 : 0;
      if (offset < ld) return { year: FROM + i, month: mth, day: offset + 1, leap: true };
      offset -= ld;
    }
  }
  return null;
}

const CASES = [
  ['2025-01-29', 1, 1, '春节 2025'],
  ['2026-02-17', 1, 1, '春节 2026'],
  ['2027-02-06', 1, 1, '春节 2027（官方 2/6，Intl 错成 2/7）'],
  ['2028-01-26', 1, 1, '春节 2028'],
  ['2027-02-05', 12, 29, '除夕 2027 = 腊月廿九'],
  ['2026-11-22', 10, 14, '小雪当天 = 十月十四'],
  ['2026-09-25', 8, 15, '中秋 = 八月十五'],
  ['2026-06-19', 5, 5, '端午 = 五月初五'],
  ['2026-03-20', 2, 2, '龙抬头 = 二月初二'],
  ['2026-12-09', 11, 1, '十一月初一'],
];

console.log('== 用离线表反查校验（不经过库）==');
let bad = 0;
for (const [iso, em, ed, label] of CASES) {
  const [y, m, d] = iso.split('-').map(Number);
  const got = lunarOfSolar(y, m, d);
  const ok = got && got.month === em && got.day === ed && !got.leap;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${iso} → ${got ? (got.leap ? '闰' : '') + got.month + '月' + got.day + '日' : '空'}   ${label}`);
}
console.log(bad === 0 ? '  ✓ 全部通过' : `  ✗ ${bad} 项失败`);

console.log('\n== 全量往返 1900-01-01 ~ 2100-12-31 ==');
let mismatch = 0, checked = 0;
for (let t = dayNum(1900, 1, 1); t <= dayNum(2100, 12, 31); t++) {
  const dt = new Date(t * 86400000);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
  const lib = lunarAt(t);
  const mine = lunarOfSolar(y, m, d);
  checked++;
  if (!mine || mine.month !== Math.abs(lib.getMonth()) || mine.day !== lib.getDay()
    || mine.leap !== (lib.getMonth() < 0)) {
    mismatch++;
    if (mismatch <= 5) console.log(`  ✗ ${y}-${m}-${d} 库=${lib.getMonth()}/${lib.getDay()} 表=${mine ? mine.month + '/' + mine.day : '空'}`);
  }
}
console.log(mismatch === 0 ? `  ✓ ${checked} 天全部一致` : `  ✗ ${mismatch}/${checked} 天不一致`);

writeFileSync(new URL('../../data/lunar-table.json', import.meta.url), JSON.stringify(table));
console.log(`\n已写出 data/lunar-table.json (${FROM}-${TO})，${(JSON.stringify(table).length / 1024).toFixed(1)} KB，异常年 ${broken} 个`);
