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

【怎么说话（重要）】
- **短**。一般 1–3 句，能一句说完就别两句。用户问一句，你回一段，就是错的。
- 不铺垫、不复述用户的话、不解释"我做了什么操作"的过程，直接给结果。
- 改完东西只说「改了哪条 → 变成什么」，不要把整份清单重读一遍。
- 不列长清单、不写小标题、不总结；用户要细节再展开。
- 每次调用工具之后，**必须给一句人话结论**，不能只调工具不说话。

【需要用户做决定时】
不要只在正文里发问。在正文之后补一个选择块，让用户点按钮就能回答：
<ask>{"options":["今天打完","挪到周三","先跳过"]}</ask>
选项 2–4 个，每个都是用户会直接说出口的一句短话（点一下等于他说了这句）。
正文里说明为什么这么问，选项本身不要重复问题。

【判断依据】
- 【当前待办】里的清单是唯一事实来源。用户提到的事如果清单里已经有了（哪怕措辞不同），
  不要重复创建；先说明它已经存在、在哪个时间，再问要不要改。

【修改与删除已有待办】
- 你可以改和删，但**必须先调用 query_todos 找到目标**（结果每行带 [id] 前缀）。
- 改：用 update_todo 传 id + 要改的字段；清空日期或时间就传空字符串。
- 删：用 delete_todo，**只在用户明确说要删的时候**用，并在回复里复述删掉的是哪一条。
- 匹配到多条或找不到时不要猜：把候选列出来让用户选。

【安全边界（必须遵守）】
- **你不能直接删除或修改数据库以外的东西**；涉及改删时一律走工具，不要声称做了而实际没调用。
- 不做医疗诊断，不给药物建议。用户提到持续失眠、明显躯体症状或自伤念头时，
  认真对待并建议寻求专业帮助，语气自然，不说教。
- 不编造用户没说过的事，也不要假装自己执行过任何操作。不确定就问一句。

【看到图片时：先把它变成文字】
读完图，**第一件事**是把图里的任务结构化成一个块 —— 服务端会把它存进对话历史，
之后的追问都用这份文字，不用再看图：
<shot>{"summary":"这张图是什么","items":[{"title":"...","startDate":"YYYY-MM-DD 或 null","dueDate":"YYYY-MM-DD 或 null","dueTime":"HH:mm 或 null","assignee":"负责人 或 null","note":"图里额外信息 或 null"}]}</shot>
- items 只写图里**真实出现**的事项，不要推测、不要补充
- 甘特图 / 表格按行拆；一行一件事
- 写完这个块再去做「新建还是修改」的判断，prose 里只留一两句人话

【先判断意图：新建 还是 修改】
每收到一张截图或一句话，先做这一步判断，**不要条件反射地出新增草案**：
1. 一律**先调用 query_todos** 取回当前清单，把截图里出现的条目拿去对照。
2. 图上/话里提的事如果**已经存在**（措辞可以不同），这就是「修改」：走 update_todo，
   不要新建一条。改完用自然语言说清楚「哪条、从什么改成什么」。
3. 只有库里确实没有的，才是「新增」，才输出 <todo> 草案块。
4. 分不清就问，并给选项（例如：① 更新已有条目 ② 新建一条）。
5. 一张截图里既有可能要改的、也有全新的：**两者都要处理** —— 旧的用工具改，新的出草案。
6. 只发了截图没配文字时，这个判断更要做：截图可能是在调整已有安排，不一定是新任务。

【识别到待办时】
先输出一个结构化块，再写自然语言回复。块格式严格如下（不要放进代码块）：
<todo>{"tasks":[{"title":"...","startDate":"YYYY-MM-DD 或 null","dueDate":"YYYY-MM-DD 或 null","dueTime":"HH:mm 或 null","tag":"work|life|study|health|money","important":true,"urgent":true,"suggestedDueDate":"YYYY-MM-DD 或 null","notes":"..."}],"missing":["标题"]}</todo>
规则：相对时间必须换算成绝对日期；没说日期填 null 并放进 missing；
一条待办一个 title；没有待办就不要输出这个块。

【开始日与截止日】
- 每条待办要有 startDate（开始做的那天）和 dueDate（做完那天）。
  用户或截图里**明确写了**就照写，不要自己改。
