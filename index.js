/**
 * Host 半：待办插件。
 *
 * P1：真实数据层 —— 存储域 + 增删改查路由。
 * 通道契约见 @deepseek-ai/dsh-host-webserver/src/index.ts：
 *   WebRoute = { kind, path, handler(req: IncomingMessage, res: ServerResponse) }
 */


import { readFileSync, readdirSync } from 'node:fs';

import { todoSpec, normalize, compare, now } from './lib/domain.js';
import { send, fail, readJson, guard, openSse } from './lib/channel.js';
import { buildMonth, TABLE_RANGE, nextOccurrence } from './lib/calendar.js';
import { buildSystemPrompt, splitTasks, visibleText, TODO_TOOLS, runTodoQuery } from './lib/chat.js';

export const inject = ['webServer', 'storageDomain'];
export const name = 'todo';


const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const modelInfoCache = new Map();

/** 模型上下文窗口（带缓存） */
async function contextWindowOf(llm, provider, model) {
  const key = provider + '/' + model;
  if (modelInfoCache.has(key)) return modelInfoCache.get(key);
  let total = 0;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    total = info && info.context ? info.context.contextWindow : 0;
  } catch (e) {
    total = 0;
  }
  modelInfoCache.set(key, total);
  return total;
}

/** 粗算 token 估算：中日韩字符约 1.5 字/token，ASCII 约 4 字/token */
function estimateTokens(texts) {
  let cjk = 0;
  let ascii = 0;
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    for (const ch of t) {
      if (ch.codePointAt(0) > 255) cjk += 1;
      else ascii += 1;
    }
  }
  return Math.ceil(cjk / 1.5 + ascii / 4);
}

/** 抽取用的系统提示：要求模型只吐 JSON，并把相对日期换算成绝对日期 */
function extractionPrompt(now) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  return [
    '你是待办抽取器。把用户给出的文本或截图里的所有事项提取成待办。',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。',
    '格式：{"tasks":[{"title":"...","dueDate":"YYYY-MM-DD 或 null","dueTime":"HH:mm 或 null","tag":"work|life|study|health|money","important":true,"urgent":true,"notes":"..."}],"missing":["标题"]}',
    '规则：',
    '1. 相对时间（明天/下周三/月底）必须换算成绝对日期。',
    '2. 没说日期的 dueDate 填 null，并把该条标题放进 missing 数组。',
    '3. important 看影响面（做错或不做会不会影响别人/项目/钱）。',
    '4. urgent 只看"是不是必须现在处理"：今天不处理会出事、被别人卡住、时间窗固定且挪不了。',
    '   到期日近本身不算 urgent —— 临近截止只是时间信息，不要因此把 urgent 设为 true。',
    '   宁可标 urgent=false 让人自己判断，也不要把所有快到期的都标成紧急。',
    '5. tag 只能从 work/life/study/health/money 里选。',
    '6. 一条待办一个 title，不要把多个事项塞进一条。',
    '今天是 ' + today + ' ' + WEEK_CN[now.getDay()] + '，时区 Asia/Shanghai。',
  ].join('\n');
}

/** 从模型输出里抠出 JSON（容忍前后杂讯） */
function parseExtraction(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, error: 'no JSON found in model output', sample: text.slice(0, 300) };
  }
  try {
    const data = JSON.parse(text.slice(start, end + 1));
    return {
      ok: true,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      missing: Array.isArray(data.missing) ? data.missing : [],
    };
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + e.message, sample: text.slice(0, 300) };
  }
}

