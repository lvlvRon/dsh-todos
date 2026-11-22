// 历法验证脚本（不进插件）：节气算法 + 节日推导
// 用法: node solar-terms.mjs

const DEG = Math.PI / 180;
const jd = ms => ms / 86400000 + 2440587.5;

/** 太阳视黄经（Meeus 低精度公式，误差约 0.01° ≈ 15 分钟） */
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

const TERMS = [
  [285, '小寒'], [300, '大寒'], [315, '立春'], [330, '雨水'], [345, '惊蛰'], [0, '春分'],
  [15, '清明'], [30, '谷雨'], [45, '立夏'], [60, '小满'], [75, '芒种'], [90, '夏至'],
  [105, '小暑'], [120, '大暑'], [135, '立秋'], [150, '处暑'], [165, '白露'], [180, '秋分'],
  [195, '寒露'], [210, '霜降'], [225, '立冬'], [240, '小雪'], [255, '大雪'], [270, '冬至'],
];

function termOn(y, m, d) {
  const start = Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
  const l0 = sunLongitude(jd(start));
  const l1 = sunLongitude(jd(start + 86400000));
  const span = ((l1 - l0) + 360) % 360;
  for (const [deg, name] of TERMS) if (((deg - l0) + 360) % 360 < span) return name;
  return null;
}

const EXPECT_2026 = {
  '01-05': '小寒', '01-20': '大寒', '02-04': '立春', '02-18': '雨水',
  '03-05': '惊蛰', '03-20': '春分', '04-05': '清明', '04-20': '谷雨',
  '05-05': '立夏', '05-21': '小满', '06-05': '芒种', '06-21': '夏至',
  '07-07': '小暑', '07-23': '大暑', '08-07': '立秋', '08-23': '处暑',
  '09-07': '白露', '09-23': '秋分', '10-08': '寒露', '10-23': '霜降',
  '11-07': '立冬', '11-22': '小雪', '12-07': '大雪', '12-22': '冬至',
};

let bad = 0;
for (const [md, name] of Object.entries(EXPECT_2026)) {
  const got = termOn(2026, Number(md.slice(0, 2)), Number(md.slice(3)));
  if (got !== name) { bad++; console.log(`  ✗ 2026-${md} 期望=${name} 得到=${got ?? '(无)'}`); }
}
console.log(bad === 0 ? '== 节气：2026 年 24/24 全部吻合 ==' : `== 节气：${bad} 处不一致 ==`);

const SPOT = [[2024,'02-04','立春'],[2024,'12-21','冬至'],[2025,'02-03','立春'],
  [2027,'02-04','立春'],[2027,'12-22','冬至'],[2030,'03-20','春分'],[2030,'06-21','夏至']];
let sbad = 0;
for (const [y, md, name] of SPOT) {
  const got = termOn(y, Number(md.slice(0,2)), Number(md.slice(3)));
  if (got !== name) { sbad++; console.log(`  ✗ ${y}-${md} 期望=${name} 得到=${got ?? '(无)'}`); }
}
console.log(sbad === 0 ? `== 节气：其他年份抽查 ${SPOT.length}/${SPOT.length} 通过 ==` : `== 节气：抽查 ${sbad} 处不一致 ==`);

// ---------- 节日推导 ----------
const lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });
const LUNAR_MONTH_NUM = {
  '正月':1,'一月':1,'二月':2,'三月':3,'四月':4,'五月':5,'六月':6,
  '七月':7,'八月':8,'九月':9,'十月':10,'十一月':11,'冬月':11,'十二月':12,'腊月':12,
};
const LUNAR_FESTIVALS = {
  '1-1':'春节','1-15':'元宵','2-2':'龙抬头','5-5':'端午',
  '7-7':'七夕','7-15':'中元','8-15':'中秋','9-9':'重阳','12-8':'腊八',
};
const SOLAR_FESTIVALS = {
  '1-1':'元旦','2-14':'情人节','3-8':'妇女节','5-1':'劳动节','5-4':'青年节',
  '6-1':'儿童节','7-1':'建党节','8-1':'建军节','9-10':'教师节','10-1':'国庆','12-25':'圣诞',
};

const lpCache = new Map();
function lunarParts(date) {
  const key = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
  if (lpCache.has(key)) return lpCache.get(key);
  let res = null;
  try {
    const parts = lunarFmt.formatToParts(date);
    const name = (parts.find(p => p.type === 'month') || {}).value || '';
    const day = Number.parseInt((parts.find(p => p.type === 'day') || {}).value || '', 10);
    const leap = name.startsWith('闰');
    const month = LUNAR_MONTH_NUM[leap ? name.slice(1) : name];
    if (month && !Number.isNaN(day)) res = { month, day, leap, name };
  } catch (e) { /* 无中华历支持 */ }
  lpCache.set(key, res);
  return res;
}

function festivalOf(date) {
  const lp = lunarParts(date);
  if (lp && !lp.leap) {
    const n = LUNAR_FESTIVALS[lp.month + '-' + lp.day];
    if (n) return n;
  }
  const nx = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
  const np = lunarParts(nx);
  if (np && !np.leap && np.month === 1 && np.day === 1) return '除夕';
  return SOLAR_FESTIVALS[(date.getMonth() + 1) + '-' + date.getDate()] || null;
}

const at = (y, m, d) => new Date(y, m - 1, d, 12);

const EXPECT_FEST_2026 = {
  '02-17':'春节','03-03':'元宵','03-20':'龙抬头','06-19':'端午',
  '08-19':'七夕','08-27':'中元','09-25':'中秋','10-18':'重阳',
  '01-01':'元旦','05-01':'劳动节','10-01':'国庆','12-25':'圣诞',
};
let fbad = 0;
for (const [md, name] of Object.entries(EXPECT_FEST_2026)) {
  const got = festivalOf(at(2026, Number(md.slice(0, 2)), Number(md.slice(3))));
  if (got !== name) { fbad++; console.log(`  ✗ 2026-${md} 期望=${name} 得到=${got ?? '(无)'}`); }
}
console.log(fbad === 0 ? '== 节日：2026 年 12/12 全部吻合 ==' : `== 节日：${fbad} 处不一致 ==`);

// 任意年份：把农历节日打印出来，便于人工对照
for (const y of [2025, 2027, 2028]) {
  const hits = [];
  for (let m = 1; m <= 12; m++) {
    const days = new Date(y, m, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const date = at(y, m, d);
      const f = festivalOf(date);
      const lunarHoliday = ['春节','元宵','龙抬头','端午','七夕','中元','中秋','重阳','腊八','除夕'].includes(f);
      if (lunarHoliday) hits.push(`${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${f}`);
    }
  }
  console.log(`== ${y} 农历节日：${hits.join(' · ')} ==`);
}
