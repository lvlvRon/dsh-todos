/**
 * 助手人格与上下文。
 *
 * 设计要点：
 * - 一个调用同时承担两件事：像人一样对话（时间管理/效率/情绪支持），
 *   以及在识别到待办时输出结构化块。
 * - 结构化块用 <todo> ... </todo> 包裹，服务端在流式输出时把它过滤掉，
 *   客户端只看到自然语言；解析后的任务单独作为 draft 事件下发。
 */

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const PERSONA = `你是「小步」，用户待办与日程的管理助手。你的风格：简短、具体、有温度，不说套话。

【你能做三件事】
1. 把用户给的内容（文字或截图）里的待办识别出来。
2. 帮用户安排时间、判断优先级（重要 × 紧急四象限）、提醒过载。
3. 关注人的状态：用户明显疲惫或压力大时，可以给一句实在的话或建议休息；
   不灌鸡汤，不说教。

【安全边界（必须遵守）】
- 不做医疗诊断，不给药物建议。用户提到持续失眠、明显躯体症状或自伤念头时，
  认真对待并建议寻求专业帮助，语气自然，不说教。
- 不编造用户没说过的事。不确定就问一句。

【识别到待办时】
先输出一个结构化块，再写自然语言回复。块格式严格如下（不要放进代码块）：
<todo>{"tasks":[{"title":"...","dueDate":"YYYY-MM-DD 或 null","dueTime":"HH:mm 或 null","tag":"work|life|study|health|money","important":true,"urgent":true,"notes":"..."}],"missing":["标题"]}</todo>
规则：相对时间必须换算成绝对日期；没说日期填 null 并放进 missing；
一条待办一个 title；没有待办就不要输出这个块。`;

/** 今天的待办快照，作为每轮上下文 */
function snapshot(today, todos) {
  const done = todos.filter((t) => t.done).length;
  const open = todos.filter((t) => !t.done);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
  const dueToday = open.filter((t) => t.dueDate === today);
  const lines = [];
  lines.push(`今天共 ${todos.length} 条，已完成 ${done} 条，未完成 ${open.length} 条。`);
  if (overdue.length) lines.push('逾期：' + overdue.map((t) => t.title).join('、'));
  if (dueToday.length) {
    lines.push('今天：' + dueToday.map((t) => (t.dueTime ? t.dueTime + ' ' : '') + t.title).join('、'));
  }
  const undated = open.filter((t) => !t.dueDate);
  if (undated.length) lines.push('未排期：' + undated.slice(0, 8).map((t) => t.title).join('、'));
  return lines.join('\n');
}

export function buildSystemPrompt({ now, todos, summary, transcript, userProfile }) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const parts = [
    PERSONA,
    `【时间】今天是 ${today} ${WEEK_CN[now.getDay()]}（Asia/Shanghai）。`,
    `【当前待办】\n${snapshot(today, todos)}`,
  ];
  if (summary) parts.push(`【你记得的事】\n${summary}`);
  if (transcript && transcript.length) {
    parts.push('【最近对话】\n' + transcript
      .map((m) => (m.role === 'user' ? '用户：' : '你：') + m.text)
      .join('\n'));
  }
  if (userProfile) parts.push(`【用户偏好】\n${userProfile}`);
  return parts.join('\n\n');
}

/**
 * 从累积文本里剥离 <todo> 块。
 * 流式阶段用于"只吐自然语言"；结束后用于取出结构化结果。
 */
export function splitTasks(text) {
  const raw = String(text || '');
  const start = raw.indexOf('<todo>');
  let prose = raw;
  let block = null;
  if (start >= 0) {
    const end = raw.indexOf('</todo>', start);
    prose = raw.slice(0, start) + (end >= 0 ? raw.slice(end + 7) : '');
    if (end >= 0) block = raw.slice(start + 6, end);
  }
  const trimmed = tidy(prose).replace(/\n{3,}/g, '\n\n').trim();

  let parsed = null;
  if (block) {
    try {
      const data = JSON.parse(block);
      parsed = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        missing: Array.isArray(data.missing) ? data.missing : [],
      };
    } catch (e) {
      parsed = { tasks: [], missing: [], error: 'todo 块 JSON 解析失败' };
    }
  }
  return { prose: trimmed, tasks: parsed };
}

/** 清掉模型偶发的前导 "<" 残渣 */
function tidy(text) {
  return String(text || '').replace(/^\s*<\s*(?!todo>)/, '').replace(/^\s+/, '');
}

/** 流式可见文本：剔除 <todo> 块（含未闭合的情况），只保留给人看的部分 */
export function visibleText(text) {
  const raw = String(text || '');
  const start = raw.indexOf('<todo>');
  if (start >= 0) {
    const end = raw.indexOf('</todo>', start);
    return tidy(end < 0 ? raw.slice(0, start) : raw.slice(0, start) + raw.slice(end + 7));
  }
  /* 还没出现完整标记：若结尾像半个标记就先扣住不吐 */
  for (let k = 1; k <= 6 && k <= raw.length; k += 1) {
    const tail = raw.slice(-k);
    if (tail.startsWith('<') && '<todo>'.startsWith(tail)) return tidy(raw.slice(0, raw.length - k));
  }
  return tidy(raw);
}

/** 判断是否需要压缩历史 */
export function needsSummary(messages, summary, limit = 24) {
  if (messages.length <= limit) return false;
  if (summary && summary.upto >= messages.length - limit) return false;
  return true;
}
