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

【需要用户做决定时】
不要只在正文里发问。在正文之后补一个选择块，让用户点按钮就能回答：
<ask>{"options":["今天打完","挪到周三","先跳过"]}</ask>
选项 2–4 个，每个都是用户会直接说出口的一句短话（点一下等于他说了这句）。
正文里说明为什么这么问，选项本身不要重复问题。

【判断依据】
- 【当前待办】里的清单是唯一事实来源。用户提到的事如果清单里已经有了（哪怕措辞不同），
  不要重复创建；先说明它已经存在、在哪个时间，再问要不要改。

【安全边界（必须遵守）】
- **你不能修改或删除已有待办**，只能提出新增草案。用户说「去掉 / 改掉 / 换成」某条时，
  不要声称已经做了 —— 直接说明需要他在列表里操作，或者把要处理的条目标题复述一遍让他确认。
- 不做医疗诊断，不给药物建议。用户提到持续失眠、明显躯体症状或自伤念头时，
  认真对待并建议寻求专业帮助，语气自然，不说教。
- 不编造用户没说过的事，也不要假装自己执行过任何操作。不确定就问一句。

【识别到待办时】
先输出一个结构化块，再写自然语言回复。块格式严格如下（不要放进代码块）：
<todo>{"tasks":[{"title":"...","dueDate":"YYYY-MM-DD 或 null","dueTime":"HH:mm 或 null","tag":"work|life|study|health|money","important":true,"urgent":true,"notes":"..."}],"missing":["标题"]}</todo>
规则：相对时间必须换算成绝对日期；没说日期填 null 并放进 missing；
一条待办一个 title；没有待办就不要输出这个块。

