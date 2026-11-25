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
    /** 剩余天数：负数为逾期，null 为未排期 */
    function daysLeftOf(t, todayStr) {
      if (!t.dueDate) return null;
      return Math.round((Date.parse(t.dueDate) - Date.parse(todayStr)) / 86400000);
    }

    /** 分节：逾期并入「今天」；未排期并入「以后」 */
    function groupOf(t, todayStr) {
      const dl = daysLeftOf(t, todayStr);
      if (dl === null) return 'later';
      if (dl <= 0) return 'today';
      if (dl <= 3) return 'd3';
      if (dl <= 7) return 'd7';
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
      { id: 'today', label: '今天' },
      { id: 'week', label: '本周' },
      { id: 'month', label: '本月' },
      { id: 'all', label: '全部' },
    ];

    /* 列表内的分节：按剩余天数把未完成项分到四段 */
    const GROUP_LABELS = [
      { key: 'today', label: '今天' },
      { key: 'd3', label: '三天内' },
      { key: 'd7', label: '7天内' },
      { key: 'later', label: '以后' },
    ];

    /** 帮助浮层里的行内图标 */
    function helpIcon(d) {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, ...d.map((path, i) => h('path', { key: i, d: path })));
    }

    const HELP_SECTIONS = [
      {
        title: '和助手说话',
        rows: [
          { icon: ['M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-9.5A7.5 7.5 0 0 1 11.5 6H12a7.5 7.5 0 0 1 8 6.5z'], text: '粘贴截图或直接说一句话，拆成待办草案' },
          { icon: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], text: '缺日期的草案会留下，补完才能创建' },
          { icon: ['M4 7h16', 'M9 7V4.5h6V7', 'M6 7l1 13h10l1-13'], text: '点行尾气泡图标，把这条交给助手改' },
          { icon: ['M9.5 9.4a2.6 2.6 0 1 1 3.4 2.5c-.9.3-1.3 1-1.3 1.9v.3', 'M11.6 17a.9.9 0 1 0 .01 0'], text: '助手提问时会出选项按钮，点一下即回答' },
        ],
      },
      {
        title: '列表',
        rows: [
          { icon: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'], text: '时间段：今天 · 本周 · 本月 · 全部 · 已完成' },
          { icon: ['M4 6h16', 'M4 12h10', 'M4 18h7'], text: '列表内分节：今天 · 三天内 · 7天内 · 以后' },
          { icon: ['M5 12.5l4.5 4.5L19 7'], text: '勾选即完成；删除后 5 秒内可撤销' },
        ],
      },
      {
        title: '数据与模型',
        rows: [
          { icon: ['M4 7v10', 'M4 7l8 4 8-4', 'M12 11v10', 'M20 7v10'], text: '待办存在 DSH 存储域，不写工作区文件' },
          { icon: ['M12 4v11', 'M8 8l4-4 4 4', 'M8 16l4 4 4-4'], text: '顶部 ⇅ 按钮可导出 / 导入 JSON（含已完成）' },
          { icon: ['M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 5.9L12 16.4 6.7 19.3 7.9 13.4 3.4 9.3l6-.7z'], text: '默认跟随 DSH 的模型，也可单独选与调推理等级' },
        ],
      },
    ];

    function renderHelp(persona) {
      return h('div', { className: 'todo-help' },
        h('div', { className: 'todo-help-head' },
          avatarNode(persona, 'todo-avatar todo-help-avatar'),
          h('div', null,
            h('div', { className: 'todo-help-title' }, (persona && persona.name) || '待办助手'),
            h('div', { className: 'todo-help-sub' }, '清单 · 日历 · 对话，都在这一块面板里'))),
        ...HELP_SECTIONS.map((sec) => h('div', { key: sec.title, className: 'todo-help-sec' },
          h('div', { className: 'todo-help-sec-title' }, sec.title),
          ...sec.rows.map((row, i) => h('div', { key: i, className: 'todo-help-row' },
            h('span', { className: 'todo-help-ico' }, helpIcon(row.icon)),
            h('span', null, row.text))))),
        h('div', { className: 'todo-help-sec' },
          h('div', { className: 'todo-help-sec-title' }, '快捷键'),
          h('div', { className: 'todo-help-keys' },
            h('span', null, h('kbd', { className: 'todo-kbd' }, 'Enter'), ' 发送'),
            h('span', null, h('kbd', { className: 'todo-kbd' }, 'Shift'), ' + ', h('kbd', { className: 'todo-kbd' }, 'Enter'), ' 换行'),
            h('span', null, h('kbd', { className: 'todo-kbd' }, 'Esc'), ' 关闭浮层 / 取消编辑'))),
        h('div', { className: 'todo-help-foot' }, '双击任意待办即可修改 · 助手改完会立即刷新列表'));
    }
    function normalizeDraft(t) {
      return {
        title: String((t && t.title) || '').trim() || '未命名',
        dueDate: (t && t.dueDate) || '',
        dueTime: (t && t.dueTime) || '',
        tag: t && TAG_META[t.tag] ? t.tag : 'work',
        important: Boolean(t && t.important),
        urgent: Boolean(t && t.urgent),
        notes: (t && t.notes) || '',
        startDate: (t && t.startDate) || null,
        suggestedDueDate: (t && t.suggestedDueDate) || null,
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
            it.startDate
              ? h('span', {
                className: 'todo-field todo-start-chip',
                title: '开始日 ' + it.startDate,
              }, dateShort(it.startDate) + ' 起')
              : null,
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

    /** 助手头像：有图用图，没图用名字首字 */
    function avatarSrc(persona) {
      if (!persona || !persona.avatar) return null;
      return persona.avatar.startsWith('preset:')
        ? '/api/todo/avatar?name=' + encodeURIComponent(persona.avatar.slice(7) + '.png')
        : persona.avatar;
    }

    function avatarNode(persona, className) {
      const src = avatarSrc(persona);
      if (src) {
        return h('div', { className: className + ' todo-ava-img' }, h('img', { src, alt: '' }));
      }
      const name = (persona && persona.name ? persona.name : '步').trim();
      return h('div', { className }, name ? name.slice(0, 1) : '步');
    }

    function renderMessage(m, key, onCreate, onPreview, onChoose, knownTitles, persona) {
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
        avatarNode(persona, 'todo-ai-avatar'),
        h('div', { className: 'todo-ai-body' },
          shown ? h(Markdown, { text: shown }) : null,
          m.drafts && m.drafts.length
            ? h(DraftCard, { tasks: m.drafts, ready: Boolean(m.ready), onCreate, knownTitles })
            : null,
          m.tools && m.tools.length
            ? h('div', { className: 'todo-tool-note' },
                (() => {
                  const agg = new Map();
                  m.tools.forEach((t) => {
                    const cur = agg.get(t.name) || { n: 0, calls: 0 };
                    agg.set(t.name, { n: cur.n + (t.count || 0), calls: cur.calls + 1 });
                  });
                  return [...agg.entries()].map(([name, v]) => {
                    if (name === 'update_todo') return '修改 ' + v.n + ' 条';
                    if (name === 'delete_todo') return '删除 ' + v.n + ' 条';
                    return '查询待办 ' + v.n + ' 条' + (v.calls > 1 ? '（' + v.calls + ' 次）' : '');
                  }).join(' · ');
                })())
            : null,
          (m.shotCount || (m.shot && m.shot.items && m.shot.items.length))
            ? h('div', { className: 'todo-tool-note' },
                '截图识别 ' + (m.shotCount || m.shot.items.length) + ' 条')
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

    const ANN_TYPES = [
      { id: 'birthday', name: '生日', color: '#c2255c' },
      { id: 'anniversary', name: '纪念日', color: '#d9480f' },
      { id: 'memorial', name: '忌日', color: '#495057' },
      { id: 'other', name: '其他', color: '#4d6bfe' },
    ];

    function annTypeOf(id) {
      return ANN_TYPES.find((t) => t.id === id) || ANN_TYPES[3];
    }

    function calText(ev) {
      return ev.cal === 'lunar'
        ? '农历 ' + ev.month + ' 月 ' + ev.day + ' 日' + (ev.leap ? '（闰）' : '')
        : '公历 ' + ev.month + ' / ' + ev.day;
    }

    function leftText(days) {
      if (days === null || days === undefined) return '';
      if (days === 0) return '今天';
      if (days === 1) return '明天';
      return '还有 ' + days + ' 天';
    }

    /** 纪念日浮窗：列表 ↔ 表单 两屏 */
    function renderAnnPopover(props) {
      const { annList, annScreen, annDraft } = props;

      if (annScreen === 'form' && annDraft) {
        const set = (k, v) => props.onAnnDraft({ ...annDraft, [k]: v });
        return h('div', { className: 'todo-ann-pop' },
          h('div', { className: 'todo-ann-head' },
            h('button', { className: 'todo-ann-back', onClick: () => props.onAnnScreen('list') }, '‹ 返回'),
            h('span', { className: 'todo-ann-title' }, annDraft.id ? '编辑纪念日' : '新增纪念日')),
          h('div', { className: 'todo-ann-form' },
            h('input', {
              className: 'todo-field', style: { width: '100%', maxWidth: 'none' },
              placeholder: '名称，如「妈妈生日」', value: annDraft.label,
              onChange: (e) => set('label', e.target.value),
            }),
            h('div', { className: 'todo-ann-chips' },
              ...ANN_TYPES.map((t) => h('button', {
                key: t.id, className: 'todo-ann-chip', 'data-on': annDraft.type === t.id ? '1' : '0',
                onClick: () => set('type', t.id),
              }, t.name))),
            h('div', { className: 'todo-ann-chips' },
              h('button', {
                className: 'todo-ann-chip', 'data-on': annDraft.cal === 'solar' ? '1' : '0',
                onClick: () => set('cal', 'solar'),
              }, '公历'),
              h('button', {
                className: 'todo-ann-chip', 'data-on': annDraft.cal === 'lunar' ? '1' : '0',
                onClick: () => set('cal', 'lunar'),
              }, '农历'),
              annDraft.cal === 'lunar'
                ? h('button', {
                    className: 'todo-ann-chip', 'data-on': annDraft.leap ? '1' : '0',
                    onClick: () => set('leap', !annDraft.leap),
                  }, '闰月')
                : null),
            h('div', { className: 'todo-ann-date' },
              h('input', {
                className: 'todo-field', type: 'number', min: 1, max: 12, style: { maxWidth: '78px' },
                value: annDraft.month, onChange: (e) => set('month', Number(e.target.value)),
              }),
              h('span', { className: 'todo-ann-unit' }, '月'),
              h('input', {
                className: 'todo-field', type: 'number', min: 1, max: 31, style: { maxWidth: '78px' },
                value: annDraft.day, onChange: (e) => set('day', Number(e.target.value)),
              }),
              h('span', { className: 'todo-ann-unit' }, '日')),
            h('input', {
              className: 'todo-field', style: { width: '100%', maxWidth: 'none' },
              placeholder: '备注（可选）', value: annDraft.notes || '',
              onChange: (e) => set('notes', e.target.value),
            }),
            h('div', { className: 'todo-ann-actions' },
              annDraft.id
                ? h('button', { className: 'todo-ann-danger', onClick: props.onAnnRemove }, '删除')
                : null,
              h('span', { style: { flex: 1 } }),
              h('button', { className: 'todo-btn-ghost', onClick: () => props.onAnnScreen('list') }, '取消'),
              h('button', { className: 'todo-btn-primary', onClick: props.onAnnSave }, '保存'))),
        );
      }

      return h('div', { className: 'todo-ann-pop' },
        h('div', { className: 'todo-ann-head' },
          h('span', { className: 'todo-ann-title' }, '我的纪念日 ' + (annList.length || '')),
          h('button', { className: 'todo-ann-add', onClick: props.onAnnNew }, '＋ 新增')),
        annList.length
          ? h('div', null, ...annList.map((ev) => {
            const t = annTypeOf(ev.type);
            return h('div', {
              key: ev.id, className: 'todo-ann-row', onClick: () => props.onAnnEdit(ev),
            },
              h('i', { className: 'todo-ann-dot', style: { background: t.color } }),
              h('span', { className: 'todo-ann-name' }, ev.label),
              h('span', { className: 'todo-ann-cal' }, calText(ev)),
              h('span', { className: 'todo-ann-left' }, leftText(ev.daysLeft)));
          }))
          : h('div', { className: 'todo-ann-empty' }, '还没有纪念日，点右上角「＋ 新增」'),
      );
    }

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
          h('button', {
            className: 'todo-ann-btn', 'data-on': props.annOpen ? '1' : '0',
            onClick: props.onToggleAnn,
          }, '纪念日' + (props.annList && props.annList.length ? ' ' + props.annList.length : '')),
          props.annOpen ? renderAnnPopover(props) : null,
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
      efforts, onPickEffort, onClear, onChoose, knownTitles, taRef, refTodo, onClearRef,
      persona, onOpenPersona, personaOpen, personaDraft, presets,
      onPersonaDraft, onSavePersona, onClosePersona, onAvatarFile,
    }) {
      const threadRef = React.useRef(null);
      const wrapRef = React.useRef(null);
      const fileRef = React.useRef(null);
      const avatarRef = React.useRef(null);
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
          h('button', {
            className: 'todo-ava-btn', title: '助手形象设置',
            onClick: () => onOpenPersona(),
          }, avatarNode(persona, 'todo-avatar')),
          h('div', { className: 'todo-chat-id' },
            h('b', null, persona.name),
            h('span', { className: 'todo-chat-status' }, h('i'), '待办助手 · 常驻对话'),
          ),
          messages.length
            ? h('button', {
                className: 'todo-chat-clear', title: '清空对话（历史与摘要一起删除）',
                onClick: onClear,
              }, '清空')
            : null,
        ),
        personaOpen && personaDraft
          ? h('div', { className: 'todo-persona-pop' },
              h('div', { className: 'todo-persona-head' },
                h('span', { className: 'todo-persona-title' }, '助手形象'),
                h('button', {
                  className: 'todo-icon-btn', title: '关闭', style: { marginLeft: 'auto' },
                  onClick: onClosePersona,
                }, '✕')),
              h('div', { className: 'todo-persona-preview-wrap' },
                avatarNode(personaDraft, 'todo-persona-preview')),
              h('div', { className: 'todo-persona-lab' }, '名称'),
              h('input', {
                className: 'todo-field', style: { width: '100%', maxWidth: 'none' },
                value: personaDraft.name, maxLength: 20, placeholder: '小步',
                onChange: (e) => onPersonaDraft({ ...personaDraft, name: e.target.value }),
              }),
              h('div', { className: 'todo-persona-lab' }, '头像'),
              h('div', { className: 'todo-persona-grid' },
                ...presets.map((p) => h('button', {
                  key: p.id,
                  className: 'todo-persona-item',
                  'data-on': personaDraft.avatar === p.id ? '1' : '0',
                  title: '使用这个头像',
                  onClick: () => onPersonaDraft({ ...personaDraft, avatar: p.id }),
                }, h('img', { src: p.url, alt: '' }))),
                h('button', {
                  className: 'todo-persona-item todo-persona-upload', title: '上传自定义头像',
                  onClick: () => { if (avatarRef.current) avatarRef.current.click(); },
                }, '＋'),
                h('input', {
                  ref: avatarRef, type: 'file', accept: 'image/*', style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) onAvatarFile(f);
                    e.target.value = '';
                  },
                })),
              h('div', { className: 'todo-persona-actions' },
                personaDraft.avatar
                  ? h('button', {
                      className: 'todo-ann-danger',
                      onClick: () => onPersonaDraft({ ...personaDraft, avatar: null }),
                    }, '移除头像')
                  : null,
                h('span', { style: { flex: 1 } }),
                h('button', { className: 'todo-btn-ghost', onClick: onClosePersona }, '取消'),
                h('button', { className: 'todo-btn-primary', onClick: onSavePersona }, '保存')))
          : null,
        h('div', { className: 'todo-thread', ref: threadRef },
          messages.length === 0 && !busy
            ? h('div', { className: 'todo-chat-empty' },
                '粘贴一张截图，或直接说「周三下午三点开评审会」',
                h('br'),
                '我会把它拆成待办')
            : null,
          ...messages.map((m, i) => renderMessage(m, i, onCreateDrafts, onPreview, onChoose, knownTitles, persona)),
          busy ? h('div', { className: 'todo-typing' }, h('i'), h('i'), h('i')) : null,
        ),
        h('div', { className: 'todo-composer' },
          h('div', { className: 'todo-composer-inner' },
            refTodo
              ? h('div', { className: 'todo-ref-chip' },
                  h('span', { className: 'todo-ref-label' }, '改这条'),
                  h('span', { className: 'todo-ref-title' }, refTodo.title),
                  h('span', { className: 'todo-ref-when' },
                    [refTodo.dueDate || '未排期', refTodo.dueTime].filter(Boolean).join(' ')),
                  h('button', {
                    className: 'todo-ref-x', title: '取消引用',
                    onClick: () => onClearRef(),
                  }, '×'))
              : null,
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
              className: 'todo-textarea', rows: 2, value: draft, ref: taRef,
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
                disabled: busy || (!draft.trim() && !(attachments && attachments.length) && !refTodo),
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
        startDate: t.startDate || '',
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
        || d.urgent !== initial.urgent
        || d.startDate !== initial.startDate;

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
            startDate: d.startDate || null,
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
          h('span', { className: 'todo-est' },
            h('span', { className: 'todo-est-lab' }, '开始'),
            h('input', {
              className: 'todo-field', type: 'date', value: d.startDate || '',
              onChange: (e) => patch('startDate', e.target.value),
            })),
          dirty ? h('span', { className: 'todo-edit-dirty' }, '未保存') : null,
          h('div', { className: 'todo-edit-actions' },
            h('button', { className: 'todo-btn-ghost', onClick: onCancel }, '取消'),
            h('button', { className: 'todo-btn-primary', disabled: busy, onClick: save },
              busy ? '保存中…' : '保存')),
        ),
      );
    }

    /** 日期短写：2026-11-25 → 11/25 */
    function dateShort(iso) {
      return iso ? iso.slice(5).replace('-', '/') : '';
    }

    function Row({ t, onToggle, onDelete, editing, onEdit, onSave, onCancelEdit, onToChat }) {
      const q = t.important && t.urgent ? 1 : t.important ? 2 : t.urgent ? 3 : 4;
      const tag = TAG_META[t.tag] || TAG_META.work;
      const todayKey = ymd(new Date());

      /* —— 时间轴：开始日 → 持续天数 → 截止日 —— */
      const startISO = t.startDate || null;
      const dueISO = t.dueDate || t.suggestedDueDate || null;
      const isSuggested = !t.dueDate && Boolean(t.suggestedDueDate);
      const dayOf = (iso) => (iso ? Math.round((Date.parse(iso) - Date.parse(todayKey)) / 86400000) : null);
      const toStart = dayOf(startISO);
      const toDue = dayOf(dueISO);

      /* 阶段判定 */
      let phase = 'none';
      if (t.done) phase = 'done';
      else if (dueISO && toDue < 0) phase = 'over';
      else if (startISO && toStart > 0) phase = 'pending';
      else if (dueISO && toDue === 0) phase = 'today';
      else if (dueISO && toDue === 1) phase = 'tomorrow';
      else if (startISO) phase = 'active';
      else if (dueISO) phase = 'dated';

      /* 展示：日期 时间（主）+ 进度（次），截止日永远在 */
      const dueText = dueISO
        ? (isSuggested ? '建议 ' : '') + dateShort(dueISO) + (t.dueTime ? ' ' + t.dueTime : '')
        : '';

      let progText = '';
      if (t.done) progText = '已完成';
      else if (phase === 'over') progText = '逾期 ' + Math.abs(toDue) + ' 天';
      else if (phase === 'today') progText = '今天截止';
      else if (phase === 'tomorrow') progText = '明天截止';
      else if (phase === 'active' && startISO && dueISO) {
        const total = Math.max(1, toDue - toStart + 1);
        const dayNo = Math.min(total, Math.max(1, 1 - toStart));
        progText = '第 ' + dayNo + '/' + total + ' 天';
      } else if (phase === 'active' && startISO) {
        progText = '已开始 ' + Math.max(1, 1 - toStart) + ' 天';
      } else if (phase === 'pending') {
        progText = dateShort(startISO) + ' 起';
      }

      const fullWhen = [startISO ? '开始 ' + startISO : '', dueISO ? '截止 ' + dueISO : '']
        .filter(Boolean).join(' · ');

      /* 四档色：富余 / 后半程 / 来不及 / 逾期 */
      /* 阶段色：灰(未开始) → 蓝(进行中) → 橙(该收尾/明天截止) → 红(今天截止) → 深红(逾期) */
      let tier = 'normal';
      if (phase === 'done') tier = 'done';
      else if (phase === 'over') tier = 'over';
      else if (phase === 'today') tier = 'late';
      else if (phase === 'tomorrow') tier = 'start';
      else if (phase === 'active') {
        if (startISO && dueISO) {
          const span = Math.max(1, toDue - toStart);
          tier = (-toStart / span) >= 0.75 ? 'start' : 'active';
        } else {
          tier = 'active';
        }
      }

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
        dueText ? h('span', {
          className: 'todo-when',
          title: fullWhen,
          'data-tier': tier,
        }, dueText) : null,
        progText ? h('span', {
          className: 'todo-prog',
          'data-tier': tier,
          title: fullWhen,
        }, progText) : null,
        h('button', { className: 'todo-todel', onClick: () => onToChat(t), title: '发送到助手' },
          h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-9.5A7.5 7.5 0 0 1 11.5 6H12a7.5 7.5 0 0 1 8 6.5z' }))),
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
      const [period, setPeriod] = React.useState('all');
      const [showDone, setShowDone] = React.useState(false);
      const [tagFilter, setTagFilter] = React.useState('all');
      const [creating, setCreating] = React.useState(false);
      const importRef = React.useRef(null);
      const composerRef = React.useRef(null);
      const dataWrapRef = React.useRef(null);
      const [dataMenu, setDataMenu] = React.useState(false);
      const [refTodo, setRefTodo] = React.useState(null);

      /* —— 助手形象 —— */
      const [persona, setPersona] = React.useState({ name: '小步', avatar: null });
      const [presets, setPresets] = React.useState([]);
      const [personaOpen, setPersonaOpen] = React.useState(false);
      const [personaDraft, setPersonaDraft] = React.useState(null);

      React.useEffect(() => {
        api('GET', 'persona')
          .then((d) => {
            if (d && d.persona) setPersona(d.persona);
            if (d && Array.isArray(d.presets)) setPresets(d.presets);
          })
          .catch(() => { /* 用默认形象 */ });
      }, []);

      const openPersona = () => { setPersonaDraft({ ...persona }); setPersonaOpen(true); };
      const closePersona = () => setPersonaOpen(false);
      const savePersona = async () => {
        if (!personaDraft) return;
        try {
          const d = await api('POST', 'persona-save', {
            name: personaDraft.name,
            avatar: personaDraft.avatar,
          });
          setPersona(d.persona);
          setPersonaOpen(false);
          setToast({ text: '助手形象已更新' });
        } catch (e) {
          setToast({ text: '保存失败：' + ((e && e.message) || e) });
        }
      };
      const onAvatarFile = async (file) => {
        try {
          const img = await compressImage(file, 128, 0.9);
          setPersonaDraft((d) => (d ? { ...d, avatar: img.preview } : d));
        } catch (e) {
          setToast({ text: '头像处理失败：' + ((e && e.message) || e) });
        }
      };

      /* 导入导出菜单：点外部关闭 */
      React.useEffect(() => {
        if (!dataMenu) return undefined;
        const onDoc = (e) => {
          if (dataWrapRef.current && dataWrapRef.current.contains(e.target)) return;
          setDataMenu(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [dataMenu]);

      /* 导出全部待办（含已完成）为 JSON 文件 */
      const exportTodos = async () => {
        try {
          const res = await fetch('/api/todo/export', { headers: { 'x-dsh-todo': '1' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          const payload = JSON.parse(text);
          const blob = new Blob([text], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'dsh-todos-' + ymd(new Date()) + '.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          setToast({ text: '已导出 ' + (payload.todos ? payload.todos.length : 0) + ' 条待办' });
        } catch (e) {
          setToast({ text: '导出失败：' + ((e && e.message) || e) });
        }
      };

      /* 导入：按 id 合并，已存在的覆盖，不存在的新增 */
      const importTodos = async (file) => {
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const d = await api('POST', 'import', data);
          setToast({
            text: '导入完成：新增 ' + d.added + ' 条，更新 ' + d.updated + ' 条'
              + (d.skipped ? '，跳过 ' + d.skipped + ' 条' : '')
              + (d.eventsAdded ? '，重要日期 ' + d.eventsAdded + ' 个' : ''),
          });
          await load();
        } catch (e) {
          setToast({ text: '导入失败：' + ((e && e.message) || e) });
        }
      };
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
                tools: m.tools && m.tools.length ? m.tools : null,
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

      /* —— 纪念日 —— */
      const [annList, setAnnList] = React.useState([]);
      const [annOpen, setAnnOpen] = React.useState(false);
      const [annScreen, setAnnScreen] = React.useState('list');
      const [annDraft, setAnnDraft] = React.useState(null);
      const [calTick, setCalTick] = React.useState(0);

      const loadEvents = React.useCallback(async () => {
        try {
          const d = await api('GET', 'events');
          setAnnList(d.events || []);
        } catch (e) { /* 忽略 */ }
      }, []);

      React.useEffect(() => { loadEvents(); }, [loadEvents]);

      const annNew = () => {
        setAnnDraft({ label: '', type: 'birthday', cal: 'solar', month: 1, day: 1, leap: false, notes: '' });
        setAnnScreen('form');
      };
      const annEdit = (ev) => { setAnnDraft({ ...ev }); setAnnScreen('form'); };
      const annSave = async () => {
        const d = annDraft;
        if (!d || !String(d.label).trim()) { setToast({ text: '请先填写名称' }); return; }
        try {
          await api('POST', 'event', {
            event: {
              id: d.id,
              label: String(d.label).trim(),
              type: d.type,
              cal: d.cal,
              month: Number(d.month),
              day: Number(d.day),
              leap: d.cal === 'lunar' ? Boolean(d.leap) : null,
              notes: d.notes || null,
            },
          });
          setAnnScreen('list');
          await loadEvents();
          setCalTick((t) => t + 1);
          setToast({ text: '已保存「' + String(d.label).trim() + '」' });
        } catch (e) {
          setToast({ text: '保存失败：' + ((e && e.message) || e) });
        }
      };
      const annRemove = async () => {
        if (!annDraft || !annDraft.id) { setAnnScreen('list'); return; }
        try {
          await api('POST', 'event-remove', { id: annDraft.id });
          setAnnScreen('list');
          await loadEvents();
          setCalTick((t) => t + 1);
          setToast({ text: '已删除「' + annDraft.label + '」' });
        } catch (e) {
          setToast({ text: '删除失败：' + ((e && e.message) || e) });
        }
      };

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
      }, [view, calY, calM, calTick]);

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
            } else if (ev === 'tool' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid
                ? { ...x, tools: [...(x.tools || []), payload] }
                : x)));
            } else if (ev === 'shot' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, shotCount: payload.count } : x)));
            } else if (ev === 'mutated' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, mutated: payload } : x)));
              load();   // 让列表立刻反映助手的改动
              const bits = [];
              if (payload.updated) bits.push('修改 ' + payload.updated + ' 条');
              if (payload.deleted) bits.push('删除 ' + payload.deleted + ' 条');
              setToast({ text: '助手已' + bits.join('、') });
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
        const base = chatDraft.trim();
        const imgs = attachments;
        if ((!base && imgs.length === 0 && !refTodo) || chatBusy) return;

        let text = base;
        if (refTodo) {
          const when = [refTodo.dueDate || '未排期', refTodo.dueTime].filter(Boolean).join(' ');
          text = '【修改待办 ' + String(refTodo.id).slice(0, 8) + '】' + refTodo.title + '（' + when + '）'
            + '\n' + (base || '请帮我改一下这条');
        }

        setChatDraft('');
        setAttachments([]);
        setRefTodo(null);
        runSend(text, imgs);
      }, [chatDraft, attachments, chatBusy, refTodo, runSend]);

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

      /* 把某条待办送进对话框：以引用块形式挂在输入框上方，不污染你打的字 */
      const sendToChat = React.useCallback((t) => {
        setChatCollapsed(false);
        setRefTodo(t);
        setTimeout(() => {
          const el = composerRef.current;
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 60);
      }, []);

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
                startDate: it.startDate || null,
                suggestedDueDate: it.suggestedDueDate || null,
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

      /* ---- 派生数据 ---- */
      const todayStr = ymd(new Date());
      const weekEnd = weekEndOf(todayStr);
      const monthEnd = monthEndOf(todayStr);

      const decorated = (todos || []).map((t) => ({ ...t, _kind: groupOf(t, todayStr) }));

      const periodDef = PERIODS.find((p) => p.id === period) || PERIODS[0];
      const daysToWeekEnd = Math.round((Date.parse(weekEnd) - Date.parse(todayStr)) / 86400000);
      const monthKey = todayStr.slice(0, 7);

      /* 时间段匹配：未完成与已完成共用同一套规则 */
      const inPeriod = (t) => {
        if (periodDef.id === 'all') return true;
        const dl = daysLeftOf(t, todayStr);
        if (dl === null) return false;
        if (periodDef.id === 'today') return dl <= 0;
        if (periodDef.id === 'week') return dl <= daysToWeekEnd;
        return dl <= 0 || t.dueDate.slice(0, 7) === monthKey;   // month
      };

      let visible = decorated.filter((t) => !t.done && inPeriod(t));
      const doneVisible = showDone
        ? decorated.filter((t) => t.done && inPeriod(t)).sort((a, b) => {
          const ad = a.dueDate || '';
          const bd = b.dueDate || '';
          return ad === bd ? 0 : (ad < bd ? 1 : -1);   // 日期倒序，未排期排最后
        })
        : [];

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

      /* 勾选「已完成」后，在末尾追加一节 */
      if (doneVisible.length) {
        groups.push({ key: 'done', label: '已完成', alert: false, items: doneVisible });
      }

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
        view === 'list'
          ? h('button', {
              className: 'todo-done-toggle', 'data-on': showDone ? '1' : '0',
              title: showDone ? '隐藏已完成' : '显示已完成',
              onClick: () => setShowDone((v) => !v),
            }, h('span', { className: 'todo-done-box' }), '已完成')
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
          h('div', { className: 'todo-data-wrap', ref: dataWrapRef },
            h('button', {
              className: 'todo-tool', title: '导入 / 导出', 'data-on': dataMenu ? '1' : '0',
              onClick: () => setDataMenu((v) => !v),
            },
              h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
                h('path', { d: 'M8 9.5L12 5.5l4 4' }),
                h('path', { d: 'M12 5.5v13' }),
                h('path', { d: 'M8 14.5l4 4 4-4' }))),
            dataMenu
              ? h('div', { className: 'todo-data-pop' },
                  h('button', {
                    className: 'todo-menu-row',
                    onClick: () => { setDataMenu(false); exportTodos(); },
                  },
                    h('span', null, '导出待办'),
                    h('span', { className: 'todo-menu-val' }, '含已完成')),
                  h('button', {
                    className: 'todo-menu-row',
                    onClick: () => {
                      setDataMenu(false);
                      if (importRef.current) importRef.current.click();
                    },
                  },
                    h('span', null, '导入待办'),
                    h('span', { className: 'todo-menu-val' }, 'JSON')))
              : null),
          h('input', {
            ref: importRef, type: 'file', accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: (e) => {
              const f = e.target.files && e.target.files[0];
              if (f) importTodos(f);
              e.target.value = '';
            },
          }),
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
        helpOpen ? renderHelp(persona) : null,
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
                    onToChat: sendToChat,
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
            annList,
            annOpen,
            annScreen,
            annDraft,
            onToggleAnn: () => setAnnOpen((v) => !v),
            onAnnNew: annNew,
            onAnnEdit: annEdit,
            onAnnSave: annSave,
            onAnnRemove: annRemove,
            onAnnScreen: setAnnScreen,
            onAnnDraft: setAnnDraft,
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
            refTodo,
            onClearRef: () => setRefTodo(null),
            persona,
            onOpenPersona: openPersona,
            personaOpen,
            personaDraft,
            presets,
            onPersonaDraft: setPersonaDraft,
            onSavePersona: savePersona,
            onClosePersona: closePersona,
            onAvatarFile,
            onCreateDrafts: createDrafts,
            ctxInfo,
            onPreview: setPreview,
            onClear: clearChat,
            onChoose: chooseOption,
            taRef: composerRef,
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