- 没写的由你估，但必须**先调用 query_todos 看整体行程**：避开已有事项堆在一起的日期，
  保证 startDate ≤ dueDate，且中间留出实际能做的天数。
- **日历跨度不等于工作量**：一件从 11/21 拉到 12/6 的事，意思是这段时间在推进它，
  不是"要投入 16 天工时"。别再按跨度折算工时。
- 只有截止日、没有任何开始线索时，按这件事实际需要的天数把开始日往前推
  （例如 165 条剪辑是持续型工作，开始日就贴近它真正开工的那天，而不是平均摊薄）。
- 连截止日都没有时，同时给 startDate 和 suggestedDueDate 一对建议日期。

【怎么判断 important / urgent】
- important 看影响面：做错或不做，会不会影响别人、项目或钱。
- urgent 只看「是不是必须现在处理」：今天不处理会出事、被别人卡住、时间窗固定且挪不了。
- **到期日近本身不算 urgent**。临近截止只是时间信息，不要因为快到期就标紧急，
  否则所有事情最终都会变成紧急，优先级就失去意义了。宁可留 false 让用户自己判断。`;

const TAG_LABEL = { work: '工作', life: '生活', study: '学习', health: '健康', money: '财务' };

export const TODO_QUERY_TOOL = {
  name: 'query_todos',
  description: '查询待办库并返回匹配条目（每行带 [id] 前缀，改/删时要用）。判断是否重复、查看某天安排、统计进度、确认某条是否存在时必须先调用它，不要凭上下文猜。',
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

export const TODO_UPDATE_TOOL = {
  name: 'update_todo',
  description: '修改一条已有待办。必须先用 query_todos 拿到它的 id，只传需要改的字段；把日期或时间清空就传空字符串。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '待办 id，来自 query_todos 结果里的 [id]' },
      title: { type: 'string', description: '新标题' },
      dueDate: { type: 'string', description: '新截止日期 YYYY-MM-DD；空字符串表示清空' },
      startDate: { type: 'string', description: '新开始日期 YYYY-MM-DD；空字符串表示清空' },
      dueTime: { type: 'string', description: '新时间 HH:mm；空字符串表示清空' },
      tag: { type: 'string', enum: ['work', 'life', 'study', 'health', 'money'] },
      important: { type: 'boolean' },
      urgent: { type: 'boolean' },
      done: { type: 'boolean', description: 'true 表示标记完成，false 表示取消完成' },
      notes: { type: 'string' },
    },
    required: ['id'],
  },
};

export const TODO_DELETE_TOOL = {
  name: 'delete_todo',
  description: '删除一条待办。仅在用户明确要求删除时使用；必须先用 query_todos 确认目标 id。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '待办 id，来自 query_todos 结果里的 [id]' },
    },
    required: ['id'],
  },
};

export const TODO_TOOLS = [TODO_QUERY_TOOL, TODO_UPDATE_TOOL, TODO_DELETE_TOOL];

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
    return `- [${String(t.id).slice(0, 8)}] ${when}${t.dueTime ? ' ' + t.dueTime : ''} ${t.title}`
      + `${t.tag ? ' ·' + (TAG_LABEL[t.tag] || t.tag) : ''}`
      + `${flag ? ' [' + flag + ']' : ''}${t.done ? ' [已完成]' : ''}`;
  });

  if (!rows.length) {
    /* 没命中时给最近邻，避免模型换个说法反复重查 */
    const pool = all.filter((t) => (status === 'open' ? !t.done : (status === 'done' ? t.done : true)));
    const kw = String(q.keyword || '').trim();

    const shared = (a, b) => {
      if (!a || !b) return 0;
      if (b.includes(a) || a.includes(b)) return 1;
      const sa = new Set(a.replace(/\s/g, ''));
      const sb = new Set(b.replace(/\s/g, ''));
      if (!sa.size || !sb.size) return 0;
      let hit = 0;
      for (const ch of sa) if (sb.has(ch)) hit += 1;
      return hit / Math.min(sa.size, sb.size);
    };

    let near = [];
    if (kw) {
      near = pool
        .map((t) => ({ t, s: shared(kw, ((t.title || '') + ' ' + (t.notes || '')).toLowerCase()) }))
        .filter((x) => x.s >= 0.34)
        .sort((a, b) => b.s - a.s)
        .slice(0, 3);
    }
    if (!near.length) {
      near = [...pool]
        .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')))
        .slice(0, 3)
        .map((t) => ({ t, s: 0 }));
    }

    if (!near.length) return { text: '库里一条都没有，没有可对照的条目。', count: 0 };

    const nearLines = near.map(({ t }) => {
      const when = t.dueDate ? t.dueDate.slice(5).replace('-', '/') : '未排期';
      return `- [${String(t.id).slice(0, 8)}] ${when}${t.dueTime ? ' ' + t.dueTime : ''} ${t.title}`
        + `${t.tag ? ' ·' + (TAG_LABEL[t.tag] || t.tag) : ''}${t.done ? ' [已完成]' : ''}`;
    });
    return {
      text: '没有精确匹配' + (kw ? `（你查的是「${kw}」）` : '') + '。最接近的是：\n'
        + nearLines.join('\n')
        + '\n\n如果用户要的就是其中一条，直接用它的 id；都不是的话，别再用别的词重查，直接问他要的是哪条。',
      count: rows.length,
    };
  }
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

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 消息时间戳：MM-DD HH:mm */
function stamp(at) {
  if (!at) return '时间未知';
  const d = new Date(at);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

export function buildSystemPrompt({ now, todos, summary, transcript, userProfile, personaName }) {
  const today = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
  const clock = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  const persona = personaName ? PERSONA.replace('「小步」', '「' + personaName + '」') : PERSONA;

  const parts = [
    persona,
    `【时间】现在是 ${today} ${WEEK_CN[now.getDay()]} ${clock}（Asia/Shanghai）。`
      + '未加限定的日期时间都按这个时区和这一刻解释。',
    `【待办库】${brief(today, todos)}\n具体条目不要凭上下文猜 —— 需要时调用 query_todos 查。`,
  ];
  if (summary) parts.push(`【你记得的事】\n${summary}`);

  if (transcript && transcript.length) {
    const last = transcript[transcript.length - 1];
    const gapMs = last && last.at ? now.getTime() - last.at : 0;
    const gapNote = gapMs > 6 * 3600 * 1000
      ? `\n（距上一条消息已过 ${Math.floor(gapMs / 3600000)} 小时 —— 之前提到的"明天/今天"要按那条消息的时间理解，不是现在。）`
      : '';
    parts.push('【最近对话】（每行开头是该消息发出的时间）' + gapNote + '\n'
      + transcript
        .map((m) => {
          const n = (m.images && m.images.length) || 0;
          const mark = n ? `[截图×${n}]` : '';
          const body = [mark, m.text || ''].filter(Boolean).join(' ').trim() || '（空消息）';
          let extra = '';
          const items = m.shot && Array.isArray(m.shot.items) ? m.shot.items : [];
          if (items.length) {
            extra = '\n  （当时从截图识别出的任务：'
              + items.slice(0, 20).map((it, idx) => (idx + 1) + ') '
                + [it.title, it.startDate ? '起 ' + it.startDate : '', it.dueDate ? '止 ' + it.dueDate : '',
                  it.dueTime || '', it.assignee ? '@' + it.assignee : ''].filter(Boolean).join(' ')).join('；')
              + (items.length > 20 ? '；…共 ' + items.length + ' 条' : '') + '）';
          }
          return '[' + stamp(m.at) + '] ' + (m.role === 'user' ? '用户：' : '你：') + body + extra;
        })
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

const BLOCK_NAMES = ['todo', 'ask', 'shot'];

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

  /* 截图识别结果：读一次图，把里面的任务抽成文本，之后对话都用文本 */
  let shot = null;
  if (found.shot) {
    try {
      const data = JSON.parse(found.shot);
      const items = (Array.isArray(data.items) ? data.items : [])
        .map((it) => ({
          title: String((it && it.title) || '').trim(),
          startDate: (it && it.startDate) || null,
          dueDate: (it && it.dueDate) || null,
          dueTime: (it && it.dueTime) || null,
          assignee: (it && it.assignee) || null,
          note: (it && it.note) || null,
        }))
        .filter((it) => it.title)
        .slice(0, 60);
      shot = { summary: String(data.summary || '').slice(0, 300), items };
    } catch (e) {
      shot = null;
    }
  }

  return { prose, tasks, ask, shot };
}

/** 判断是否需要压缩历史（路由侧直接比长度，这里留给将来的细粒度策略） */
