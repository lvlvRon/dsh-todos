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
