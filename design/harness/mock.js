/**
 * 预览用 mock：拦截 fetch，返回真实形状的数据。
 * 数据与 DSH 里那几条保持一致，方便对比。
 */
(function () {
  const now = Date.now();
  let seq = 0;
  const mk = (o) => ({
    id: 'seed-' + (++seq),
    title: '',
    dueDate: null,
    dueTime: null,
    tag: 'work',
    important: false,
    urgent: false,
    done: false,
    notes: null,
    rawText: null,
    source: 'manual',
    createdAt: now + seq,
    updatedAt: now + seq,
    ...o,
  });

  const state = {
    todos: [
      mk({ title: '交上周的报销单', dueDate: '2026-11-20', tag: 'money', important: true, urgent: true, source: 'screenshot' }),
      mk({ title: '产品评审会 · 准备演示稿', dueDate: '2026-11-22', dueTime: '10:00', tag: 'work', important: true, urgent: true }),
      mk({ title: '给妈妈打个电话', dueDate: '2026-11-22', dueTime: '12:30', tag: 'life', important: true, urgent: false }),
      mk({ title: '回邮件 · 客户端 SDK 问题', dueDate: '2026-11-22', dueTime: '09:20', tag: 'work', done: true, urgent: true, important: false }),
      mk({ title: '体检预约', dueDate: '2026-11-26', dueTime: '09:00', tag: 'health', important: true, urgent: false }),
      mk({ title: '研究一下 DSH 插件文档', tag: 'study', important: false, urgent: false }),
      mk({ title: '准备周会材料', dueDate: '2026-11-22', dueTime: '08:30', tag: 'work', important: true, urgent: true, done: true }),
    ],
  };

  const reply = (data) => Promise.resolve(new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  window.fetch = function (url, opts) {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : {};

    if (u.includes('/api/todo/month')) {
      const q = u.split('?')[1] || '';
      const p = new URLSearchParams(q);
      const y = Number(p.get('y')) || 2026;
      const m = Number(p.get('m')) || 11;
      const startDow = new Date(y, m - 1, 1).getDay();
      const start = new Date(y, m - 1, 1 - startDow);
      const LABELS = {
        '2026-11-07': ['立冬', 'term'],
        '2026-11-09': ['十月', ''],
        '2026-11-22': ['小雪', 'term'],
        '2026-11-25': ['十七', ''],
        '2027-02-05': ['除夕', 'fest'],
        '2027-02-06': ['春节', 'fest'],
      };
      const cells = [];
      for (let i = 0; i < 42; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const hit = LABELS[key];
        cells.push({
          key,
          day: d.getDate(),
          outside: d.getMonth() !== m - 1,
          label: hit ? hit[0] : '',
          kind: hit ? hit[1] : '',
        });
      }
      return reply({ ok: true, y, m, cells, range: { from: 1900, to: 2100 } });
    }

    if (u.includes('/api/todo/conversation')) {
      return reply({
        ok: true,
        messages: [
          { role: 'user', text: '明天下午三点跟王工对接口' },
          { role: 'assistant', text: '记下了：明天 15:00 跟王工对接口。需要我提前 20 分钟提醒吗？' },
          {
            role: 'user',
            text: '（截图）',
            images: [{ url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3PMQEAAAgDoC251a3gLwSgOXLVkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkqRPCx4AAW0WefkAAAAASUVORK5CYII=' }],
          },
          {
            role: 'assistant',
            text: '好。报价单放到周五，今天先不碰它。这周你已经有 4 件事，注意别挤在一起。',
            drafts: [
              { title: '去牙科', dueDate: '2026-11-28', tag: 'health', important: true, urgent: false },
              { title: '写完年报初稿', dueDate: null, tag: 'work', important: true, urgent: false },
            ],
            ask: ['这周内写完', '下周三之前', '就先挂着，不设日期'],
          },
        ],
        total: 4,
      });
    }

    if (u.includes('/api/todo/reasoning')) {
      return reply({
        ok: true,
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        current: 'max',
      });
    }

    if (u.includes('/api/todo/models')) {
      return reply({
        ok: true,
        providers: [
          {
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', image: true },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', image: false },
            ],
          },
          {
            id: 'opencode-go-live',
            name: 'OpenCode Go',
            models: [
              { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', image: true },
              { id: 'glm-5.3', name: 'GLM-5.3', image: false },
              { id: 'grok-4.7', name: 'Grok 4.7', image: true },
              { id: 'qwen4-max', name: 'Qwen4 Max', image: true },
              { id: 'kimi-k3', name: 'Kimi K3', image: true },
            ],
          },
        ],
        current: { provider: 'opencode-go-live', model: 'deepseek-v4.1-flash', reasoningEffort: 'max', source: 'default' },
      });
    }

    if (u.includes('/api/todo/model')) {
      return reply({ ok: true, current: { provider: 'opencode-go-live', model: 'deepseek-v4.1-flash', source: 'saved' } });
    }

    if (u.includes('/api/todo/list')) return reply({ ok: true, todos: state.todos });

    if (u.includes('/api/todo/toggle')) {
      state.todos = state.todos.map((t) => (t.id === body.id ? { ...t, done: !t.done } : t));
      return reply({ ok: true });
    }

    if (u.includes('/api/todo/remove')) {
      state.todos = state.todos.filter((t) => t.id !== body.id);
      return reply({ ok: true, removed: true });
    }

    if (u.includes('/api/todo/upsert')) {
      const incoming = body.todo || body;
      const existing = state.todos.find((t) => t.id === incoming.id);
      if (existing) {
        Object.assign(existing, incoming, { updatedAt: Date.now() });
        return reply({ ok: true, todo: existing });
      }
      const created = mk({ ...incoming, id: 'new-' + Date.now() });
      state.todos.push(created);
      return reply({ ok: true, todo: created });
    }

    if (u.includes('/api/todo/chat')) {
      const tasks = [
        { title: '跟王工对接口', dueDate: '2026-11-23', dueTime: '15:00', tag: 'work', important: true, urgent: true, notes: '明天下午三点' },
        { title: '发出报价单', dueDate: '2026-11-27', dueTime: null, tag: 'work', important: true, urgent: false, notes: '周五前' },
        { title: '去趟银行', dueDate: null, dueTime: null, tag: 'money', important: false, urgent: false, notes: '有空去' },
      ];
      const prose = '**四件挤一天**，累是正常的，不是你*效率低*。\n\n'
        + '建议顺序：\n'
        + '1. 先把报价单的主体拉出来（约 40 分钟）\n'
        + '2. 细节明天早上补，`npm run build` 那步可以放到明早\n'
        + '3. 晚上留点空，别拖到凌晨\n\n'
        + '> 明天 15:00 跟王工对接口，提前 15 分钟过一遍接口相关的东西。\n\n'
        + '---\n\n'
        + '要我把「准备接口材料」也加一条吗？';
      const block = '<todo>' + JSON.stringify({ tasks, missing: ['去趟银行'] }) + '</todo>'
        + '<ask>' + JSON.stringify({ options: ['挪到周三', '今天打完', '先跳过'] }) + '</ask>';
      const enc = new TextEncoder();
      let phase = 0;
      let i = 0;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('event: start\ndata: ' + JSON.stringify({
            provider: 'opencode-go-live',
            model: 'deepseek-v4.1-flash',
            context: { used: 18300, total: 1000000 },
          }) + '\n\n'));
          const timer = setInterval(() => {
            if (phase === 0) {
              if (i < block.length) {
                c.enqueue(enc.encode('event: delta\ndata: ' + JSON.stringify({ text: block.slice(i, i + 10) }) + '\n\n'));
                i += 10;
              } else {
                phase = 1;
                i = 0;
                c.enqueue(enc.encode('event: draft\ndata: ' + JSON.stringify({ tasks, missing: ['去趟银行'] }) + '\n\n'));
                c.enqueue(enc.encode('event: ask\ndata: ' + JSON.stringify({ options: ['挪到周三', '今天打完', '先跳过'] }) + '\n\n'));
              }
            } else if (i < prose.length) {
              c.enqueue(enc.encode('event: delta\ndata: ' + JSON.stringify({ text: prose.slice(i, i + 8) }) + '\n\n'));
              i += 8;
            } else {
              clearInterval(timer);
              c.enqueue(enc.encode('event: finish\ndata: {"reason":"stop"}\n\n'));
              c.close();
            }
          }, 30);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }

    if (u.includes('/api/todo/extract')) {
      const tasks = [
        { title: '跟王工对接口', dueDate: '2026-11-23', dueTime: '15:00', tag: 'work', important: true, urgent: true, notes: '明天下午三点' },
        { title: '发出报价单', dueDate: '2026-11-27', dueTime: null, tag: 'work', important: true, urgent: false, notes: '周五前' },
        { title: '去趟银行', dueDate: null, dueTime: null, tag: 'money', important: false, urgent: false, notes: '有空去' },
      ];
      const full = JSON.stringify({ tasks, missing: ['去趟银行'] });
      const enc = new TextEncoder();
      let i = 0;
      const stream = new ReadableStream({
        start(c) {
          const timer = setInterval(() => {
            if (i < full.length) {
              c.enqueue(enc.encode('event: delta\ndata: ' + JSON.stringify({ text: full.slice(i, i + 10) }) + '\n\n'));
              i += 10;
            } else {
              clearInterval(timer);
              c.enqueue(enc.encode('event: done\ndata: ' + JSON.stringify({ ok: true, tasks, missing: ['去趟银行'] }) + '\n\n'));
              c.close();
            }
          }, 40);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }

    if (u.includes('/api/todo/log')) return reply({ ok: true });

    return reply({ ok: false, error: 'mock: unknown route ' + u });
  };
})();
