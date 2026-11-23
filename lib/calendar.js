/**
 * 历法：农历查表 + 节气天文算法 + 节日映射。
 *
 * 放在 Host 侧的理由：算法只实现一次，客户端只管渲染；
 * 也避免把 4KB 数据表内联进 client.js（那是单文件硬约束下最贵的东西）。
 */

import { readFileSync } from 'node:fs';

const TABLE = JSON.parse(
  readFileSync(new URL('../data/lunar-table.json', import.meta.url), 'utf8'),
);

const LUNAR_DAYS = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];
const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

const SOLAR_FESTIVALS = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '5-1': '劳动节', '5-4': '青年节',
  '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节', '9-10': '教师节',
  '10-1': '国庆', '12-25': '圣诞',
};

const LUNAR_FESTIVALS = {
  '1-1': '春节', '1-15': '元宵', '2-2': '龙抬头', '5-5': '端午',
  '7-7': '七夕', '7-15': '中元', '8-15': '中秋', '9-9': '重阳', '12-8': '腊八',
};

const DEG = Math.PI / 180;
const TERMS = [
  [285, '小寒'], [300, '大寒'], [315, '立春'], [330, '雨水'], [345, '惊蛰'], [0, '春分'],
  [15, '清明'], [30, '谷雨'], [45, '立夏'], [60, '小满'], [75, '芒种'], [90, '夏至'],
  [105, '小暑'], [120, '大暑'], [135, '立秋'], [150, '处暑'], [165, '白露'], [180, '秋分'],
  [195, '寒露'], [210, '霜降'], [225, '立冬'], [240, '小雪'], [255, '大雪'], [270, '冬至'],
];

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

/** 太阳视黄经（Meeus 低精度公式） */
function sunLongitude(j) {
  const T = (j - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * DEG)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M * DEG)
    + 0.000289 * Math.sin(3 * M * DEG);
  const omega = 125.04 - 1934.136 * T;
  return (((L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG)) % 360) + 360) % 360;
}

const termCache = new Map();

/** 按北京时间判定某日是否交节 */
export function termOn(y, m, d) {
  const cacheKey = y + '-' + m + '-' + d;
  if (termCache.has(cacheKey)) return termCache.get(cacheKey);
  const start = Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
  const l0 = sunLongitude(start / 86400000 + 2440587.5);
  const l1 = sunLongitude((start + 86400000) / 86400000 + 2440587.5);
  const span = ((l1 - l0) + 360) % 360;
  let name = null;
  for (const [deg, term] of TERMS) {
    if (((deg - l0) + 360) % 360 < span) { name = term; break; }
  }
  termCache.set(cacheKey, name);
  return name;
}

/** 农历月日；超出表范围返回 null */
export function lunarOf(date) {
  const target = dayNum(date.getFullYear(), date.getMonth() + 1, date.getDate());
  let idx = -1;
  for (let k = 0; k < TABLE.ny.length; k += 1) {
    if (TABLE.ny[k] <= target) idx = k; else break;
  }
  if (idx < 0) return null;

  let offset = target - TABLE.ny[idx];
  const lc = TABLE.leap[idx];
  const leapMonth = lc === '0' ? 0 : ('abc'.includes(lc) ? 10 + 'abc'.indexOf(lc) : Number(lc));
  const row = TABLE.lens.slice(idx * 13, idx * 13 + 13);
  const lenOf = (ch) => (ch === '3' ? 30 : ch === '2' ? 29 : 0);

  for (let m = 1; m <= 12; m += 1) {
    const days = lenOf(row[m - 1]);
    if (offset < days) {
      return {
        year: TABLE.from + idx, month: m, day: offset + 1, leap: false,
        name: LUNAR_MONTH_NAMES[m - 1] + '月',
      };
    }
    offset -= days;
    if (leapMonth === m) {
      const ld = lenOf(row[12]);
      if (offset < ld) {
        return {
          year: TABLE.from + idx, month: m, day: offset + 1, leap: true,
          name: '闰' + LUNAR_MONTH_NAMES[m - 1] + '月',
        };
      }
      offset -= ld;
    }
  }
  return null;
}

