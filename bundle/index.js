/**
 * Host 半：待办插件。
 *
 * P1：真实数据层 —— 存储域 + 增删改查路由。
 * 通道契约见 @deepseek-ai/dsh-host-webserver/src/index.ts：
 *   WebRoute = { kind, path, handler(req: IncomingMessage, res: ServerResponse) }
 */

import { appendFileSync } from 'node:fs';

import { todoSpec, normalize, compare, now } from './lib/domain.js';
import { send, fail, readJson, guard, openSse } from './lib/channel.js';
import { buildMonth, TABLE_RANGE } from './lib/calendar.js';
import { buildSystemPrompt, splitTasks, visibleText } from './lib/chat.js';

export const inject = ['webServer', 'storageDomain'];
export const name = 'todo';

const LOG_FILE = new URL('./probe.log', import.meta.url);

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
    '3. 有时限且影响大的 important=true；临近截止的 urgent=true。',
    '4. tag 只能从 work/life/study/health/money 里选。',
    '5. 一条待办一个 title，不要把多个事项塞进一条。',
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
  const MODEL_KEY = 'chat-model';
  const CONV_KEY = 'default';
  const HISTORY_LIMIT = 12;
  const SUMMARY_TRIGGER = 30;

  /** 当前生效的模型：用户选过就用选的，否则跟 DSH 默认 */
  function currentModel() {
    const saved = settings.get(MODEL_KEY);
    if (saved && saved.provider && saved.model) {
      return { provider: saved.provider, model: saved.model, source: 'saved' };
    }
    const adm = ctx.get('agentDefaultModel');
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
    if (sel && sel.provider && sel.model) {
      return { provider: sel.provider, model: sel.model, source: 'default' };
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

  /* 自检上报：client 把布局数值写回 probe.log，便于外部核对 */
  route({
    kind: 'exact',
    path: '/api/todo/log',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      let body = '';
      try {
        for await (const chunk of req) body += chunk;
      } catch (e) {
        body = 'READ_ERR ' + e.message;
      }
      try {
        appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + body.slice(0, 8000) + '\n');
      } catch (e) {
        return fail(res, 500, 'log write failed: ' + e.message);
      }
      send(res, 200, { ok: true });
    },
  });

  /* 模型能力诊断：默认模型是什么、支不支持图片、llm 服务可否直用 */
  route({
    kind: 'exact',
    path: '/api/todo/model-diag',
    handler: async (req, res) => {
      if (!guard(req, res)) return;
      const out = { ok: true };
      try {
        const adm = ctx.get('agentDefaultModel');
        out.selection = adm && typeof adm.currentSelection === 'function'
          ? adm.currentSelection()
          : (adm ? 'service-without-currentSelection' : null);

        const llm = ctx.get('llm');
        if (!llm) {
          out.llm = null;
          return send(res, 200, out);
        }
        out.llm = {
          listProviders: typeof llm.listProviders,
          resolveModelInfo: typeof llm.resolveModelInfo,
          stream: typeof llm.stream,
        };
        try {
          out.providers = await llm.listProviders();
        } catch (e) {
          out.providersError = String(e && e.message);
        }

        const sel = out.selection;
        if (sel && sel.provider && sel.model) {
          try {
            const info = await llm.resolveModelInfo(sel.provider, sel.model);
            out.resolved = {
              provider: sel.provider,
              model: info.id,
              name: info.name,
              inputModalities: info.inputModalities || null,
              contextWindow: info.context ? info.context.contextWindow : null,
              hasReasoning: Boolean(info.reasoning),
            };
          } catch (e) {
            out.resolveError = String((e && e.message) || e);
          }
        }
        send(res, 200, out);
      } catch (e) {
        fail(res, 500, String((e && e.message) || e));
      }
    },
  });

  /* AI 抽取：文本/截图 → 待办草案，SSE 流式 */
  route({
    kind: 'exact',
    path: '/api/todo/extract',
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
      if (!llm || !attachments) {
        return fail(res, 503, 'llm / attachments unavailable');
      }

      const sse = openSse(res);
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      try {
        const selection = currentModel();
        if (!selection) {
          sse.event('error', { message: '没有可用模型：DSH 未选默认模型，插件也没保存选择' });
          return;
        }

        /* 组装内容块：图片先落到 attachments 拿到 durable ref */
        const content = [];
        const note = typeof body.text === 'string' ? body.text.trim() : '';
        if (note) content.push({ type: 'text', text: note });

        const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
        for (const img of images) {
          const mediaType = img && img.mediaType ? img.mediaType : 'image/png';
          const raw = Buffer.from(String((img && img.data) || ''), 'base64');
          if (!raw.length) continue;
          const ref = await attachments.saveImage({
            data: new Uint8Array(raw),
            mediaType,
            name: 'todo-shot',
          });
          content.push({ type: 'image', attachment: ref });
        }

        if (!content.length) {
          sse.event('error', { message: 'empty input: need text or image' });
          return;
        }

        sse.event('start', { provider: selection.provider, model: selection.model });

        let text = '';
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          system: extractionPrompt(new Date()),
          messages: [{ role: 'user', content }],
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') {
            text += chunk.text;
            sse.event('delta', { text: chunk.text });
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'stop';
            sse.event('finish', { reason: kind });
            if (kind === 'error' && chunk.reason.failure) {
              sse.event('error', { message: chunk.reason.failure.message || 'model error' });
            }
          }
        }

        const parsed = parseExtraction(text);
        sse.event('done', parsed);
      } catch (e) {
        try { sse.event('error', { message: String((e && e.message) || e) }); } catch (x) { /* ignore */ }
      } finally {
        sse.close();
      }
    },
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

  /* 选择模型；传空对象表示恢复跟随 DSH 默认 */
  route({
    kind: 'exact',
    path: '/api/todo/model',
    handler: async (req, res) => {
      if (!guard(req, res, { mutating: true })) return;
      try {
        const body = await readJson(req);
        if (body && body.provider && body.model) {
          await settings.put(MODEL_KEY, { provider: String(body.provider), model: String(body.model) });
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
        send(res, 200, { ok: true, y, m, cells: buildMonth(y, m), range: TABLE_RANGE });
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
        });

        sse.event('start', { provider: selection.provider, model: selection.model });

        let acc = '';
        let sent = 0;
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          system,
          messages: [{ role: 'user', content }],
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') {
            acc += chunk.text;
            const visible = visibleText(acc);
            if (visible.length > sent) {
              sse.event('delta', { text: visible.slice(sent) });
              sent = visible.length;
            }
          } else if (chunk.type === 'finish') {
            sse.event('finish', {
              reason: chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'stop',
            });
          }
        }

        const { prose, tasks } = splitTasks(acc);
        if (tasks) sse.event('draft', tasks);

        const messages = [
          ...(conv.messages || []),
          { role: 'user', text: text || '（截图）' },
          { role: 'assistant', text: prose },
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

  /* SSE 通道自检（P2 的抽取流会复用同一套写法） */
  route({
    kind: 'exact',
    path: '/api/todo/stream',
    handler: (req, res) => {
      if (!guard(req, res)) return;
      const sse = openSse(res);
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        sse.event('tick', { tick, at: Date.now() });
        if (tick >= 8) { clearInterval(timer); sse.close(); }
      }, 200);
      req.on('close', () => clearInterval(timer));
    },
  });
}
