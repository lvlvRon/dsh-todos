import stylesText from './styles.css';
/**
 * Client 半：待办面板（P2 —— 列表视图接真数据）。
 *
 * 硬约束（已实测）：
 *   - client 只能是单文件：工厂里 require 不到同目录的文件
 *   - 拿不到 `host` builtin，一律走 fetch('/api/todo/*')
 *   - 变更类请求必须带 x-dsh-todo 头（host 侧校验）
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-todo',
  factory(hostRequire) {
    const React = hostRequire('react');
    const h = React.createElement;

    /* ============================================================
       样式（一次注入，随插件卸载移除）
       ============================================================ */
    const CSS = stylesText;

    function installStyles() {
      const el = document.createElement('style');
      el.setAttribute('data-todo-plugin', '');
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => { try { el.remove(); } catch (e) { /* ignore */ } };
    }

    /* ============================================================
       工具
       ============================================================ */
    const TAG_META = {
      work: { name: '工作', color: '#3b6fd4' },
      life: { name: '生活', color: '#2b9a56' },
      study: { name: '学习', color: '#7c5cff' },
      health: { name: '健康', color: '#0e9384' },
      money: { name: '财务', color: '#c2760c' },
    };

    const pad2 = (n) => String(n).padStart(2, '0');
    const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

    async function api(method, path, body) {
      const headers = { 'x-dsh-todo': '1' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch('/api/todo/' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* ignore */ }
      if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    /** 相对日期分组 */
    function groupOf(t, todayStr, weekEnd) {
      if (!t.dueDate) return 'undated';
      if (t.dueDate < todayStr) return 'overdue';
      if (t.dueDate === todayStr) return 'today';
      if (t.dueDate <= weekEnd) return 'week';
      return 'later';
    }

    function weekEndOf(todayStr) {
      const d = new Date(todayStr + 'T00:00:00');
      const dow = d.getDay();                 // 0=周日
      const add = dow === 0 ? 0 : 7 - dow;
      d.setDate(d.getDate() + add);
      return ymd(d);
    }

    function monthEndOf(todayStr) {
      const [y, m] = todayStr.split('-').map(Number);
      return ymd(new Date(y, m, 0));
    }

    /** 把剪贴板图片压到 ≤1600px 的 JPEG，返回 { mediaType, data(base64), preview } */
    async function compressImage(file, maxDim = 1600, quality = 0.82) {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      return { mediaType: 'image/jpeg', data: dataUrl.split(',')[1] || '', preview: dataUrl, width: w, height: h };
    }

    /** 逐帧解析 SSE */
    async function readSse(response, onEvent) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) { onEvent(event, null); continue; }
          try { onEvent(event, JSON.parse(data)); } catch (e) { /* 半截 JSON 忽略 */ }
        }
      }
    }

    const PERIODS = [
      { id: 'today', label: '今天', kinds: ['overdue', 'today'] },
      { id: 'week', label: '本周', kinds: ['overdue', 'today', 'week'] },
      { id: 'month', label: '本月', kinds: ['overdue', 'today', 'week', 'later'] },
      { id: 'all', label: '全部', kinds: null },
      { id: 'done', label: '已完成', doneOnly: true },
    ];

    const GROUP_LABELS = [
      { key: 'overdue', label: '逾期', alert: true },
      { key: 'today', label: '今天' },
      { key: 'week', label: '本周' },
      { key: 'later', label: '以后' },
      { key: 'undated', label: '未排期' },
    ];

    /** 草案项补齐默认值 */
    function normalizeDraft(t) {
      return {
        title: String((t && t.title) || '').trim() || '未命名',
        dueDate: (t && t.dueDate) || '',
        dueTime: (t && t.dueTime) || '',
        tag: t && TAG_META[t.tag] ? t.tag : 'work',
        important: Boolean(t && t.important),
        urgent: Boolean(t && t.urgent),
        notes: (t && t.notes) || '',
        _created: false,
      };
    }

    /** 草案卡：流式时只读预览，拿到完整结果后可编辑 */
    function DraftCard({ tasks, ready, onCreate, knownTitles }) {
      const [items, setItems] = React.useState(() => {
        const known = new Set(knownTitles || []);
        return (tasks || []).map((t) => {
          const it = normalizeDraft(t);
          return { ...it, _created: known.has(it.title) };
        });
      });
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (!ready) setItems((tasks || []).map(normalizeDraft));
      }, [tasks, ready]);

      /* 库里已经有同标题的条目 → 视为已创建（刷新后不再重复提交） */
      React.useEffect(() => {
        if (!ready) return;
        const known = new Set(knownTitles || []);
        setItems((prev) => {
          let changed = false;
          const next = prev.map((it) => {
            if (!it._created && known.has(it.title)) { changed = true; return { ...it, _created: true }; }
            return it;
          });
          return changed ? next : prev;
        });
      }, [knownTitles, ready]);

      const createdCount = items.filter((it) => it._created).length;
      const missingCount = items.filter((it) => !it.dueDate).length;
      /* 只提交字段齐全且尚未创建的 */
      const pending = items.filter((it) => !it._created && it.dueDate);
      const patch = (i, key, value) => setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: value } : it)));

      const submit = async () => {
        if (busy || !pending.length) return;
        setBusy(true);
        try {
          const done = await onCreate(pending);
          const marked = new Set(done && done.length ? done : pending.map((it) => it.title));
          setItems((prev) => prev.map((it) => (marked.has(it.title) ? { ...it, _created: true } : it)));
        } finally {
          setBusy(false);
        }
      };

      const note = missingCount > 0
        ? '还有 ' + missingCount + ' 项缺日期'
        : (createdCount ? '已创建 ' + createdCount + ' 条' : '都齐了');

      return h('div', { className: 'todo-draft' },
        h('div', { className: 'todo-draft-head' },
          '识别到 ', h('b', null, String(items.length)), ' 条',
          createdCount ? ' · 已创建 ' + createdCount : '',
          ready ? '' : ' · 解析中…'),
        ...items.map((it, i) => h('div', {
          key: i,
          className: 'todo-draft-item',
          'data-done': it._created ? '1' : '0',
        },
          h('div', { className: 'todo-draft-itemhead' },
            ready && !it._created
              ? h('input', {
                  className: 'todo-draft-title', value: it.title,
                  onChange: (e) => patch(i, 'title', e.target.value),
                })
              : h('div', { className: 'todo-draft-title' }, it.title),
            it._created ? h('span', { className: 'todo-done-badge' }, '已创建') : null),
          h('div', { className: 'todo-draft-fields' },
            ready && !it._created
              ? h('input', {
                  className: 'todo-field', type: 'date', 'data-miss': it.dueDate ? '0' : '1',
                  value: it.dueDate, onChange: (e) => patch(i, 'dueDate', e.target.value),
                })
              : h('span', {
                  className: 'todo-field',
                  'data-miss': !it._created && !it.dueDate ? '1' : '0',
                }, it.dueDate || '缺日期'),
            h('input', {
              className: 'todo-field', type: 'time', value: it.dueTime,
              style: { maxWidth: '78px' }, disabled: !ready || it._created,
              onChange: (e) => patch(i, 'dueTime', e.target.value),
            }),
            h('select', {
              className: 'todo-field', value: it.tag, disabled: !ready || it._created,
              onChange: (e) => patch(i, 'tag', e.target.value),
            }, ...Object.entries(TAG_META).map(([k, v]) => h('option', { key: k, value: k }, v.name))),
            h('div', { className: 'todo-draft-flags' },
              h('button', {
                className: 'todo-toggle', 'data-on': it.important ? '1' : '0',
                disabled: !ready || it._created, onClick: () => patch(i, 'important', !it.important),
              }, '重要'),
              h('button', {
                className: 'todo-toggle', 'data-on': it.urgent ? '1' : '0',
                disabled: !ready || it._created, onClick: () => patch(i, 'urgent', !it.urgent),
              }, '紧急')),
          ),
        )),
        ready
          ? h('div', { className: 'todo-draft-foot' },
              h('span', {
                className: 'todo-draft-note',
                'data-warn': pending.length && missingCount ? '1' : '0',
                'data-ok': !pending.length && createdCount ? '1' : '0',
              }, note),
              h('button', {
                className: 'todo-btn-primary',
                disabled: busy || !pending.length,
                onClick: submit,
              }, busy
                ? '创建中…'
                : (pending.length
                    ? '创建 ' + pending.length + ' 条'
                    : (createdCount ? '已创建 ✓' : '全部创建'))),
            )
          : null,
      );
    }

    /* ============================================================
       轻量 Markdown：解析成 React 元素，不用 innerHTML
       ============================================================ */
    const MD_INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\))/g;

    function mdInline(text, keyBase) {
      const out = [];
      let last = 0;
      let m;
      MD_INLINE.lastIndex = 0;
      while ((m = MD_INLINE.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const k = keyBase + '-' + m.index;
        if (m[2] !== undefined) out.push(h('strong', { key: k }, m[2]));
        else if (m[3] !== undefined) out.push(h('strong', { key: k }, m[3]));
        else if (m[4] !== undefined) out.push(h('del', { key: k }, m[4]));
        else if (m[5] !== undefined) out.push(h('code', { key: k, className: 'todo-md-code' }, m[5]));
        else if (m[6] !== undefined) out.push(h('em', { key: k }, m[6]));
        else if (m[7] !== undefined) out.push(h('em', { key: k }, m[7]));
        else if (m[8] !== undefined) {
          out.push(h('a', {
            key: k, href: m[9], target: '_blank', rel: 'noreferrer noopener',
          }, m[8]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }

    function mdParagraph(text, keyBase) {
      const lines = text.split('\n');
      const nodes = [];
      lines.forEach((line, i) => {
        if (i) nodes.push(h('br', { key: 'br' + i }));
        nodes.push(...mdInline(line, keyBase + 'p' + i));
      });
      return nodes;
    }

    function mdBlocks(src) {
      const lines = String(src || '').split('\n');
      const blocks = [];
      let list = null;
      let i = 0;
      const flush = () => { if (list) { blocks.push(list); list = null; } };

      while (i < lines.length) {
        const raw = lines[i];
        const t = raw.trim();

        if (/^```/.test(t)) {
          flush();
          const body = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i += 1; }
          i += 1;
          blocks.push({ type: 'code', text: body.join('\n') });
          continue;
        }
        if (!t) { flush(); i += 1; continue; }

        let m;
        if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) {
          flush();
          blocks.push({ type: 'h', level: m[1].length, text: m[2] });
          i += 1;
          continue;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); blocks.push({ type: 'hr' }); i += 1; continue; }
        if ((m = /^>\s?(.*)$/.exec(t))) {
          flush();
          blocks.push({ type: 'quote', text: m[1] });
          i += 1;
          continue;
        }
        if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
          if (!list || list.ordered) { flush(); list = { type: 'list', ordered: false, items: [] }; }
          list.items.push(m[1]);
          i += 1;
          continue;
        }
        if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) {
          if (!list || !list.ordered) { flush(); list = { type: 'list', ordered: true, items: [] }; }
          list.items.push(m[1]);
          i += 1;
          continue;
        }

        const para = [t];
        i += 1;
        while (i < lines.length) {
          const nt = lines[i].trim();
          if (!nt) break;
          if (/^(#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|```|-{3,}$)/.test(nt)) break;
          para.push(nt);
          i += 1;
        }
        flush();
        blocks.push({ type: 'p', text: para.join('\n') });
      }
      flush();
      return blocks;
    }

    function Markdown({ text }) {
      const blocks = mdBlocks(text);
      return h('div', { className: 'todo-md' },
        ...blocks.map((b, idx) => {
          const key = 'b' + idx;
          if (b.type === 'code') {
            return h('pre', { key, className: 'todo-md-pre' }, h('code', null, b.text));
          }
          if (b.type === 'hr') return h('hr', { key, className: 'todo-md-hr' });
          if (b.type === 'h') {
            return h('div', { key, className: 'todo-md-h todo-md-h' + b.level }, ...mdInline(b.text, key));
          }
          if (b.type === 'quote') {
            return h('blockquote', { key, className: 'todo-md-quote' }, ...mdInline(b.text, key));
          }
          if (b.type === 'list') {
            const items = b.items.map((it, k) => h('li', { key: 'i' + k }, ...mdInline(it, key + 'i' + k)));
            return b.ordered
              ? h('ol', { key, className: 'todo-md-list' }, ...items)
              : h('ul', { key, className: 'todo-md-list' }, ...items);
          }
          return h('p', { key }, ...mdParagraph(b.text, key));
        }));
    }

    /** 兜底：即使服务端没过滤，也不把 <todo> 块显示给用户 */
    function cleanText(text) {
      return String(text || '')
        .replace(/<todo>[\s\S]*?<\/todo>/g, '')
        .replace(/<ask>[\s\S]*?<\/ask>/g, '')
        .replace(/<\/?(?:todo|ask)>/g, '')
        .replace(/^\s*<\s*(?!todo>)/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function renderMessage(m, key, onCreate, onPreview, onChoose, knownTitles) {
      if (m.role === 'user') {
        const hasImgs = Boolean(m.images && m.images.length);
        /* 只有图时不要再显示「（截图）」占位文字 */
        const bubbleText = hasImgs && m.text === '（截图）' ? '' : m.text;
        return h('div', { key, className: 'todo-msg' },
          h('div', { className: 'todo-bubble' },
            hasImgs
              ? h('div', { className: 'todo-msg-imgs' },
                  ...m.images.map((src, k) => h('img', {
                    key: k,
                    src,
                    alt: '发送的截图',
                    title: '查看原图',
                    onClick: () => onPreview && onPreview(src),
                  })))
              : null,
            bubbleText));
      }
      const shown = cleanText(m.text);
      return h('div', { key, className: 'todo-ai' },
        h('div', { className: 'todo-ai-avatar' }, '步'),
        h('div', { className: 'todo-ai-body' },
          shown ? h(Markdown, { text: shown }) : null,
          m.drafts && m.drafts.length
            ? h(DraftCard, { tasks: m.drafts, ready: Boolean(m.ready), onCreate, knownTitles })
            : null,
          m.ask && m.ask.length
            ? h('div', { className: 'todo-ask' },
                ...m.ask.map((opt, k) => h('button', {
                  key: k,
                  className: 'todo-ask-btn',
                  'data-on': m.chosen === opt ? '1' : '0',
                  disabled: Boolean(m.chosen),
                  onClick: () => onChoose && onChoose(m.id, opt),
                }, opt)))
            : null,
          m.error ? h('div', { className: 'todo-msg-err' }, m.error) : null));
    }

    /* ============================================================
       日历视图
       ============================================================ */
    const DOW = ['日', '一', '二', '三', '四', '五', '六'];

    function CalendarView(props) {
      const { y, m, cells, todos, todayKey, loading, range, pickerOpen } = props;
      const byDate = {};
      for (const t of todos || []) {
        if (!t.dueDate) continue;
        (byDate[t.dueDate] = byDate[t.dueDate] || []).push(t);
      }
      const from = range ? range.from : 1900;
      const to = range ? range.to : 2100;
      const yearOptions = [];
      for (let yy = from; yy <= to; yy += 1) {
        yearOptions.push(h('option', { key: yy, value: String(yy) }, yy + ' 年'));
      }

      return h('div', { className: 'todo-cal', onWheel: props.onWheel },
        h('div', { className: 'todo-cal-nav' },
          h('button', { className: 'todo-icon-btn', onClick: props.onPrev, title: '上个月', style: { fontSize: '16px' } }, '‹'),
          h('button', { className: 'todo-cal-month', onClick: props.onTogglePicker }, y + ' 年 ' + m + ' 月'),
          h('button', { className: 'todo-icon-btn', onClick: props.onNext, title: '下个月', style: { fontSize: '16px' } }, '›'),
          h('button', { className: 'todo-cal-today', onClick: props.onToday }, '本月'),
          pickerOpen
            ? h('div', { className: 'todo-cal-picker' },
                h('select', {
                  value: String(y),
                  onChange: (e) => props.onPickYear(Number(e.target.value)),
                }, ...yearOptions),
                h('div', { className: 'todo-cal-months' },
                  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((mm) => h('button', {
                    key: mm, 'data-on': mm === m ? '1' : '0',
                    onClick: () => props.onPickMonth(mm),
                  }, mm + ' 月'))),
              )
            : null,
        ),
        h('div', { className: 'todo-cal-dow' },
          ...DOW.map((d, i) => h('span', {
            key: d, className: i === 0 || i === 6 ? 'is-weekend' : '',
          }, d))),
        loading || !cells
          ? h('div', { className: 'todo-empty' }, '加载中…')
          : h('div', { className: 'todo-cal-grid' },
              ...cells.map((c) => {
                const items = byDate[c.key] || [];
                return h('div', {
                  key: c.key,
                  className: 'todo-cal-cell'
                    + (c.outside ? ' is-out' : '')
                    + (c.key === todayKey ? ' is-today' : ''),
                },
                  h('div', { className: 'todo-cal-top' },
                    h('span', { className: 'todo-cal-d' }, String(c.day)),
                    h('span', {
                      className: 'todo-cal-label'
                        + (c.kind === 'fest' ? ' is-fest' : c.kind === 'term' ? ' is-term' : ''),
                    }, c.label)),
                  h('div', { className: 'todo-cal-pills' },
                    ...(c.events || []).map((label, k) => h('div', {
                      key: 'e' + k, className: 'todo-cal-pill is-event', title: label,
                    }, label)),
                    ...items.slice(0, 3).map((t) => h('div', {
                      key: t.id,
                      className: 'todo-cal-pill' + (t.done ? ' is-done' : ''),
                      title: t.title,
                    }, t.title)),
                    items.length > 3 ? h('div', { className: 'todo-cal-more' }, '+' + (items.length - 3)) : null),
                );
              })),
      );
    }

    /* ============================================================
       上下文占用环
       ============================================================ */
    function CtxRing({ used, total }) {
      const pct = total > 0 ? Math.min(1, used / total) : 0;
      const r = 7;
      const c = 2 * Math.PI * r;
      const label = pct <= 0 ? '0%' : (pct < 0.01 ? '<1%' : Math.round(pct * 100) + '%');
      return h('span', {
        className: 'todo-ctx',
        title: '上下文占用 ' + (pct * 100).toFixed(1) + '%（约 ' + used + ' / ' + total + ' tokens）',
      },
        h('svg', { viewBox: '0 0 18 18', width: 16, height: 16 },
          h('circle', { cx: 9, cy: 9, r, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 2 }),
          h('circle', {
            cx: 9, cy: 9, r, fill: 'none', stroke: 'var(--td-accent)', strokeWidth: 2,
            strokeDasharray: String(c), strokeDashoffset: String(c * (1 - pct)),
            strokeLinecap: 'round', transform: 'rotate(-90 9 9)',
          })),
        h('span', null, label));
    }

    /* ============================================================
       右侧对话栏（P2 外壳；P3 接 SSE 抽取）
       ============================================================ */
    function ChatPane({
      messages, busy, draft, onDraft, onSend, models, modelName, chipLabel, effortName,
      menuOpen, onToggleMenu, onPick,
      attachments, onPasteImages, onRemoveAttachment, onCreateDrafts, ctxInfo, onPreview,
      efforts, onPickEffort, onClear, onChoose, knownTitles,
    }) {
      const threadRef = React.useRef(null);
      const wrapRef = React.useRef(null);
      const fileRef = React.useRef(null);
      const [menuView, setMenuView] = React.useState('root');

      /* 每次打开菜单都回到根视图 */
      React.useEffect(() => { if (menuOpen) setMenuView('root'); }, [menuOpen]);

      React.useEffect(() => {
        const el = threadRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [messages, busy]);

      React.useEffect(() => {
        if (!menuOpen) return;
        const onDoc = (e) => {
          if (wrapRef.current && wrapRef.current.contains(e.target)) return;
          onToggleMenu(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [menuOpen, onToggleMenu]);

      return h('aside', { className: 'todo-chat' },
        h('header', { className: 'todo-chat-head' },
          h('div', { className: 'todo-avatar' }, '步'),
          h('div', { className: 'todo-chat-id' },
            h('b', null, '小步'),
            h('span', { className: 'todo-chat-status' }, h('i'), '待办助手 · 常驻对话'),
          ),
          messages.length
            ? h('button', {
                className: 'todo-chat-clear', title: '清空对话（历史与摘要一起删除）',
                onClick: onClear,
              }, '清空')
            : null,
        ),
        h('div', { className: 'todo-thread', ref: threadRef },
          messages.length === 0 && !busy
            ? h('div', { className: 'todo-chat-empty' },
                '粘贴一张截图，或直接说「周三下午三点开评审会」',
                h('br'),
                '我会把它拆成待办')
            : null,
          ...messages.map((m, i) => renderMessage(m, i, onCreateDrafts, onPreview, onChoose, knownTitles)),
          busy ? h('div', { className: 'todo-typing' }, h('i'), h('i'), h('i')) : null,
        ),
        h('div', { className: 'todo-composer' },
          h('div', { className: 'todo-composer-inner' },
            attachments && attachments.length
              ? h('div', { className: 'todo-attach-rail' },
                  ...attachments.map((a, i) => h('div', { key: i, className: 'todo-attach' },
                    h('img', {
                      src: a.preview,
                      title: '查看原图',
                      alt: '待识别截图',
                      onClick: () => onPreview(a.preview),
                    }),
                    h('button', {
                      className: 'todo-attach-x',
                      onClick: (e) => { e.stopPropagation(); onRemoveAttachment(i); },
                      title: '移除',
                    }, '×'),
                  )))
              : null,
            h('textarea', {
              className: 'todo-textarea', rows: 2, value: draft,
              placeholder: '粘贴截图，或直接说，我来拆成待办',
              onChange: (e) => onDraft(e.target.value),
              onPaste: (e) => {
                const files = [...((e.clipboardData && e.clipboardData.files) || [])]
                  .filter((f) => f.type && f.type.startsWith('image/'));
                if (!files.length) return;
                e.preventDefault();
                onPasteImages(files);
              },
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
              },
            }),
            h('div', { className: 'todo-toolrow' },
              h('button', {
                className: 'todo-round-btn', title: '添加图片',
                onClick: () => { if (fileRef.current) fileRef.current.click(); },
              }, '+'),
              h('input', {
                ref: fileRef, type: 'file', accept: 'image/*', multiple: true,
                style: { display: 'none' },
                onChange: (e) => {
                  const files = [...((e.target && e.target.files) || [])];
                  if (files.length) onPasteImages(files);
                  e.target.value = '';
                },
              }),
              h('span', { className: 'todo-toolrow-spacer' }),
              h('div', { className: 'todo-model-wrap', ref: wrapRef },
                h('button', {
                  className: 'todo-model-btn', title: '选择模型',
                  onClick: () => onToggleMenu(!menuOpen),
                }, chipLabel),
                menuOpen && models
                  ? h('div', { className: 'todo-model-pop' },
                      menuView === 'root'
                        ? [
                            h('button', {
                              key: 'r-model', className: 'todo-menu-row',
                              onClick: () => setMenuView('models'),
                            },
                              h('span', null, '模型'),
                              h('span', { className: 'todo-menu-val' }, modelName, h('i', null, '›'))),
                            efforts && efforts.efforts && efforts.efforts.length
                              ? h('button', {
                                  key: 'r-eff', className: 'todo-menu-row',
                                  onClick: () => setMenuView('effort'),
                                },
                                  h('span', null, '推理等级'),
                                  h('span', { className: 'todo-menu-val' }, effortName || '默认', h('i', null, '›')))
                              : null,
                            h('div', { key: 'r-sep', className: 'todo-menu-sep' }),
                            h('button', {
                              key: 'r-default', className: 'todo-menu-row',
                              onClick: () => onPick(null, null),
                            },
                              h('span', null, '跟随 DSH 默认'),
                              h('span', { className: 'todo-menu-val' },
                                models.current && models.current.source === 'default' ? '当前' : '')),
                          ]
                        : menuView === 'models'
                          ? [
                              h('button', {
                                key: 'b1', className: 'todo-menu-row todo-menu-back',
                                onClick: () => setMenuView('root'),
                              }, '‹ 模型'),
                              ...models.providers.map((p) => [
                                h('div', { key: 'g-' + p.id, className: 'todo-model-group' }, p.name),
                                ...(p.models || []).map((m) => h('button', {
                                  key: p.id + '/' + m.id,
                                  className: 'todo-model-item',
                                  'data-on': models.current
                                    && models.current.provider === p.id
                                    && models.current.model === m.id ? '1' : '0',
                                  onClick: () => onPick(p.id, m.id),
                                }, m.name, m.image ? h('span', { className: 'todo-model-badge' }, '图片') : null)),
                              ]),
                            ]
                          : [
                              h('button', {
                                key: 'b2', className: 'todo-menu-row todo-menu-back',
                                onClick: () => setMenuView('root'),
                              }, '‹ 推理等级'),
                              ...((efforts && efforts.efforts) || []).map((e) => h('button', {
                                key: 'eff-' + e.id,
                                className: 'todo-model-item',
                                'data-on': models.current && models.current.reasoningEffort === e.id ? '1' : '0',
                                onClick: () => onPickEffort(e.id),
                              }, e.name)),
                            ],
                    )
                  : null,
              ),
              h('span', { className: 'todo-toolrow-spacer' }),
              ctxInfo ? h(CtxRing, { used: ctxInfo.used, total: ctxInfo.total }) : null,
              h('button', {
                className: 'todo-send', onClick: onSend,
                disabled: busy || (!draft.trim() && !(attachments && attachments.length)),
                title: '发送',
              }, h('svg', {
                viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
                stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round',
              }, h('path', { d: 'M12 19V6M6 12l6-6 6 6' }))),
            ),
          ),
        ),
      );
    }

    /* ============================================================
       行
       ============================================================ */
    /* 行内编辑：双击进入，Enter 保存，Esc 取消；点外部仅在没有改动时才退出 */
    function EditRow({ t, onSave, onCancel }) {
      const initial = React.useMemo(() => ({
        title: t.title || '',
        dueDate: t.dueDate || '',
        dueTime: t.dueTime || '',
        tag: TAG_META[t.tag] ? t.tag : 'work',
        important: Boolean(t.important),
        urgent: Boolean(t.urgent),
      }), [t]);

      const [d, setD] = React.useState(initial);
      const [busy, setBusy] = React.useState(false);
      const boxRef = React.useRef(null);
      const inputRef = React.useRef(null);

      const dirty = d.title !== initial.title
        || d.dueDate !== initial.dueDate
        || d.dueTime !== initial.dueTime
        || d.tag !== initial.tag
        || d.important !== initial.important
        || d.urgent !== initial.urgent;

      React.useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }, []);

      /* 点编辑区域以外：没有改动才退出；有改动必须点保存 */
      React.useEffect(() => {
        const onDocDown = (e) => {
          const el = boxRef.current;
          if (!el || el.contains(e.target)) return;
          if (dirty) return;
          onCancel();
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
      }, [dirty, onCancel]);

      const patch = (key, value) => setD((prev) => ({ ...prev, [key]: value }));

      const save = async () => {
        const title = d.title.trim();
        if (!title || busy) return;
        setBusy(true);
        try {
          await onSave({
            ...t,
            title,
            dueDate: d.dueDate || null,
            dueTime: d.dueTime || null,
            tag: d.tag,
            important: d.important,
            urgent: d.urgent,
          });
        } finally {
          setBusy(false);
        }
      };

      return h('div', {
        ref: boxRef,
        className: 'todo-edit',
        onKeyDown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        },
      },
        h('input', {
          ref: inputRef, className: 'todo-edit-title', value: d.title,
          placeholder: '待办内容',
          onChange: (e) => patch('title', e.target.value),
        }),
        h('div', { className: 'todo-edit-fields' },
          h('input', {
            className: 'todo-field', type: 'date', value: d.dueDate,
            onChange: (e) => patch('dueDate', e.target.value),
          }),
          h('input', {
            className: 'todo-field', type: 'time', value: d.dueTime,
            style: { maxWidth: '78px' },
            onChange: (e) => patch('dueTime', e.target.value),
          }),
          h('select', {
            className: 'todo-field', value: d.tag,
            onChange: (e) => patch('tag', e.target.value),
          }, ...Object.entries(TAG_META).map(([k, v]) => h('option', { key: k, value: k }, v.name))),
          h('button', {
            className: 'todo-toggle', 'data-on': d.important ? '1' : '0',
            onClick: () => patch('important', !d.important),
          }, '重要'),
          h('button', {
            className: 'todo-toggle', 'data-on': d.urgent ? '1' : '0',
            onClick: () => patch('urgent', !d.urgent),
          }, '紧急'),
          dirty ? h('span', { className: 'todo-edit-dirty' }, '未保存') : null,
          h('div', { className: 'todo-edit-actions' },
            h('button', { className: 'todo-btn-ghost', onClick: onCancel }, '取消'),
            h('button', { className: 'todo-btn-primary', disabled: busy, onClick: save },
              busy ? '保存中…' : '保存')),
        ),
      );
    }

    function Row({ t, onToggle, onDelete, editing, onEdit, onSave, onCancelEdit }) {
      const q = t.important && t.urgent ? 1 : t.important ? 2 : t.urgent ? 3 : 4;
      const tag = TAG_META[t.tag] || TAG_META.work;
      const todayKey = ymd(new Date());
      const daysLeft = t.dueDate
        ? Math.round((Date.parse(t.dueDate) - Date.parse(todayKey)) / 86400000)
        : null;
      const isOverdue = Boolean(t.dueDate) && !t.done && t.dueDate < todayKey;
      /* 临近只是显示信号：不进象限，只给时间标签上色 */
      const isSoon = !t.done && !isOverdue && daysLeft !== null && daysLeft >= 0 && daysLeft <= 2;
      const when = t.dueTime
        ? t.dueTime
        : (daysLeft === 0 ? '今天'
          : daysLeft === 1 ? '明天'
            : daysLeft === 2 ? '后天'
              : (t.dueDate ? t.dueDate.slice(5).replace('-', '/') : ''));

      if (editing) {
        return h(EditRow, { t, onSave, onCancel: onCancelEdit });
      }

      return h('div', {
        className: 'todo-row',
        'data-done': t.done ? '1' : '0',
        'data-q': String(q),
        onDoubleClick: (e) => {
          const el = e.target;
          if (el && el.closest && el.closest('.todo-del, .todo-check')) return;
          onEdit(t.id);
        },
      },
        h('button', { className: 'todo-check', onClick: () => onToggle(t), 'aria-label': '完成' }),
        h('span', { className: 'todo-prio', 'data-q': String(q), title: importantLabel(q) },
          h('i'), h('i'), h('i'), h('i')),
        h('span', { className: 'todo-t', title: '双击编辑' }, t.title || '(无标题)'),
        h('span', { className: 'todo-tag' },
          h('i', { style: { background: tag.color } }), tag.name),
        h('span', { className: 'todo-fill' }),
        when ? h('span', {
          className: 'todo-when',
          'data-hot': t.dueTime ? '1' : '0',
          'data-over': isOverdue ? '1' : '0',
          'data-soon': isSoon ? '1' : '0',
        }, when) : null,
        h('button', { className: 'todo-del', onClick: () => onDelete(t), title: '删除' },
          h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
            h('path', { d: 'M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13' }))),
      );
    }

    function importantLabel(q) {
      return q === 1 ? '重要 · 紧急' : q === 2 ? '重要 · 不紧急' : q === 3 ? '不重要 · 紧急' : '不重要 · 不紧急';
    }

    /* ============================================================
       面板
       ============================================================ */
    function TodoPanel() {
      const [todos, setTodos] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [period, setPeriod] = React.useState('today');
      const [tagFilter, setTagFilter] = React.useState('all');
      const [creating, setCreating] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const [search, setSearch] = React.useState(null);
      const [helpOpen, setHelpOpen] = React.useState(false);
      const [chatCollapsed, setChatCollapsed] = React.useState(false);
      const [editingId, setEditingId] = React.useState(null);

      /* —— 对话（P2 外壳，尚未接模型）—— */
      const [messages, setMessages] = React.useState([]);

      /* 面板重开时从宿主回填历史对话 */
      React.useEffect(() => {
        let alive = true;
        api('GET', 'conversation')
          .then((d) => {
            if (!alive || !d) return;
            if (d.context) setCtxInfo(d.context);
            if (!Array.isArray(d.messages) || !d.messages.length) return;
            const list = d.messages.map((m, i) => {
              const next = d.messages[i + 1];
              /* 下一句用户消息就是某个选项 → 视为已作答 */
              const chosen = (m.ask && next && next.role === 'user' && m.ask.indexOf(next.text) >= 0)
                ? next.text
                : null;
              return {
                id: 'h' + i,
                role: m.role === 'user' ? 'user' : 'ai',
                text: m.text,
                images: (m.images || []).map((x) => x.url
                  || ('/api/todo/shot?ref=' + encodeURIComponent(x.id))),
                drafts: m.drafts && m.drafts.length ? m.drafts : null,
                ready: true,
                ask: m.ask && m.ask.length ? m.ask : null,
                chosen,
              };
            });
            setMessages(list);
          })
          .catch(() => { /* 读不到就保持空 */ });
        return () => { alive = false; };
      }, []);
      const [chatDraft, setChatDraft] = React.useState('');
      const [chatBusy, setChatBusy] = React.useState(false);
      const [ctxInfo, setCtxInfo] = React.useState(null);
      const [models, setModels] = React.useState(null);
      const [efforts, setEfforts] = React.useState(null);
      const [modelMenu, setModelMenu] = React.useState(false);

      const refreshMeta = React.useCallback(async () => {
        try {
          const d = await api('GET', 'models');
          setModels(d);
        } catch (e) { /* 拿不到就退回占位文案 */ }
        try {
          const r = await api('GET', 'reasoning');
          setEfforts(r);
        } catch (e) { /* 没有思考等级就不显示这一档 */ }
      }, []);

      React.useEffect(() => { refreshMeta(); }, []);

      const modelName = React.useMemo(() => {
        if (!models || !models.current) return '模型';
        const p = (models.providers || []).find((x) => x.id === models.current.provider);
        const m = p && (p.models || []).find((x) => x.id === models.current.model);
        return (m && m.name) || models.current.model;
      }, [models]);

      const effortName = React.useMemo(() => {
        if (!models || !models.current) return '';
        const id = models.current.reasoningEffort || (efforts && efforts.current) || '';
        if (!id) return '';
        const hit = ((efforts && efforts.efforts) || []).find((e) => e.id === id);
        return hit ? hit.name : id;
      }, [models, efforts]);

      const chipLabel = effortName ? modelName + ' ' + effortName : modelName;

      const pickModel = React.useCallback(async (provider, model) => {
        setModelMenu(false);
        try {
          await api('POST', 'model', provider ? { provider, model } : {});
          await refreshMeta();
        } catch (e) {
          setToast({ text: '切换模型失败：' + e.message });
        }
      }, [refreshMeta]);

      const pickEffort = React.useCallback(async (id) => {
        if (!models || !models.current) return;
        try {
          await api('POST', 'model', {
            provider: models.current.provider,
            model: models.current.model,
            reasoningEffort: id,
          });
          await refreshMeta();
        } catch (e) {
          setToast({ text: '切换思考等级失败：' + e.message });
        }
      }, [models, refreshMeta]);

      const [attachments, setAttachments] = React.useState([]);
      const [preview, setPreview] = React.useState(null);

      /* 大图预览：Esc 关闭 */
      React.useEffect(() => {
        if (!preview) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setPreview(null); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [preview]);

      /* —— 日历视图 —— */
      const [view, setView] = React.useState('list');
      const [calY, setCalY] = React.useState(() => new Date().getFullYear());
      const [calM, setCalM] = React.useState(() => new Date().getMonth() + 1);
      const [cells, setCells] = React.useState(null);
      const [calLoading, setCalLoading] = React.useState(false);
      const [pickerOpen, setPickerOpen] = React.useState(false);
      const wheelLock = React.useRef(0);

      React.useEffect(() => {
        if (view !== 'calendar') return undefined;
        let alive = true;
        setCalLoading(true);
        api('GET', 'month?y=' + calY + '&m=' + calM)
          .then((d) => { if (alive) { setCells(d.cells); setCalLoading(false); } })
          .catch((e) => {
            if (!alive) return;
            setCalLoading(false);
            setToast({ text: '日历加载失败：' + ((e && e.message) || e) });
          });
        return () => { alive = false; };
      }, [view, calY, calM]);

      const shiftMonth = (delta) => {
        let y = calY;
        let m = calM + delta;
        if (m < 1) { m = 12; y -= 1; }
        if (m > 12) { m = 1; y += 1; }
        if (y < 1900 || y > 2100) return;
        setCalY(y);
        setCalM(m);
      };

      const onCalWheel = (e) => {
        const stamp = Date.now();
        if (stamp < wheelLock.current) return;
        if (Math.abs(e.deltaY) < 12) return;
        wheelLock.current = stamp + 280;
        shiftMonth(e.deltaY > 0 ? 1 : -1);
      };

      const runSend = React.useCallback(async (text, imgs) => {
        if (chatBusy) return;

        setMessages((m) => [...m, { role: 'user', text: text || '（截图）', images: imgs.map((x) => x.preview) }]);
        setChatBusy(true);

        const aid = 'a' + Date.now();
        setMessages((m) => [...m, { role: 'ai', id: aid, text: '', drafts: null, ready: false }]);

        try {
          const res = await fetch('/api/todo/chat', {
            method: 'POST',
            headers: { 'x-dsh-todo': '1', 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              images: imgs.map((x) => ({ mediaType: x.mediaType, data: x.data })),
            }),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);

          let acc = '';
          await readSse(res, (ev, payload) => {
            if (ev === 'start' && payload && payload.context) {
              setCtxInfo(payload.context);
            } else if (ev === 'delta' && payload && payload.text) {
              acc += payload.text;
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, text: acc } : x)));
            } else if (ev === 'draft' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid
                ? { ...x, drafts: payload.tasks || [], ready: true }
                : x)));
            } else if (ev === 'ask' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid
                ? { ...x, ask: payload.options || [] }
                : x)));
            } else if (ev === 'error' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, error: payload.message || '对话失败' } : x)));
            }
          });
        } catch (e) {
          setMessages((m) => m.map((x) => (x.id === aid
            ? { ...x, error: '对话失败：' + ((e && e.message) || e) }
            : x)));
        } finally {
          setChatBusy(false);
        }
      }, [chatBusy]);

      const sendChat = React.useCallback(() => {
        const text = chatDraft.trim();
        const imgs = attachments;
        if ((!text && imgs.length === 0) || chatBusy) return;
        setChatDraft('');
        setAttachments([]);
        runSend(text, imgs);
      }, [chatDraft, attachments, chatBusy, runSend]);

      /* 点选项 = 用户说了这句话 */
      const chooseOption = React.useCallback((msgId, option) => {
        setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, chosen: option } : x)));
        runSend(option, []);
      }, [runSend]);

      const onPasteImages = React.useCallback(async (files) => {
        for (const file of files) {
          try {
            const img = await compressImage(file);
            setAttachments((prev) => [...prev, img].slice(0, 4));
          } catch (e) {
            setToast({ text: '图片处理失败：' + ((e && e.message) || e) });
          }
        }
      }, []);

      const clearChat = React.useCallback(async () => {
        try {
          await api('POST', 'conversation-clear', {});
          setMessages([]);
          const d = await api('GET', 'conversation').catch(() => null);
          setCtxInfo(d && d.context ? d.context : null);
        } catch (e) {
          setToast({ text: '清空失败：' + ((e && e.message) || e) });
        }
      }, []);

      const saveEdit = React.useCallback(async (next) => {
        setEditingId(null);
        setTodos((prev) => (prev || []).map((x) => (x.id === next.id ? { ...x, ...next } : x)));
        try {
          await api('POST', 'upsert', { todo: next });
          await load();
          setToast({ text: '已更新「' + next.title + '」' });
        } catch (e) {
          setToast({ text: '更新失败：' + ((e && e.message) || e) });
          await load();
        }
      }, []);   /* load 声明在后面，调用时已初始化 */

      const createDrafts = React.useCallback(async (items) => {
        const done = [];
        let failed = 0;
        for (const it of items) {
          try {
            await api('POST', 'upsert', {
              todo: {
                title: it.title,
                dueDate: it.dueDate || null,
                dueTime: it.dueTime || null,
                tag: it.tag,
                important: Boolean(it.important),
                urgent: Boolean(it.urgent),
                done: false,
                notes: it.notes || null,
                source: 'text',
              },
            });
            done.push(it.title);
          } catch (e) {
            failed += 1;
          }
        }
        setToast({
          text: failed
            ? `已创建 ${done.length} 条，${failed} 条失败`
            : `已创建 ${done.length} 条待办`,
        });
        await load();
        return done;
      }, []);   /* load 在后面声明，依赖留空：调用时它已初始化，且其本身是稳定引用 */
      const rootRef = React.useRef(null);

      const load = React.useCallback(async () => {
        try {
          const data = await api('GET', 'list');
          setTodos(data.todos || []);
          setError(null);
        } catch (e) {
          setError(e.message);
          setTodos([]);
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      React.useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
      }, [toast]);

      /* 按面板背景亮度判定明暗，挑强调色（宿主 brand 是单色，撑不起原型的层次） */
      React.useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const bg = getComputedStyle(root).backgroundColor || '';
        const m = bg.match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return;
        const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
        root.setAttribute('data-tone', lum < 0.5 ? 'dark' : 'light');
      }, []);

      /* 一次性布局自检：把真实尺寸/颜色写回 Host，外部可核对，不依赖截图 */
      React.useEffect(() => {
        if (!window.__TODO_DEV__) return undefined;   // 仅开发期开启
        const timer = setTimeout(() => {
          try {
            const root = rootRef.current;
            if (!root) return;
            const one = (s) => root.querySelector(s);
            const rect = (el) => {
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
            };
            const chip = one('.todo-chip[data-on="1"]');
            const cs = chip ? getComputedStyle(chip) : null;
            const rootCs = getComputedStyle(root);
            const TOKENS = [
              '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
              '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
              '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
              '--dsw-alias-brand-primary', '--dsw-alias-state-success-primary',
              '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
              '--dsw-alias-state-idle-primary', '--dsw-specific-sidebar-fill',
            ];
            const palette = {};
            for (const name of TOKENS) palette[name] = rootCs.getPropertyValue(name).trim();
            const row = one('.todo-row');
            const payload = {
              rootW: Math.round(root.getBoundingClientRect().width),
              bodyW: one('.todo-body') ? Math.round(one('.todo-body').getBoundingClientRect().width) : null,
              firstBlockW: one('.todo-sum') ? Math.round(one('.todo-sum').getBoundingClientRect().width) : null,
              activeChip: chip ? { text: chip.textContent, bg: cs.backgroundColor, color: cs.color, border: cs.borderColor } : null,
              dateText: one('.todo-date') ? one('.todo-date').textContent : null,
              rowGeometry: row ? {
                check: rect(row.querySelector('.todo-check')),
                ti: rect(row.querySelector('.todo-t')),
                tag: rect(row.querySelector('.todo-tag')),
                when: rect(row.querySelector('.todo-when')),
              } : null,
              rows: root.querySelectorAll('.todo-row').length,
              groups: [...root.querySelectorAll('.todo-gh span:first-child')].map((el) => el.textContent),
              tone: root.getAttribute('data-tone'),
              palette,
            };
            fetch('/api/todo/log', {
              method: 'POST',
              headers: { 'content-type': 'text/plain', 'x-dsh-todo': '1' },
              body: 'SELFCHECK ' + JSON.stringify(payload),
            }).catch(() => {});
          } catch (e) {
            fetch('/api/todo/log', {
              method: 'POST',
              headers: { 'content-type': 'text/plain', 'x-dsh-todo': '1' },
              body: 'SELFCHECK_ERR ' + (e && e.message),
            }).catch(() => {});
          }
        }, 900);
        return () => clearTimeout(timer);
      }, []);

      const todayStr = ymd(new Date());
      const weekEnd = weekEndOf(todayStr);
      const monthEnd = monthEndOf(todayStr);

      /* ---- 派生数据 ---- */
      const decorated = (todos || []).map((t) => ({ ...t, _kind: groupOf(t, todayStr, weekEnd) }));

      const periodDef = PERIODS.find((p) => p.id === period) || PERIODS[0];
      let visible = decorated;
      if (periodDef.doneOnly) visible = decorated.filter((t) => t.done);
      else if (periodDef.kinds) visible = decorated.filter((t) => periodDef.kinds.includes(t._kind));
      if (periodDef.id === 'month') visible = visible.filter((t) => !t.dueDate || (t.dueDate >= todayStr.slice(0, 8) + '01' && t.dueDate <= monthEnd));
      if (tagFilter !== 'all') visible = visible.filter((t) => t.tag === tagFilter);
      const keyword = (search || '').trim().toLowerCase();
      if (keyword) {
        visible = visible.filter((t) => (t.title || '').toLowerCase().includes(keyword)
          || (t.notes || '').toLowerCase().includes(keyword));
      }

      const plate = decorated.filter((t) => t._kind === 'today' || t._kind === 'overdue');
      const plateDone = plate.filter((t) => t.done).length;

      /* ---- 交互 ---- */
      const toggle = async (t) => {
        const next = !t.done;
        setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: next } : x)));
        try {
          await api('POST', 'toggle', { id: t.id });
          await load();          // 成功后静默对账，保持与宿主一致的排序
        } catch (e) {
          setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: t.done } : x)));
          setToast({ text: '操作失败：' + e.message });
        }
      };

      const remove = async (t) => {
        setTodos((prev) => prev.filter((x) => x.id !== t.id));
        try {
          await api('POST', 'remove', { id: t.id });
          setToast({ text: '已删除「' + (t.title || '待办') + '」', undo: t });
          await load();
        } catch (e) {
          setTodos((prev) => [...prev, t]);
          setToast({ text: '删除失败：' + e.message });
        }
      };

      const undo = async () => {
        const t = toast && toast.undo;
        setToast(null);
        if (!t) return;
        try {
          await api('POST', 'upsert', { todo: t });
          await load();
        } catch (e) {
          setToast({ text: '撤销失败：' + e.message });
        }
      };

      /* 手动创建：和编辑同一套界面，标题留空 */
      const BLANK_TODO = {
        id: null,
        title: '',
        dueDate: null,
        dueTime: null,
        tag: 'work',
        important: false,
        urgent: false,
        done: false,
        notes: null,
      };

      const createOne = async (next) => {
        setCreating(false);
        try {
          await api('POST', 'upsert', {
            todo: {
              title: next.title,
              dueDate: next.dueDate || null,
              dueTime: next.dueTime || null,
              tag: next.tag,
              important: Boolean(next.important),
              urgent: Boolean(next.urgent),
              done: false,
              source: 'manual',
            },
          });
          await load();
          setToast({ text: '已添加「' + next.title + '」' });
        } catch (e) {
          setToast({ text: '创建失败：' + ((e && e.message) || e) });
        }
      };

      /* ---- 渲染 ---- */
      const groups = GROUP_LABELS
        .map((g) => ({ ...g, items: visible.filter((t) => t._kind === g.key) }))
        .filter((g) => g.items.length > 0);

      const head = h('div', { className: 'todo-head' },
        h('div', { className: 'todo-title' }, '待办'),
        view === 'list'
          ? h('div', { className: 'todo-seg' },
              ...PERIODS.map((p) => h('button', {
                key: p.id,
                'data-on': period === p.id ? '1' : '0',
                onClick: () => setPeriod(p.id),
              }, p.label)))
          : null,
        h('div', { className: 'todo-seg todo-view-seg' },
          h('button', {
            className: 'todo-view-btn', 'data-on': view === 'list' ? '1' : '0',
            onClick: () => setView('list'), title: '列表视图',
          }, h('svg', {
            viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', 'aria-hidden': true,
          },
            h('path', { d: 'M9 6.5h11M9 12h11M9 17.5h11' }),
            h('circle', { cx: 4.5, cy: 6.5, r: 1.4, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 4.5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 4.5, cy: 17.5, r: 1.4, fill: 'currentColor', stroke: 'none' }))),
          h('button', {
            className: 'todo-view-btn', 'data-on': view === 'calendar' ? '1' : '0',
            onClick: () => setView('calendar'), title: '日历视图',
          }, h('svg', {
            viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          },
            h('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }),
            h('path', { d: 'M3.5 9.8h17M8 3v3.2M16 3v3.2' })))),
        h('span', { className: 'todo-pill' }, plateDone + ' / ' + plate.length),
        search !== null
          ? h('input', {
              className: 'todo-search', value: search, autoFocus: true,
              placeholder: '搜索待办…',
              onChange: (e) => setSearch(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Escape') setSearch(null); },
            })
          : null,
        h('div', { className: 'todo-tools' },
          h('button', { className: 'todo-tool', title: '帮助', onClick: () => setHelpOpen((v) => !v) },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
              h('circle', { cx: 12, cy: 12, r: 8.6 }),
              h('path', { d: 'M9.5 9.4a2.6 2.6 0 1 1 3.4 2.5c-.9.3-1.3 1-1.3 1.9v.3' }),
              h('circle', { cx: 11.6, cy: 17, r: 0.9, fill: 'currentColor', stroke: 'none' }))),
          h('button', {
            className: 'todo-tool', title: '搜索', 'data-on': search !== null ? '1' : '0',
            onClick: () => setSearch(search === null ? '' : null),
          },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
              h('circle', { cx: 10.8, cy: 10.8, r: 6.4 }),
              h('path', { d: 'M15.6 15.6L20 20' }))),
          h('button', {
            className: 'todo-tool', title: '新建待办',
            onClick: () => {
              setView('list');
              setCreating(true);
            },
          },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
              h('path', { d: 'M12 5v14M5 12h14' }))),
          h('button', {
            className: 'todo-tool', title: chatCollapsed ? '展开助手' : '收起助手',
            onClick: () => setChatCollapsed((v) => !v),
          },
            h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' },
              h('rect', { x: 3.6, y: 5, width: 16.8, height: 14, rx: 2.6 }),
              h('path', { d: 'M14.6 5v14' })))),
        helpOpen
          ? h('div', { className: 'todo-help' },
              h('div', { className: 'todo-help-title' }, '怎么用'),
              h('div', { className: 'todo-help-row' }, '粘贴截图或直接说一句话，会拆成待办草案'),
              h('div', { className: 'todo-help-row' }, '草案卡：缺日期的补完才能创建，创建过的会打 ✓'),
              h('div', { className: 'todo-help-row' }, '列表里勾选即完成，删除有 5 秒撤销'),
              h('div', { className: 'todo-help-row' }, '双击任意待办进入编辑；改动后需保存或取消才能退出'),
              h('div', { className: 'todo-help-row' }, '助手提问时会给出选项按钮，点一下就等于回答'),
              h('div', { className: 'todo-help-row' }, '顶部两个图标切换列表 / 日历'))
          : null,
      );

      const body = h('div', { className: 'todo-body' },
        h('div', { className: 'todo-sum' },
          h('div', { className: 'todo-date' }, formatDate(new Date()),
            h('span', null, weekdayName(new Date()) + (period === 'today' ? ' · 今天' : ''))),
          h('div', { className: 'todo-bar' },
            h('i', { style: { width: (plate.length ? Math.round(plateDone / plate.length * 100) : 0) + '%' } })),
          h('div', { className: 'todo-meta' }, h('span', null, h('b', null, plateDone), '/' + plate.length + ' 已完成')),
        ),

        h('div', { className: 'todo-tags' },
          h('button', {
            className: 'todo-chip', 'data-on': tagFilter === 'all' ? '1' : '0',
            onClick: () => setTagFilter('all'),
          }, '全部'),
          ...Object.entries(TAG_META).map(([k, m]) => h('button', {
            key: k, className: 'todo-chip', 'data-on': tagFilter === k ? '1' : '0',
            onClick: () => setTagFilter(k),
          }, h('i', { style: { background: tagFilter === k ? '#fff' : m.color } }), m.name)),
        ),

        creating
          ? h(EditRow, {
              t: BLANK_TODO,
              onSave: createOne,
              onCancel: () => setCreating(false),
            })
          : h('button', { className: 'todo-add', onClick: () => setCreating(true) }, '＋ 添加待办'),

        error ? h('div', { className: 'todo-err' }, '加载失败：' + error) : null,

        todos === null
          ? h('div', { className: 'todo-empty' }, '加载中…')
          : (groups.length === 0
              ? h('div', { className: 'todo-empty' },
                  keyword
                    ? '没有匹配「' + search.trim() + '」的待办'
                    : ((todos || []).length
                        ? '这个分组里还没有待办'
                        : '这里还没有待办 —— 点上面的虚线行加一条'))
              : groups.map((g) => h('div', { key: g.key, className: 'todo-group' },
                  h('div', { className: 'todo-gh', 'data-alert': g.alert ? '1' : '0' },
                    h('span', null, g.label), h('em', null, g.items.length), h('i')),
                  ...g.items.map((t) => h(Row, {
                    key: t.id,
                    t,
                    onToggle: toggle,
                    onDelete: remove,
                    editing: editingId === t.id,
                    onEdit: (id) => setEditingId(id),
                    onSave: saveEdit,
                    onCancelEdit: () => setEditingId(null),
                  })),
                ))),
      );

      const board = view === 'calendar'
        ? h(CalendarView, {
            y: calY,
            m: calM,
            cells,
            todos: todos || [],
            todayKey: todayStr,
            loading: calLoading,
            range: { from: 1900, to: 2100 },
            pickerOpen,
            onPrev: () => shiftMonth(-1),
            onNext: () => shiftMonth(1),
            onToday: () => {
              const d = new Date();
              setCalY(d.getFullYear());
              setCalM(d.getMonth() + 1);
            },
            onTogglePicker: () => setPickerOpen((v) => !v),
            onPickYear: (yy) => { setCalY(yy); setPickerOpen(false); },
            onPickMonth: (mm) => { setCalM(mm); setPickerOpen(false); },
            onWheel: onCalWheel,
          })
        : body;

      return h('div', {
        className: 'todo-root',
        ref: rootRef,
        'data-collapsed': chatCollapsed ? '1' : '0',
      },
        head,
        h('div', { className: 'todo-main' },
          board,
          chatCollapsed ? null : h(ChatPane, {
            messages, busy: chatBusy, draft: chatDraft,
            onDraft: setChatDraft, onSend: sendChat,
            models, modelName, chipLabel, effortName, menuOpen: modelMenu,
            onToggleMenu: setModelMenu, onPick: pickModel,
            efforts, onPickEffort: pickEffort,
            attachments,
            onPasteImages,
            onRemoveAttachment: (i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i)),
            onCreateDrafts: createDrafts,
            ctxInfo,
            onPreview: setPreview,
            onClear: clearChat,
            onChoose: chooseOption,
            knownTitles: (todos || []).map((t) => t.title),
          }),
        ),
        toast ? h('div', { className: 'todo-toast' },
          h('span', null, toast.text),
          toast.undo ? h('button', { onClick: undo }, '撤销') : null,
        ) : null,
        preview
          ? h('div', { className: 'todo-lightbox', onClick: () => setPreview(null) },
              h('img', { src: preview, alt: '预览' }),
              h('button', {
                className: 'todo-lightbox-x', title: '关闭（Esc）',
                onClick: (e) => { e.stopPropagation(); setPreview(null); },
              }, '✕'))
          : null,
      );
    }

    function formatDate(d) {
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function weekdayName(d) { return WEEK[d.getDay()]; }

    /* ============================================================
       图标 + 注册
       ============================================================ */
    function Icon(props) {
      const size = props && props.size ? props.size : 18;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M4 7l2 2 3.5-3.5' }),
        h('path', { d: 'M4 16l2 2 3.5-3.5' }),
        h('path', { d: 'M13 7.5h7' }),
        h('path', { d: 'M13 16.5h7' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles());
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'todos' }, TodoPanel));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'todos', order: 20 }, Icon));
      },
    };
  },
});