/** 节日：农历节日 > 除夕 > 公历节日 */
export function festivalOf(date, lunar) {
  if (lunar && !lunar.leap) {
    const hit = LUNAR_FESTIVALS[lunar.month + '-' + lunar.day];
    if (hit) return hit;
  }
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const nl = lunarOf(next);
  if (nl && !nl.leap && nl.month === 1 && nl.day === 1) return '除夕';
  return SOLAR_FESTIVALS[(date.getMonth() + 1) + '-' + date.getDate()] || null;
}

/** 格子右上角文案：节日 > 节气 > 农历日 */
export function labelOf(date) {
  const lunar = lunarOf(date);
  const festival = festivalOf(date, lunar);
  if (festival) return { text: festival, cls: 'fest', lunar };
  const term = termOn(date.getFullYear(), date.getMonth() + 1, date.getDate());
  if (term) return { text: term, cls: term === '清明' ? 'fest' : 'term', lunar };
  if (!lunar) return { text: '', cls: '', lunar: null };
  if (lunar.day === 1) return { text: lunar.name, cls: '', lunar };
  return { text: LUNAR_DAYS[lunar.day - 1] || '', cls: '', lunar };
}

/** 这一天命中的重要日期：农历按当年农历月日匹配，公历按月日匹配 */
export function eventsOn(date, lunar, events) {
  if (!Array.isArray(events) || !events.length) return [];
  const mm = date.getMonth() + 1;
  const dd = date.getDate();
  return events.filter((e) => {
    if (!e) return false;
    if (e.cal === 'solar') return e.month === mm && e.day === dd;
    if (!lunar || lunar.month !== e.month || lunar.day !== e.day) return false;
    if (!e.leap) return lunar.leap === false;
    /* 策略 A：该年有该闰月就走闰月，没有就走同名平月 */
    const ly = lunar.year - TABLE.from;
    const lc = TABLE.leap[ly];
    const leapMonth = lc === '0' ? 0 : ('abc'.includes(lc) ? 10 + 'abc'.indexOf(lc) : Number(lc));
    return leapMonth === e.month ? lunar.leap === true : lunar.leap === false;
  });
}

/** 生成 7×6 的月网格（含上下月补位） */
export function buildMonth(year, month, events) {
  const startDow = new Date(year, month - 1, 1).getDay();
  const gridStart = new Date(year, month - 1, 1 - startDow);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const info = labelOf(d);
    cells.push({
      key: ymd(d),
      day: d.getDate(),
      outside: d.getMonth() !== month - 1,
      label: info.text,
      kind: info.cls,
      lunarMonth: info.lunar ? info.lunar.month : null,
      lunarDay: info.lunar ? info.lunar.day : null,
      events: eventsOn(d, info.lunar, events).map((e) => e.label),
    });
  }
  return cells;
}

/** 农历月日 → 当年公历日期（策略 A：有该闰月优先走闰月，否则走同名平月） */
export function lunarToSolar(year, month, day, leapWanted) {
  if (year < TABLE.from || year > TABLE.to) return null;
  const matches = [];
  const d = new Date(year, 0, 1);
  while (d.getFullYear() === year) {
    const l = lunarOf(d);
    if (l && l.month === month && l.day === day) matches.push({ key: ymd(d), leap: l.leap });
    d.setDate(d.getDate() + 1);
  }
  if (!matches.length) {
    /* 该月只有 29 天时，农历三十回落到廿九 */
    if (day === 30) return lunarToSolar(year, month, 29, leapWanted);
    return null;
  }
  if (leapWanted) {
    const hit = matches.find((m) => m.leap);
    return hit ? hit.key : matches[0].key;
  }
  const plain = matches.find((m) => !m.leap);
  return plain ? plain.key : matches[0].key;
}

/** 下一次发生的公历日期：今天及以后最近的一次 */
export function nextOccurrence(event, todayStr) {
  if (!event || !event.month || !event.day) return null;
  const today = new Date(todayStr + 'T00:00:00');
  for (let k = 0; k <= 2; k += 1) {
    const y = today.getFullYear() + k;
    let date = null;
    if (event.cal === 'lunar') {
      date = lunarToSolar(y, event.month, event.day, Boolean(event.leap));
    } else {
      let dt = new Date(y, event.month - 1, event.day);
      if (dt.getMonth() !== event.month - 1) dt = new Date(y, event.month - 1, event.day - 1); // 2/29 → 2/28
      date = ymd(dt);
    }
    if (date && date >= todayStr) return date;
  }
  return null;
}

export const TABLE_RANGE = { from: TABLE.from, to: TABLE.to };