【怎么判断 important / urgent】
- important 看影响面：做错或不做，会不会影响别人、项目或钱。
- urgent 只看「是不是必须现在处理」：今天不处理会出事、被别人卡住、时间窗固定且挪不了。
- **到期日近本身不算 urgent**。临近截止只是时间信息，不要因为快到期就标紧急，
  否则所有事情最终都会变成紧急，优先级就失去意义了。宁可留 false 让用户自己判断。`;

const TAG_LABEL = { work: '工作', life: '生活', study: '学习', health: '健康', money: '财务' };

export const TODO_QUERY_TOOL = {
  name: 'query_todos',
  description: '查询待办库并返回匹配条目。判断是否重复、查看某天安排、统计进度、确认某条是否存在时必须先调用它，不要凭上下文猜。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '标题或备注关键词，例如「体检」' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（含），可省略' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含），可省略' },
      status: { type: 'string', enum: ['open', 'done', 'all'], description: '默认只查未完成' },
    },
  },
};

/** 执行一次待办查询，返回给模型看的紧凑文本 */
export function runTodoQuery(entries, args, today) {
  let q = {};
  try {
    q = JSON.parse(String(args || '{}'));
  } catch (e) {
    q = {};
  }
  const all = entries.map(([, v]) => v);
  const status = q.status === 'done' || q.status === 'all' ? q.status : 'open';

  let rows = all;
  if (status === 'open') rows = rows.filter((t) => !t.done);
  else if (status === 'done') rows = rows.filter((t) => t.done);

  if (q.keyword) {
    const k = String(q.keyword).toLowerCase();
    rows = rows.filter((t) => (t.title || '').toLowerCase().includes(k)
      || (t.notes || '').toLowerCase().includes(k));
  }
  if (q.from) rows = rows.filter((t) => !t.dueDate || t.dueDate >= q.from);
  if (q.to) rows = rows.filter((t) => Boolean(t.dueDate) && t.dueDate <= q.to);

  rows = [...rows].sort((a, b) => {
    const ad = a.dueDate || '9999-12-31';
    const bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.dueTime || '99:99').localeCompare(String(b.dueTime || '99:99'));
  });

  const capped = rows.slice(0, 30);
  const lines = capped.map((t) => {
    const when = t.dueDate
      ? (t.dueDate === today ? '今天' : t.dueDate.slice(5).replace('-', '/'))
      : '未排期';
    const flag = (t.important ? '重要' : '') + (t.important && t.urgent ? '+' : '') + (t.urgent ? '紧急' : '');
    return `- ${when}${t.dueTime ? ' ' + t.dueTime : ''} ${t.title}`
      + `${t.tag ? ' ·' + (TAG_LABEL[t.tag] || t.tag) : ''}`
      + `${flag ? ' [' + flag + ']' : ''}${t.done ? ' [已完成]' : ''}`;
  });

  if (!rows.length) return { text: '没有匹配的条目。', count: 0 };
  const head = `共 ${rows.length} 条匹配${rows.length > capped.length ? '（只列前 30 条）' : ''}：`;
  return { text: head + '\n' + lines.join('\n'), count: rows.length };
}

/** 极简概览：只告诉模型库里有多少，明细让它自己去查 */
function brief(today, todos) {
  const open = todos.filter((t) => !t.done);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
  const todayCount = open.filter((t) => t.dueDate === today);
  return `共 ${todos.length} 条：未完成 ${open.length}（其中逾期 ${overdue.length}、今天到期 ${todayCount.length}），已完成 ${todos.length - open.length}。`;
}

export function buildSystemPrompt({ now, todos, summary, transcript, userProfile }) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const parts = [
    PERSONA,
    `【时间】今天是 ${today} ${WEEK_CN[now.getDay()]}（Asia/Shanghai）。所有相对日期都按这一天换算。`,
    `【待办库】${brief(today, todos)}\n具体条目不要凭上下文猜 —— 需要时调用 query_todos 查。`,
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
 * 从累积文本里剥离结构化块。
 * 流式阶段用于"只吐自然语言"；结束后用于取出结构化结果。
 */

/** 清掉模型偶发的前导 "<" 残渣 */
function tidy(text) {
  return String(text || '').replace(/^\s*<\s*(?!todo>)/, '').replace(/^\s+/, '');
}

const BLOCK_NAMES = ['todo', 'ask'];

function markerAt(raw, i) {
  for (const name of BLOCK_NAMES) {
    const tag = '<' + name + '>';
    if (raw.startsWith(tag, i)) return tag;
  }
  return null;
}

/** 流式可见文本：剔除结构化块（含未闭合的情况），只保留给人看的部分 */
export function visibleText(text) {
  const raw = String(text || '');
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt < 0) { out += raw.slice(i); break; }
    const tag = markerAt(raw, lt);
    if (!tag) {
      const tail = raw.slice(lt);
      /* 可能是半个标记（如 "<as"），先扣住不吐 */
      if (BLOCK_NAMES.some((n) => ('<' + n + '>').startsWith(tail))) {
        out += raw.slice(i, lt);
        return tidy(out);
      }
      out += raw.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    out += raw.slice(i, lt);
    const close = '</' + tag.slice(1, -1) + '>';
    const end = raw.indexOf(close, lt + tag.length);
    if (end < 0) return tidy(out);      // 块未闭合，后面全部扣住
    i = end + close.length;
  }
  return tidy(out);
}

/** 从完整文本里取出结构化块与正文 */
export function extractBlocks(text) {
  const raw = String(text || '');
  const found = {};
  let prose = '';
  let i = 0;
  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt < 0) { prose += raw.slice(i); break; }
    const tag = markerAt(raw, lt);
    if (!tag) { prose += raw.slice(i, lt + 1); i = lt + 1; continue; }
    prose += raw.slice(i, lt);
    const name = tag.slice(1, -1);
    const close = '</' + name + '>';
    const end = raw.indexOf(close, lt + tag.length);
    if (end < 0) { i = raw.length; break; }
    found[name] = raw.slice(lt + tag.length, end);
    i = end + close.length;
  }
  return { prose: tidy(prose).replace(/\n{3,}/g, '\n\n').trim(), found };
}

/** 取出待办草案与选择项 */
export function splitTasks(text) {
  const { prose, found } = extractBlocks(text);

  let tasks = null;
  if (found.todo) {
    try {
      const data = JSON.parse(found.todo);
      tasks = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        missing: Array.isArray(data.missing) ? data.missing : [],
      };
    } catch (e) {
      tasks = { tasks: [], missing: [], error: 'todo 块 JSON 解析失败' };
    }
  }

  let ask = null;
  if (found.ask) {
    try {
      const data = JSON.parse(found.ask);
      const options = (Array.isArray(data.options) ? data.options : [])
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 4);
      if (options.length) ask = { options };
    } catch (e) {
      ask = null;
    }
  }

  return { prose, tasks, ask };
}

/** 判断是否需要压缩历史（路由侧直接比长度，这里留给将来的细粒度策略） */
