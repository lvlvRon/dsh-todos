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
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ============================================================
       样式（一次注入，随插件卸载移除）
       ============================================================ */
    const CSS = `
.todo-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
--td-accent:#4d6bfe;--td-accent-weak:rgba(77,107,254,.10);--td-accent-soft:rgba(77,107,254,.16);--td-accent-ring:rgba(77,107,254,.28);
--td-chip-bg:rgba(15,17,21,.055);--td-hover:rgba(15,17,21,.035)}
.todo-root[data-tone="dark"]{--td-accent:#8ba0ff;--td-accent-weak:rgba(139,160,255,.16);--td-accent-soft:rgba(139,160,255,.22);--td-accent-ring:rgba(139,160,255,.38);--td-chip-bg:rgba(255,255,255,.09);--td-hover:rgba(255,255,255,.05)}
.todo-head{height:52px;flex:none;display:flex;align-items:center;gap:14px;padding:0 16px 0 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.todo-title{font-size:14.5px;font-weight:600;white-space:nowrap}
.todo-seg{display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--td-chip-bg)}
.todo-seg button{padding:4px 11px;border-radius:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);background:none;border:none;cursor:pointer;white-space:nowrap;font-family:inherit}
.todo-seg button:hover{color:var(--dsw-alias-label-primary)}
.todo-seg button[data-on="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:500}
.todo-pill{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--td-chip-bg);border-radius:99px;padding:1px 9px}
.todo-body{flex:1;min-height:0;overflow-y:auto;padding:26px 30px 40px}
.todo-body > *{max-width:1000px}
/* ---- 双栏 ---- */
.todo-main{flex:1;min-height:0;display:flex}
.todo-chat{width:392px;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.todo-chat-head{height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.todo-avatar{width:27px;height:27px;flex:none;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:600;background:linear-gradient(140deg,#8b9dff,#4d6bfe)}
.todo-chat-id{display:flex;flex-direction:column;gap:1px;min-width:0}
.todo-chat-id b{font-size:13px;font-weight:600}
.todo-chat-status{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:4px}
.todo-chat-status i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:block}
.todo-thread{flex:1;min-height:0;overflow-y:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:14px}
.todo-msg{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.todo-bubble{max-width:88%;border-radius:12px 12px 4px 12px;padding:9px 12px;font-size:13.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--td-chip-bg)}
.todo-ai{display:flex;gap:9px}
.todo-ai-avatar{width:23px;height:23px;flex:none;border-radius:50%;margin-top:1px;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:600;background:linear-gradient(140deg,#8b9dff,#4d6bfe)}
.todo-ai-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.todo-ai-body p{margin:0;font-size:13.5px;line-height:1.62}
.todo-typing{display:flex;gap:4px;padding:6px 0 0 32px}
.todo-typing i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-secondary);animation:todo-blink 1.3s infinite}
.todo-typing i:nth-child(2){animation-delay:.18s}
.todo-typing i:nth-child(3){animation-delay:.36s}
@keyframes todo-blink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.todo-composer{flex:none;padding:10px 12px 12px}
.todo-composer-inner{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--td-chip-bg);padding:9px 10px 7px;transition:border-color .15s}
.todo-composer-inner:focus-within{border-color:var(--td-accent-ring)}
.todo-textarea{width:100%;border:none;background:none;resize:none;outline:none;font-family:inherit;font-size:13.5px;line-height:1.55;color:var(--dsw-alias-label-primary);min-height:40px}
.todo-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.todo-toolrow{display:flex;align-items:center;gap:8px;margin-top:2px}
.todo-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75}
.todo-send{margin-left:auto;width:28px;height:28px;border-radius:8px;border:none;background:var(--td-accent);color:#fff;display:grid;place-items:center;cursor:pointer}
.todo-send:disabled{opacity:.35;cursor:not-allowed}
.todo-icon-btn{width:26px;height:26px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);display:grid;place-items:center;cursor:pointer;padding:0}
.todo-icon-btn:hover{background:var(--td-hover);color:var(--dsw-alias-label-primary)}
@media (max-width: 980px){.todo-chat{width:320px}.todo-body{padding:22px 20px 32px}}
@media (max-width: 760px){.todo-chat{display:none}}
.todo-chat-empty{margin:auto;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7;padding:0 20px}
/* ---- 模型选择 ---- */
.todo-model-wrap{position:relative;display:flex;min-width:0}
.todo-model-btn{display:inline-flex;align-items:center;gap:4px;max-width:160px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 7px;background:none;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit}
.todo-model-btn:hover{background:var(--td-hover);color:var(--dsw-alias-label-primary)}
.todo-model-btn::after{content:"▾";font-size:9px;opacity:.6}
.todo-model-pop{position:absolute;bottom:calc(100% + 8px);left:0;width:296px;max-height:330px;overflow-y:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 32px -16px rgba(0,0,0,.45);padding:6px;z-index:40}
.todo-model-group{font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:7px 8px 3px;letter-spacing:.04em}
.todo-model-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font-size:12.5px;padding:5px 8px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit}
.todo-model-item:hover{background:var(--td-hover)}
.todo-model-item[data-on="1"]{color:var(--td-accent);font-weight:500}
.todo-model-badge{font-size:9.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;margin-left:auto;flex:none}
/* ---- 附件 ---- */
.todo-attach-rail{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.todo-attach{position:relative;width:54px;height:54px;border-radius:7px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--td-chip-bg)}
.todo-attach img{width:100%;height:100%;object-fit:cover;display:block}
.todo-attach button{position:absolute;top:0;right:0;width:15px;height:15px;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:10px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.todo-msg-imgs{display:flex;gap:6px;margin-bottom:6px}
.todo-msg-imgs img{width:80px;height:80px;object-fit:cover;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);display:block}
/* ---- 草案卡 ---- */
.todo-draft{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.todo-draft-head{display:flex;align-items:center;gap:6px;padding:7px 10px;background:var(--td-chip-bg);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.todo-draft-item{padding:9px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.todo-draft-title{width:100%;border:none;background:none;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);outline:none;padding:0 0 6px}
.todo-draft-fields{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.todo-field{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:none;font-family:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 5px;outline:none;max-width:120px}
.todo-field:focus{border-color:var(--td-accent-ring)}
.todo-field[data-miss="1"]{border-color:var(--dsw-alias-state-warn-primary);border-style:dashed;color:var(--dsw-alias-state-warn-primary)}
.todo-toggle{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 7px;cursor:pointer;background:none;font-family:inherit}
.todo-toggle[data-on="1"]{background:var(--td-accent-soft);border-color:transparent;color:var(--td-accent)}
.todo-draft-foot{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--td-chip-bg)}
.todo-draft-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.todo-draft-note[data-warn="1"]{color:var(--dsw-alias-state-warn-primary)}
.todo-btn-primary{margin-left:auto;border:none;border-radius:7px;background:var(--td-accent);color:#fff;font-size:12px;padding:4px 12px;cursor:pointer;font-family:inherit}
.todo-btn-primary:disabled{opacity:.4;cursor:not-allowed}
.todo-msg-err{font-size:12px;color:var(--dsw-alias-state-error-primary);line-height:1.5}
/* ---- 日历 ---- */
.todo-cal{flex:1;min-width:0;display:flex;flex-direction:column;padding:16px 22px 24px;gap:8px;overflow:auto}
.todo-cal-nav{display:flex;align-items:center;gap:8px;position:relative;padding-bottom:2px}
.todo-cal-month{display:inline-flex;align-items:center;gap:5px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);background:none;border:none;cursor:pointer;font-family:inherit;padding:3px 8px;border-radius:6px}
.todo-cal-month:hover{background:var(--td-hover)}
.todo-cal-month::after{content:"▾";font-size:9px;opacity:.6}
.todo-cal-today{margin-left:auto;font-size:12px;padding:4px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:none;cursor:pointer;font-family:inherit}
.todo-cal-today:hover{background:var(--td-hover);color:var(--dsw-alias-label-primary)}
.todo-cal-dow{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.todo-cal-dow span{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center;opacity:.85}
.todo-cal-dow span.is-weekend{color:var(--dsw-alias-state-error-primary);opacity:.75}
.todo-cal-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:minmax(92px,1fr);gap:6px}
.todo-cal-cell{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:5px 6px;display:flex;flex-direction:column;gap:3px;overflow:hidden}
.todo-cal-cell.is-out{border-color:transparent;background:var(--td-hover);opacity:.55}
.todo-cal-cell.is-today{border-color:var(--td-accent-ring);background:var(--td-accent-weak)}
.todo-cal-top{display:flex;align-items:baseline;gap:6px}
.todo-cal-d{font-size:15px;line-height:1;font-weight:500;color:var(--dsw-alias-label-primary)}
.todo-cal-cell.is-today .todo-cal-d{color:var(--td-accent);font-weight:700}
.todo-cal-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.todo-cal-label.is-fest{color:var(--dsw-alias-state-error-primary);font-weight:500}
.todo-cal-label.is-term{color:var(--dsw-alias-state-success-primary);font-weight:500}
.todo-cal-pills{display:flex;flex-direction:column;gap:2px;min-height:0}
.todo-cal-pill{font-size:10px;line-height:1.5;padding:1px 4px;border-radius:3px;background:var(--td-chip-bg);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.todo-cal-pill.is-done{text-decoration:line-through;opacity:.6}
.todo-cal-more{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.8;padding-left:2px}
.todo-cal-picker{position:absolute;top:calc(100% + 6px);left:0;z-index:40;width:252px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px -16px rgba(0,0,0,.45)}
.todo-cal-picker select{width:100%;font-family:inherit;font-size:12.5px;padding:4px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none}
.todo-cal-months{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:8px}
.todo-cal-months button{font-size:12px;padding:5px 0;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.todo-cal-months button:hover{background:var(--td-hover);color:var(--dsw-alias-label-primary)}
.todo-cal-months button[data-on="1"]{background:var(--td-accent-soft);color:var(--td-accent);font-weight:500}
.todo-sum{margin-bottom:16px}
.todo-date{font-size:27px;font-weight:600;letter-spacing:-.02em;line-height:1.15}
.todo-date span{font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:10px}
.todo-bar{margin-top:14px;max-width:340px;height:5px;border-radius:99px;background:var(--td-chip-bg);overflow:hidden}
.todo-bar i{display:block;height:100%;border-radius:99px;background:var(--td-accent);transition:width .35s cubic-bezier(.4,0,.2,1)}
.todo-meta{margin-top:9px;font-size:12.5px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.todo-meta b{color:var(--dsw-alias-label-primary);font-weight:600}
.todo-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.todo-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:99px;padding:3px 10px;background:none;cursor:pointer;font-family:inherit}
.todo-chip:hover{background:var(--td-hover);color:var(--dsw-alias-label-primary)}
.todo-chip[data-on="1"]{
  background:var(--td-accent-soft);
  border-color:transparent;
  color:var(--td-accent);
  font-weight:500;
}
.todo-chip i{width:6px;height:6px;border-radius:50%;display:block}
.todo-add{width:100%;display:flex;align-items:center;gap:9px;padding:9px 12px;margin-bottom:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-tertiary);font-size:13px;background:none;cursor:pointer;font-family:inherit;text-align:left}
.todo-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.todo-input{width:100%;padding:9px 12px;margin-bottom:24px;border:1px solid var(--dsw-alias-brand-primary);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit;outline:none}
.todo-group + .todo-group{margin-top:22px}
.todo-gh{display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:0 2px}
.todo-gh span:first-child{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}
.todo-gh[data-alert="1"] span:first-child{color:var(--dsw-alias-state-error-primary)}
.todo-gh em{font-style:normal;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.todo-gh i{flex:1;height:1px;background:var(--dsw-alias-border-l1);opacity:.7}
.todo-row{position:relative;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px}
.todo-row:hover{background:var(--td-hover)}
.todo-check{width:16px;height:16px;flex:none;border-radius:50%;border:1.5px solid var(--dsw-alias-state-idle-primary);background:none;cursor:pointer;padding:0;position:relative}
.todo-check:hover{border-color:var(--td-accent)}
.todo-row[data-done="1"] .todo-check{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.todo-row[data-done="1"] .todo-check::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:7px;border:1.6px solid #fff;border-top:0;border-left:0;transform:rotate(42deg)}
.todo-prio{width:15px;height:15px;flex:none;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px}
.todo-prio i{display:block;border-radius:2px;background:rgba(206,58,54,.13)}
.todo-prio[data-q="1"] i:nth-child(1){background:rgba(206,58,54,1)}
.todo-prio[data-q="2"] i:nth-child(2){background:rgba(206,58,54,.64)}
.todo-prio[data-q="3"] i:nth-child(3){background:rgba(206,58,54,.4)}
.todo-prio[data-q="4"] i:nth-child(4){background:rgba(206,58,54,.2)}
.todo-t{font-size:14px;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.todo-row[data-done="1"] .todo-t{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-color:var(--dsw-alias-border-l2)}
.todo-tag{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:var(--td-chip-bg);border-radius:5px;padding:1px 6px}
.todo-tag i{width:5px;height:5px;border-radius:50%;display:block}
.todo-fill{flex:1;min-width:8px}
.todo-when{font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--td-chip-bg);border-radius:6px;padding:1.5px 7px;white-space:nowrap;flex:none}
.todo-when[data-hot="1"]{color:var(--td-accent);background:var(--td-accent-weak);font-weight:500}
.todo-when[data-over="1"]{background:rgba(229,72,77,.12);color:var(--dsw-alias-state-error-primary)}
.todo-del{position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0;pointer-events:none;width:26px;height:26px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;display:grid;place-items:center}
.todo-row:hover .todo-del{opacity:1;pointer-events:auto}
.todo-row:hover .todo-when{opacity:0}
.todo-del:hover{background:var(--td-chip-bg);color:var(--dsw-alias-state-error-primary)}
.todo-empty{padding:56px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}
.todo-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 8px 8px 16px;border-radius:99px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 28px -14px rgba(0,0,0,.35);font-size:12.5px;z-index:200}
.todo-toast button{border:none;background:var(--dsw-alias-brand-primary);color:#fff;border-radius:99px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.todo-err{padding:20px 0;color:var(--dsw-alias-state-error-primary);font-size:13px}
`;

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

    /** 从流式累积文本里捞出已完整的 task 对象，用于渐进渲染 */
    function partialTasks(text) {
      const out = [];
      const anchor = text.indexOf('"tasks"');
      if (anchor < 0) return out;
      const start = text.indexOf('[', anchor);
      if (start < 0) return out;
      let depth = 0;
      let objStart = -1;
      for (let i = start + 1; i < text.length; i++) {
        const c = text[i];
        if (c === '{') { if (depth === 0) objStart = i; depth += 1; }
        else if (c === '}') {
          depth -= 1;
          if (depth === 0 && objStart >= 0) {
            try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (e) { /* 未完成 */ }
            objStart = -1;
          }
        }
      }
      return out;
    }

    const PERIODS = [      { id: 'today', label: '今天', kinds: ['overdue', 'today'] },
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
      };
    }

    /** 草案卡：流式时只读预览，拿到完整结果后可编辑 */
    function DraftCard({ tasks, ready, onCreate }) {
      const [items, setItems] = React.useState(() => (tasks || []).map(normalizeDraft));
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        if (!ready) setItems((tasks || []).map(normalizeDraft));
      }, [tasks, ready]);

      const missing = items.filter((it) => !it.dueDate).length;
      const patch = (i, key, value) => setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: value } : it)));

      const submit = async () => {
        if (busy || missing > 0) return;
        setBusy(true);
        try { await onCreate(items); } finally { setBusy(false); }
      };

      return h('div', { className: 'todo-draft' },
        h('div', { className: 'todo-draft-head' },
          '识别到 ', h('b', null, String(items.length)), ' 条',
          ready ? '' : ' · 解析中…'),
        ...items.map((it, i) => h('div', { key: i, className: 'todo-draft-item' },
          ready
            ? h('input', {
                className: 'todo-draft-title', value: it.title,
                onChange: (e) => patch(i, 'title', e.target.value),
              })
            : h('div', { className: 'todo-draft-title' }, it.title),
          h('div', { className: 'todo-draft-fields' },
            ready
              ? h('input', {
                  className: 'todo-field', type: 'date', 'data-miss': it.dueDate ? '0' : '1',
                  value: it.dueDate, onChange: (e) => patch(i, 'dueDate', e.target.value),
                })
              : h('span', { className: 'todo-field', 'data-miss': it.dueDate ? '0' : '1' }, it.dueDate || '缺日期'),
            h('input', {
              className: 'todo-field', type: 'time', value: it.dueTime,
              style: { maxWidth: '78px' }, disabled: !ready,
              onChange: (e) => patch(i, 'dueTime', e.target.value),
            }),
            h('select', {
              className: 'todo-field', value: it.tag, disabled: !ready,
              onChange: (e) => patch(i, 'tag', e.target.value),
            }, ...Object.entries(TAG_META).map(([k, v]) => h('option', { key: k, value: k }, v.name))),
            h('button', {
              className: 'todo-toggle', 'data-on': it.important ? '1' : '0',
              disabled: !ready, onClick: () => patch(i, 'important', !it.important),
            }, '重要'),
            h('button', {
              className: 'todo-toggle', 'data-on': it.urgent ? '1' : '0',
              disabled: !ready, onClick: () => patch(i, 'urgent', !it.urgent),
            }, '紧急'),
          ),
        )),
        ready
          ? h('div', { className: 'todo-draft-foot' },
              h('span', { className: 'todo-draft-note', 'data-warn': missing ? '1' : '0' },
                missing ? '还有 ' + missing + ' 项缺日期' : '都齐了'),
              h('button', {
                className: 'todo-btn-primary', disabled: missing > 0 || busy, onClick: submit,
              }, busy ? '创建中…' : '全部创建'),
            )
          : null,
      );
    }

    function renderMessage(m, key, onCreate) {
      if (m.role === 'user') {
        return h('div', { key, className: 'todo-msg' },
          h('div', { className: 'todo-bubble' },
            m.images && m.images.length
              ? h('div', { className: 'todo-msg-imgs' }, ...m.images.map((src, k) => h('img', { key: k, src })))
              : null,
            m.text));
      }
      return h('div', { key, className: 'todo-ai' },
        h('div', { className: 'todo-ai-avatar' }, '步'),
        h('div', { className: 'todo-ai-body' },
          m.text ? h('p', null, m.text) : null,
          m.drafts && m.drafts.length
            ? h(DraftCard, { tasks: m.drafts, ready: Boolean(m.ready), onCreate })
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
       右侧对话栏（P2 外壳；P3 接 SSE 抽取）
       ============================================================ */
    function ChatPane({
      messages, busy, draft, onDraft, onSend, models, modelName, menuOpen, onToggleMenu, onPick,
      attachments, onPasteImages, onRemoveAttachment, onCreateDrafts,
    }) {
      const threadRef = React.useRef(null);
      const wrapRef = React.useRef(null);

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
        ),
        h('div', { className: 'todo-thread', ref: threadRef },
          messages.length === 0 && !busy
            ? h('div', { className: 'todo-chat-empty' },
                '粘贴一张截图，或直接说「周三下午三点开评审会」',
                h('br'),
                '我会把它拆成待办')
            : null,
          ...messages.map((m, i) => renderMessage(m, i, onCreateDrafts)),
          busy ? h('div', { className: 'todo-typing' }, h('i'), h('i'), h('i')) : null,
        ),
        h('div', { className: 'todo-composer' },
          h('div', { className: 'todo-composer-inner' },
            attachments && attachments.length
              ? h('div', { className: 'todo-attach-rail' },
                  ...attachments.map((a, i) => h('div', { key: i, className: 'todo-attach' },
                    h('img', { src: a.preview }),
                    h('button', { onClick: () => onRemoveAttachment(i), title: '移除' }, '×'),
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
              h('button', { className: 'todo-icon-btn', title: '添加图片（P3 接入）' },
                h('svg', {
                  viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
                  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
                },
                  h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }),
                  h('circle', { cx: 9, cy: 10, r: 1.6 }),
                  h('path', { d: 'M4.5 17l4.2-4.2 3.6 3.6 2.6-2.4 4.6 4.4' }))),
              h('div', { className: 'todo-model-wrap', ref: wrapRef },
                h('button', {
                  className: 'todo-model-btn', title: '选择模型',
                  onClick: () => onToggleMenu(!menuOpen),
                }, modelName),
                menuOpen && models
                  ? h('div', { className: 'todo-model-pop' },
                      h('button', {
                        className: 'todo-model-item',
                        onClick: () => onPick(null, null),
                      }, '跟随 DSH 默认',
                        h('span', { className: 'todo-model-badge' },
                          models.current && models.current.source === 'default' ? '当前' : '推荐')),
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
                      ]))
                  : null,
              ),
              h('span', { className: 'todo-hint' }, 'Enter 发送'),
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
    function Row({ t, onToggle, onDelete }) {
      const q = t.important && t.urgent ? 1 : t.important ? 2 : t.urgent ? 3 : 4;
      const tag = TAG_META[t.tag] || TAG_META.work;
      const isOverdue = t.dueDate && !t.done && t.dueDate < ymd(new Date());
      const when = t.dueTime
        ? t.dueTime
        : (t.dueDate ? t.dueDate.slice(5).replace('-', '/') : '');

      return h('div', { className: 'todo-row', 'data-done': t.done ? '1' : '0' },
        h('button', { className: 'todo-check', onClick: () => onToggle(t), 'aria-label': '完成' }),
        h('span', { className: 'todo-prio', 'data-q': String(q), title: importantLabel(q) },
          h('i'), h('i'), h('i'), h('i')),
        h('span', { className: 'todo-t' }, t.title || '(无标题)'),
        h('span', { className: 'todo-tag' },
          h('i', { style: { background: tag.color } }), tag.name),
        h('span', { className: 'todo-fill' }),
        when ? h('span', {
          className: 'todo-when',
          'data-hot': t.dueTime ? '1' : '0',
          'data-over': isOverdue ? '1' : '0',
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
      const [adding, setAdding] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [toast, setToast] = React.useState(null);

      /* —— 对话（P2 外壳，尚未接模型）—— */
      const [messages, setMessages] = React.useState([]);
      const [chatDraft, setChatDraft] = React.useState('');
      const [chatBusy, setChatBusy] = React.useState(false);
      const [models, setModels] = React.useState(null);
      const [modelMenu, setModelMenu] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        api('GET', 'models')
          .then((d) => { if (alive) setModels(d); })
          .catch(() => { /* 模型清单拿不到就退回占位文案 */ });
        return () => { alive = false; };
      }, []);

      const modelName = React.useMemo(() => {
        if (!models || !models.current) return '模型';
        const p = (models.providers || []).find((x) => x.id === models.current.provider);
        const m = p && (p.models || []).find((x) => x.id === models.current.model);
        return (m && m.name) || models.current.model;
      }, [models]);

      const pickModel = React.useCallback(async (provider, model) => {
        setModelMenu(false);
        try {
          const d = await api('POST', 'model', provider ? { provider, model } : {});
          setModels((prev) => (prev ? { ...prev, current: d.current } : prev));
        } catch (e) {
          setToast({ text: '切换模型失败：' + e.message });
        }
      }, []);

      const [attachments, setAttachments] = React.useState([]);

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

      const sendChat = React.useCallback(async () => {
        const text = chatDraft.trim();
        const imgs = attachments;
        if ((!text && imgs.length === 0) || chatBusy) return;

        setChatDraft('');
        setAttachments([]);
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
            if (ev === 'delta' && payload && payload.text) {
              acc += payload.text;
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, text: acc } : x)));
            } else if (ev === 'draft' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid
                ? { ...x, drafts: payload.tasks || [], ready: true }
                : x)));
            } else if (ev === 'error' && payload) {
              setMessages((m) => m.map((x) => (x.id === aid ? { ...x, error: payload.message || '对话失败' } : x)));
            }
          });
        } catch (e) {
          setMessages((m) => m.map((x) => (x.id === aid
            ? { ...x, error: '抽取失败：' + ((e && e.message) || e) }
            : x)));
        } finally {
          setChatBusy(false);
        }
      }, [chatDraft, attachments, chatBusy]);

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

      const createDrafts = React.useCallback(async (items) => {
        let ok = 0;
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
            ok += 1;
          } catch (e) {
            failed += 1;
          }
        }
        setToast({ text: failed ? `已创建 ${ok} 条，${failed} 条失败` : `已创建 ${ok} 条待办` });
        await load();
      }, []);   /* load 在后面声明，依赖留空：调用时它已初始化，且其本身是稳定引用 */
      const inputRef = React.useRef(null);
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
        if (!adding) return;
        const el = inputRef.current;
        if (el) el.focus();
      }, [adding]);

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

      const create = async () => {
        const title = draft.trim();
        if (!title) { setAdding(false); setDraft(''); return; }
        setDraft('');
        try {
          await api('POST', 'upsert', {
            todo: {
              title,
              dueDate: todayStr,
              tag: tagFilter === 'all' ? 'work' : tagFilter,
              important: false, urgent: false, done: false,
              source: 'manual',
            },
          });
          await load();
        } catch (e) {
          setToast({ text: '创建失败：' + e.message });
          setDraft(title);
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
        h('div', { className: 'todo-seg' },
          h('button', { 'data-on': view === 'list' ? '1' : '0', onClick: () => setView('list') }, '列表'),
          h('button', { 'data-on': view === 'calendar' ? '1' : '0', onClick: () => setView('calendar') }, '日历')),
        h('span', { className: 'todo-pill' }, plateDone + ' / ' + plate.length),
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

        adding
          ? h('input', {
              ref: inputRef, className: 'todo-input', value: draft,
              placeholder: '回车创建，Esc 取消',
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); create(); }
                else if (e.key === 'Escape') { setAdding(false); setDraft(''); }
              },
              onBlur: () => { if (!draft.trim()) setAdding(false); },
            })
          : h('button', { className: 'todo-add', onClick: () => setAdding(true) }, '＋ 添加待办，回车创建'),

        error ? h('div', { className: 'todo-err' }, '加载失败：' + error) : null,

        todos === null
          ? h('div', { className: 'todo-empty' }, '加载中…')
          : (groups.length === 0
              ? h('div', { className: 'todo-empty' }, '这里还没有待办 —— 点上面的虚线行加一条')
              : groups.map((g) => h('div', { key: g.key, className: 'todo-group' },
                  h('div', { className: 'todo-gh', 'data-alert': g.alert ? '1' : '0' },
                    h('span', null, g.label), h('em', null, g.items.length), h('i')),
                  ...g.items.map((t) => h(Row, { key: t.id, t, onToggle: toggle, onDelete: remove })),
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

      return h('div', { className: 'todo-root', ref: rootRef },
        head,
        h('div', { className: 'todo-main' },
          board,
          h(ChatPane, {
            messages, busy: chatBusy, draft: chatDraft,
            onDraft: setChatDraft, onSend: sendChat,
            models, modelName, menuOpen: modelMenu,
            onToggleMenu: setModelMenu, onPick: pickModel,
            attachments,
            onPasteImages,
            onRemoveAttachment: (i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i)),
            onCreateDrafts: createDrafts,
          }),
        ),
        toast ? h('div', { className: 'todo-toast' },
          h('span', null, toast.text),
          toast.undo ? h('button', { onClick: undo }, '撤销') : null,
        ) : null,
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