export async function apply(ctx) {
  /* ---------- 存储域 ---------- */
  const domain = await ctx.storageDomain.open(todoSpec);
  ctx.effect(() => () => { domain.close().catch(() => {}); });
  const table = domain.table('todos');
  const settings = domain.table('settings');
  const conversations = domain.table('conversation');
  const events = domain.table('events');
  const personas = domain.table('persona');
  const DEFAULT_NAME = '小步';

  /** 当前助手形象 */
  function currentPersona() {
    const p = personas.get('default');
    return {
      name: (p && p.name) || DEFAULT_NAME,
      avatar: p && p.avatar ? p.avatar : null,
    };
  }
  const MODEL_KEY = 'chat-model';
  const CONV_KEY = 'default';
  const HISTORY_LIMIT = 12;
  const SUMMARY_TRIGGER = 30;

  /** 当前生效的模型：用户选过就用选的，否则跟 DSH 默认 */
  function currentModel() {
    const saved = settings.get(MODEL_KEY);
    if (saved && saved.provider && saved.model) {
      return {
        provider: saved.provider,
        model: saved.model,
        reasoningEffort: saved.reasoningEffort || null,
        source: 'saved',
      };
    }
    const adm = ctx.get('agentDefaultModel');
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
    if (sel && sel.provider && sel.model) {
      return {
        provider: sel.provider,
        model: sel.model,
        reasoningEffort: sel.reasoningEffort || null,
        source: 'default',
      };
    }
    return null;
  }

  ctx.logger?.info?.('[todo] storage domain ready');

  /* ---------- 路由 ---------- */
  const route = (r) => ctx.effect(() => ctx.webServer.register(r));

  const listAll = () => [...table.entries()].map(([, v]) => v).sort(compare);

  /* 探活 */
  route({
    kind: 'exact',
    path: '/api/todo/ping',
    handler: (req, res) => send(res, 200, { ok: true, count: table.size, at: new Date().toISOString() }),
  });




  /* 可用模型清单（含是否支持图片）*/
  route({
    kind: 'exact',
    path: '/api/todo/models',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const llm = ctx.get('llm');
      if (!llm) return fail(res, 503, 'llm service unavailable');
      try {
        const providers = await llm.listProviders();
        const out = [];
        for (const p of providers) {
          let models = [];
          try {
            models = await llm.listModels(p.id);
          } catch (e) {
            models = [];
          }
          out.push({
            id: p.id,
            name: p.name,
            models: models.map((m) => ({
              id: m.id,
              name: m.name || m.id,
              image: Array.isArray(m.inputModalities) ? m.inputModalities.includes('image') : null,
            })),
          });
        }
        send(res, 200, { ok: true, providers: out, current: currentModel() });
      } catch (e) {
        fail(res, 500, 'list models failed: ' + (e && e.message));
      }
    },
  });

  /* 当前模型的思考等级选项 */
  route({
    kind: 'exact',
    path: '/api/todo/reasoning',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const llm = ctx.get('llm');
      const cur = currentModel();
      if (!llm || !cur) return send(res, 200, { ok: true, efforts: [] });
      try {
        const info = await llm.resolveModelInfo(cur.provider, cur.model);
        send(res, 200, {
          ok: true,
          efforts: (info.reasoning && info.reasoning.efforts) || [],
          current: cur.reasoningEffort || null,
        });
      } catch (e) {
        send(res, 200, { ok: true, efforts: [], error: String(e && e.message) });
      }
    },
  });

  /* 选择模型；传空对象表示恢复跟随 DSH 默认 */
  route({
    kind: 'exact',
    path: '/api/todo/model',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req);
        if (body && body.provider && body.model) {
          const prev = settings.get(MODEL_KEY);
          const sameModel = prev && prev.provider === body.provider && prev.model === body.model;
          const effort = body.reasoningEffort !== undefined
            ? (body.reasoningEffort || null)
            : (sameModel ? prev.reasoningEffort : null);
          await settings.put(MODEL_KEY, {
            provider: String(body.provider),
            model: String(body.model),
            reasoningEffort: effort || null,
          });
        } else {
          await settings.delete(MODEL_KEY);
        }
        send(res, 200, { ok: true, current: currentModel() });
      } catch (e) {
        fail(res, 400, 'select model failed: ' + (e && e.message));
      }
    },
  });

  /* 月历网格：农历 / 节气 / 节日，7×6 含上下月补位 */
  route({
    kind: 'exact',
    path: '/api/todo/month',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      try {
        const url = new URL(req.url, 'http://localhost');
        const today = new Date();
        const y = Number(url.searchParams.get('y')) || today.getFullYear();
        const m = Number(url.searchParams.get('m')) || (today.getMonth() + 1);
        if (!(y >= TABLE_RANGE.from && y <= TABLE_RANGE.to) || !(m >= 1 && m <= 12)) {
          return fail(res, 400, 'year/month out of supported range (' + TABLE_RANGE.from + '-' + TABLE_RANGE.to + ')');
        }
        send(res, 200, {
          ok: true,
          y,
          m,
          cells: buildMonth(y, m, [...events.entries()].map(([, v]) => v)),
          range: TABLE_RANGE,
        });
      } catch (e) {
        fail(res, 500, 'build month failed: ' + (e && e.message));
      }
    },
  });

  /** 滚动摘要：把最老的一段压成记忆，控制上下文长度 */
  async function summarizeOldest() {
    const llm = ctx.get('llm');
    if (!llm) return;
    const conv = conversations.get(CONV_KEY);
    if (!conv || !Array.isArray(conv.messages)) return;
    const msgs = conv.messages;
    if (msgs.length <= SUMMARY_TRIGGER) return;

    const head = msgs.slice(0, 10);
    const rest = msgs.slice(10);
    const selection = currentModel();
    if (!selection) return;

    let out = '';
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || undefined,
      system: '把下面的对话压缩成不超过 120 字的中文摘要，保留用户的偏好、计划、情绪线索和未完成事项。只输出摘要正文。',
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: head.map((m) => (m.role === 'user' ? '用户：' : '你：') + m.text).join('\n'),
        }],
      }],
    })) {
      if (chunk.type === 'text-delta') out += chunk.text;
    }
    const merged = [conv.summary, out.trim()].filter(Boolean).join('\n');
    await conversations.put(CONV_KEY, { messages: rest, summary: merged, updatedAt: now() });
  }

  /* 助手对话：自然语言 + 识别到待办时附结构化块 */
  route({
    kind: 'exact',
    path: '/api/todo/chat',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      let body;
      try {
        body = await readJson(req, 12 * 1024 * 1024);
      } catch (e) {
        return fail(res, 400, 'bad body: ' + e.message);
      }

      const llm = ctx.get('llm');
      const attachments = ctx.get('attachments');
      if (!llm) return fail(res, 503, 'llm unavailable');

      const sse = openSse(res);
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      try {
        const selection = currentModel();
        if (!selection) {
          sse.event('error', { message: '没有可用模型' });
          return;
        }

        const conv = conversations.get(CONV_KEY)
          || { messages: [], summary: null, updatedAt: now() };

        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];

        const content = [];
        const imageRefs = [];
        if (text) content.push({ type: 'text', text });
        for (const img of images) {
          const raw = Buffer.from(String((img && img.data) || ''), 'base64');
          if (!raw.length || !attachments) continue;
          const ref = await attachments.saveImage({
            data: new Uint8Array(raw),
            mediaType: (img && img.mediaType) || 'image/png',
            name: 'todo-shot',
          });
          content.push({ type: 'image', attachment: ref });
          imageRefs.push(ref);
        }
        if (!content.length) {
          sse.event('error', { message: 'empty input: need text or image' });
          return;
        }

        const system = buildSystemPrompt({
          now: new Date(),
          todos: [...table.entries()].map(([, v]) => v),
          summary: conv.summary || '',
          transcript: (conv.messages || []).slice(-HISTORY_LIMIT),
          personaName: currentPersona().name,
        });

        const textParts = [system, ...content.filter((c) => c.type === 'text').map((c) => c.text)];
        const usedTokens = estimateTokens(textParts) + images.length * 800;
        const totalTokens = await contextWindowOf(llm, selection.provider, selection.model);

        sse.event('start', {
          provider: selection.provider,
          model: selection.model,
          context: { used: usedTokens, total: totalTokens },
        });

        let acc = '';
        let sent = 0;
        let rounds = 0;
        const usedTools = [];
        const mutated = { updated: 0, deleted: 0 };
        const convo = [{ role: 'user', content }];
        const pad2 = (n) => String(n).padStart(2, '0');
        const todayStr = new Date().getFullYear() + '-' + pad2(new Date().getMonth() + 1) + '-' + pad2(new Date().getDate());

        /* 工具循环：模型需要库里的明细时自己发起查询，最多 3 轮 */
        while (rounds < 3) {
          rounds += 1;
          const calls = [];
          for await (const chunk of llm.stream({
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort || undefined,
            system,
            messages: convo,
            tools: TODO_TOOLS,
            signal: controller.signal,
          })) {
            if (chunk.type === 'text-delta') {
              acc += chunk.text;
              const visible = visibleText(acc);
              if (visible.length > sent) {
                sse.event('delta', { text: visible.slice(sent) });
                sent = visible.length;
              }
            } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
              calls.push(chunk.block);
            } else if (chunk.type === 'finish') {
              const kind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'stop';
              if (kind === 'error' && chunk.reason.failure) {
                sse.event('error', { message: chunk.reason.failure.message || 'model error' });
              }
            }
          }
          if (!calls.length) break;

          convo.push({
            id: 'a_' + Date.now() + '_' + rounds,
            createdAt: Date.now(),
            role: 'assistant',
            source: { kind: 'model', provider: selection.provider, model: selection.model },
            content: calls.map((c) => ({
              type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments,
            })),
          });

          /* 按 id 或 id 前缀定位一条待办 */
          const resolveTodo = (raw) => {
            const key = String(raw || '').trim();
            if (!key) return null;
            const all = [...table.entries()].map(([, v]) => v);
            const exact = all.find((t) => t.id === key);
            if (exact) return exact;
            const hits = all.filter((t) => String(t.id).startsWith(key));
            return hits.length === 1 ? hits[0] : null;
          };

          for (const call of calls) {
            let result = { text: '未知工具：' + call.name, count: 0 };
            let args = {};
            try { args = JSON.parse(String(call.arguments || '{}')); } catch (e) { args = {}; }

            if (call.name === 'query_todos') {
              result = runTodoQuery([...table.entries()], call.arguments, todayStr);
            } else if (call.name === 'delete_todo') {
              const target = resolveTodo(args.id);
              if (!target) {
                result = { text: '找不到 id 为 ' + args.id + ' 的待办，请先用 query_todos 确认。', count: 0 };
              } else {
                await table.delete(target.id);
                mutated.deleted += 1;
                result = { text: '已删除「' + target.title + '」', count: 1 };
              }
            } else if (call.name === 'update_todo') {
              const target = resolveTodo(args.id);
              if (!target) {
                result = { text: '找不到 id 为 ' + args.id + ' 的待办，请先用 query_todos 确认。', count: 0 };
              } else {
                const next = { ...target };
                if (args.title !== undefined) next.title = String(args.title);
                if (args.dueDate !== undefined) next.dueDate = args.dueDate ? String(args.dueDate) : null;
                if (args.startDate !== undefined) next.startDate = args.startDate ? String(args.startDate) : null;
                if (args.dueTime !== undefined) next.dueTime = args.dueTime ? String(args.dueTime) : null;
                if (args.tag !== undefined) next.tag = String(args.tag);
                if (args.important !== undefined) next.important = Boolean(args.important);
                if (args.urgent !== undefined) next.urgent = Boolean(args.urgent);
                if (args.done !== undefined) next.done = Boolean(args.done);
                if (args.notes !== undefined) next.notes = args.notes == null ? null : String(args.notes);
                const saved = normalize(next, target);
                if (!saved.title) {
                  result = { text: '标题不能为空，未修改。', count: 0 };
                } else {
                  await table.put(saved.id, saved);
                  mutated.updated += 1;
                  result = {
                    text: '已更新「' + saved.title + '」：'
                      + (saved.dueDate || '无日期') + (saved.dueTime ? ' ' + saved.dueTime : '')
                      + (saved.done ? '（已完成）' : ''),
                    count: 1,
                  };
                }
              }
            }
            usedTools.push({ name: call.name, count: result.count });
            sse.event('tool', { name: call.name, count: result.count });
            convo.push({
              id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
              createdAt: Date.now(),
              role: 'tool',
              source: { kind: 'tool', callId: call.id },
              toolCallId: call.id,
              content: [{ type: 'text', text: result.text }],
            });
          }
        }
        if (mutated.updated || mutated.deleted) sse.event('mutated', mutated);
        sse.event('finish', { reason: 'stop' });

        const { prose, tasks, ask } = splitTasks(acc);
        if (tasks) sse.event('draft', tasks);
        if (ask) sse.event('ask', ask);

        const messages = [
          ...(conv.messages || []),
          {
            role: 'user',
            text: text || '（截图）',
            at: Date.now(),
            images: imageRefs.length ? imageRefs : null,
          },
          {
            role: 'assistant',
            text: prose,
            at: Date.now(),
            tools: usedTools.length ? usedTools : null,
            drafts: tasks && tasks.tasks && tasks.tasks.length ? tasks.tasks : null,
            missing: tasks && tasks.missing && tasks.missing.length ? tasks.missing : null,
            ask: ask && ask.options && ask.options.length ? ask.options : null,
          },
        ].slice(-200);
        await conversations.put(CONV_KEY, {
          messages,
          summary: conv.summary || null,
          updatedAt: now(),
        });

        if (messages.length > SUMMARY_TRIGGER) {
          summarizeOldest().catch(() => {});
        }
      } catch (e) {
        try { sse.event('error', { message: String((e && e.message) || e) }); } catch (x) { /* ignore */ }
      } finally {
        sse.close();
      }
    },
  });

  /* 重要日期（农历生日/纪念日）*/
  route({
    kind: 'exact',
    path: '/api/todo/events',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const pad2 = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const today = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

      const rows = [...events.entries()].map(([, v]) => {
        const next = nextOccurrence(v, today);
        const daysLeft = next
          ? Math.round((Date.parse(next) - Date.parse(today)) / 86400000)
          : null;
        return { ...v, next, daysLeft };
      }).sort((a, b) => {
        const ad = a.daysLeft === null ? 1e9 : a.daysLeft;
        const bd = b.daysLeft === null ? 1e9 : b.daysLeft;
        return ad - bd;
      });

      send(res, 200, { ok: true, events: rows, today });
    },
  });

  route({
    kind: 'exact',
    path: '/api/todo/event',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req);
        const input = body && body.event ? body.event : body;
        if (!input || !input.label || !input.cal || !input.month || !input.day) {
          return fail(res, 400, 'label / cal / month / day are required');
        }
        const id = input.id || ('e_' + Math.random().toString(36).slice(2, 10));
        const event = {
          id,
          label: String(input.label),
          type: ['birthday', 'anniversary', 'memorial', 'other'].includes(input.type) ? input.type : 'other',
          cal: input.cal === 'lunar' ? 'lunar' : 'solar',
          month: Number(input.month),
          day: Number(input.day),
          leap: input.cal === 'lunar' ? Boolean(input.leap) : null,
          notes: input.notes ? String(input.notes) : null,
        };
        await events.put(id, event);
        send(res, 200, { ok: true, event });
      } catch (e) {
        fail(res, 400, 'save event failed: ' + (e && e.message));
      }
    },
  });

  route({
    kind: 'exact',
    path: '/api/todo/event-remove',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const { id } = await readJson(req);
        if (!id) return fail(res, 400, 'id is required');
        send(res, 200, { ok: true, removed: await events.delete(id) });
      } catch (e) {
        fail(res, 400, 'remove event failed: ' + (e && e.message));
      }
    },
  });

  /* 历史对话（面板重开时回填）*/
  route({
    kind: 'exact',
    path: '/api/todo/conversation',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const conv = conversations.get(CONV_KEY) || { messages: [], summary: null, updatedAt: null };

      /* 顺便算一次「下一轮大概会用掉多少上下文」，供面板显示 */
      let context = null;
      try {
        const selection = currentModel();
        const system = buildSystemPrompt({
          now: new Date(),
          todos: [...table.entries()].map(([, v]) => v),
          summary: conv.summary || '',
          transcript: (conv.messages || []).slice(-HISTORY_LIMIT),
          personaName: currentPersona().name,
        });
        const llm = ctx.get('llm');
        const total = llm && selection
          ? await contextWindowOf(llm, selection.provider, selection.model)
          : 0;
        context = { used: estimateTokens([system]), total };
      } catch (e) {
        context = null;
      }

      send(res, 200, {
        ok: true,
        messages: (conv.messages || []).slice(-60).map((m) => ({
          role: m.role,
          text: m.text,
          images: (m.images || []).map((r) => ({
            id: r.attachmentId,
            width: r.width,
            height: r.height,
          })),
          drafts: m.drafts || null,
          missing: m.missing || null,
          ask: m.ask || null,
          tools: m.tools || null,
        })),
        total: (conv.messages || []).length,
        summary: conv.summary || null,
        updatedAt: conv.updatedAt || null,
        context,
      });
    },
  });

  /* 取图：按对话记录里的引用读回原始字节 */
  route({
    kind: 'exact',
    path: '/api/todo/shot',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const attachments = ctx.get('attachments');
      if (!attachments) return fail(res, 503, 'attachments unavailable');
      try {
        const url = new URL(req.url, 'http://localhost');
        const id = url.searchParams.get('ref');
        if (!id) return fail(res, 400, 'ref is required');

        const conv = conversations.get(CONV_KEY);
        let ref = null;
        for (const m of (conv && conv.messages) || []) {
          for (const r of m.images || []) {
            if (r && r.attachmentId === id) ref = r;
          }
        }
        if (!ref) return fail(res, 404, 'image not found in conversation');

        const stored = await attachments.readImage(ref);
        const buf = Buffer.from(stored.data);
        res.writeHead(200, {
          'content-type': (stored.ref && stored.ref.mediaType) || ref.mediaType || 'application/octet-stream',
          'content-length': buf.length,
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(buf);
      } catch (e) {
        fail(res, 500, 'read image failed: ' + (e && e.message));
      }
    },
  });

  /* 清空对话（连同摘要一起清，模型也随之忘记）*/
  route({
    kind: 'exact',
    path: '/api/todo/conversation-clear',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        await conversations.delete(CONV_KEY);
        send(res, 200, { ok: true });
      } catch (e) {
        fail(res, 500, 'clear failed: ' + (e && e.message));
      }
    },
  });

  /* 导出：待办 + 重要日期，含已完成 */
  route({
    kind: 'exact',
    path: '/api/todo/export',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const payload = {
        format: 'dsh-plugin-todo',
        version: 1,
        exportedAt: new Date().toISOString(),
        todos: listAll(),
        events: [...events.entries()].map(([, v]) => v),
      };
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="dsh-todos.json"',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(payload, null, 2));
    },
  });

  /* 导入：按 id 合并（有则覆盖，无则新增） */
  route({
    kind: 'exact',
    path: '/api/todo/import',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req, 16 * 1024 * 1024);
        const list = Array.isArray(body.todos) ? body.todos
          : (body.payload && Array.isArray(body.payload.todos) ? body.payload.todos : null);
        if (!list) return fail(res, 400, '缺少 todos 数组');

        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const raw of list.slice(0, 5000)) {
          try {
            if (!raw || typeof raw !== 'object') { skipped += 1; continue; }
            const previous = raw.id ? table.get(raw.id) : undefined;
            const todo = normalize(raw, previous);
            if (!todo.title) { skipped += 1; continue; }
            await table.put(todo.id, todo);
            if (previous) updated += 1; else added += 1;
          } catch (e) {
            skipped += 1;
          }
        }

        const evList = Array.isArray(body.events) ? body.events
          : (body.payload && Array.isArray(body.payload.events) ? body.payload.events : []);
        let eventsAdded = 0;
        for (const raw of evList.slice(0, 500)) {
          try {
            if (!raw || !raw.label || !raw.cal || !raw.month || !raw.day) continue;
            const id = raw.id || ('e_' + Math.random().toString(36).slice(2, 10));
            await events.put(id, {
              id,
              label: String(raw.label),
              cal: raw.cal === 'lunar' ? 'lunar' : 'solar',
              month: Number(raw.month),
              day: Number(raw.day),
              leap: raw.cal === 'lunar' ? Boolean(raw.leap) : null,
            });
            eventsAdded += 1;
          } catch (e) { /* 跳过坏条目 */ }
        }

        send(res, 200, { ok: true, added, updated, skipped, eventsAdded });
      } catch (e) {
        fail(res, 400, '导入失败：' + (e && e.message));
      }
    },
  });

  /* 助手形象：名称 + 头像 */
  route({
    kind: 'exact',
    path: '/api/todo/persona',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const dir = new URL('./assets/avatars/', import.meta.url);
      let names = [];
      try {
        names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png'));
      } catch (e) {
        names = [];
      }
      send(res, 200, {
        ok: true,
        persona: currentPersona(),
        presets: names.sort().map((n) => ({
          id: 'preset:' + n.replace(/\.png$/i, ''),
          url: '/api/todo/avatar?name=' + encodeURIComponent(n),
        })),
      });
    },
  });

  route({
    kind: 'exact',
    path: '/api/todo/persona-save',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req, 4 * 1024 * 1024);
        const name = String((body && body.name) || '').trim().slice(0, 20) || DEFAULT_NAME;
        const avatar = body && body.avatar ? String(body.avatar) : null;
        if (avatar && avatar.length > 3 * 1024 * 1024) return fail(res, 400, '头像过大');
        await personas.put('default', { name, avatar });
        send(res, 200, { ok: true, persona: currentPersona() });
      } catch (e) {
        fail(res, 400, '保存失败：' + (e && e.message));
      }
    },
  });

  /* 预设头像静态资源（白名单文件名，防路径穿越）*/
  route({
    kind: 'exact',
    path: '/api/todo/avatar',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const name = String(url.searchParams.get('name') || '');
      if (!/^[a-z0-9_-]+\.png$/i.test(name)) return fail(res, 400, 'bad avatar name');
      try {
        const buf = readFileSync(new URL('./assets/avatars/' + name, import.meta.url));
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': buf.length,
          'cache-control': 'public, max-age=86400',
        });
        res.end(buf);
      } catch (e) {
        fail(res, 404, 'avatar not found');
      }
    },
  });

  /* 列表 */
  route({
    kind: 'exact',
    path: '/api/todo/list',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      send(res, 200, { ok: true, todos: listAll() });
    },
  });

  /* 新建 / 更新 */
  route({
    kind: 'exact',
    path: '/api/todo/upsert',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req);
        const input = body.todo && typeof body.todo === 'object' ? body.todo : body;
        const previous = input.id ? table.get(input.id) : undefined;
        if (input.id && !previous) return fail(res, 404, 'todo not found: ' + input.id);

        const todo = normalize(input, previous);
        if (!todo.title) return fail(res, 400, 'title is required');

        await table.put(todo.id, todo);
        send(res, 200, { ok: true, todo });
      } catch (e) {
        fail(res, 400, 'upsert failed: ' + (e && e.message));
      }
    },
  });

  /* 勾选 / 取消 */
  route({
    kind: 'exact',
    path: '/api/todo/toggle',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const { id } = await readJson(req);
        const current = id ? table.get(id) : undefined;
        if (!current) return fail(res, 404, 'todo not found');
        const next = { ...current, done: !current.done, updatedAt: now() };
        await table.put(next.id, next);
        send(res, 200, { ok: true, todo: next });
      } catch (e) {
        fail(res, 400, 'toggle failed: ' + (e && e.message));
      }
    },
  });

  /* 删除 */
  route({
    kind: 'exact',
    path: '/api/todo/remove',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const { id } = await readJson(req);
        if (!id) return fail(res, 400, 'id is required');
        const existed = await table.delete(id);
        send(res, 200, { ok: true, removed: existed });
      } catch (e) {
        fail(res, 400, 'remove failed: ' + (e && e.message));
      }
    },
  });

}