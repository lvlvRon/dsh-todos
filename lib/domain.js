/**
 * 待办存储域。
 *
 * 说明：`defineDomain` / `domainTable` 来自 @deepseek-ai/dsh-storage-domain，
 * 但那个包在第三方 bundle 里 import 不到（实测 ERR_MODULE_NOT_FOUND）。
 * 领域 spec 本身只是普通数据，这里手写同形状的对象 —— 运行时行为一致。
 */

import { z } from 'zod';

export const versions = { todo: 1 };

/** 一条待办 */
export const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueDate: z.string().nullish(),          // 'YYYY-MM-DD'
  dueTime: z.string().nullish(),          // 'HH:mm'
  startDate: z.string().nullish(),        // 开始日 'YYYY-MM-DD'
  tag: z.string(),                        // work / life / study / health / money
  important: z.boolean(),
  urgent: z.boolean(),
  done: z.boolean(),
  notes: z.string().nullish(),
  rawText: z.string().nullish(),          // 原始短语，用于回显「我没解析错」
  suggestedDueDate: z.string().nullish(), // 无截止日时 AI 建议的完成日
  source: z.enum(['screenshot', 'text', 'manual']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** 插件设置（目前只有聊天模型的选择） */
export const settingsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().nullish(),
});

/** 图片附件引用（DSH attachments 的 ImageAttachmentRef） */
export const imageRefSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  name: z.string().nullish(),
  originalDimensions: z.object({ width: z.number(), height: z.number() }).nullish(),
});

/** 助手产出的待办草案（对话里回显用） */
export const draftTaskSchema = z.object({
  title: z.string(),
  dueDate: z.string().nullish(),
  dueTime: z.string().nullish(),
  tag: z.string().nullish(),
  important: z.boolean().nullish(),
  urgent: z.boolean().nullish(),
  notes: z.string().nullish(),
});

/** 一轮对话里用过的工具 */
export const toolUseSchema = z.object({
  name: z.string(),
  count: z.number(),
});

/** 单会话的对话记录 + 滚动摘要 */
export const conversationSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    at: z.number().nullish(),
    tools: z.array(toolUseSchema).nullish(),
    shot: z.any().nullish(),                // 截图识别结果（结构化文本，后续对话用它）
    images: z.array(imageRefSchema).nullish(),
    drafts: z.array(draftTaskSchema).nullish(),
    missing: z.array(z.string()).nullish(),
    ask: z.array(z.string()).nullish(),
  })),
  summary: z.string().nullish(),
  updatedAt: z.number(),
});

/** 重要日期：生日/纪念日。农历生日存「月+日」，每年现算 */
export const eventSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['birthday', 'anniversary', 'memorial', 'other']).nullish(),
  cal: z.enum(['lunar', 'solar']),
  month: z.number(),
  day: z.number(),
  leap: z.boolean().nullish(),
  notes: z.string().nullish(),
});

/** 助手形象：名称 + 头像（预设 id 或 data URL） */
export const personaSchema = z.object({
  name: z.string(),
  avatar: z.string().nullish(),
});

export const todoSpec = {
  name: 'todo',
  version: versions.todo,
  tables: {
    todos: { valueSchema: todoSchema },
    settings: { valueSchema: settingsSchema },
    conversation: { valueSchema: conversationSchema },
    events: { valueSchema: eventSchema },
    persona: { valueSchema: personaSchema },
  },
};

export function now() {
  return Date.now();
}

/** 把外部传进来的部分字段补成完整记录（新建或更新都走这里） */
export function normalize(input, previous) {
  const base = previous || {
    id: (globalThis.crypto && globalThis.crypto.randomUUID)
      ? globalThis.crypto.randomUUID()
      : 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: '',
    dueDate: null,
    dueTime: null,
    startDate: null,
    tag: 'work',
    important: false,
    urgent: false,
    done: false,
    notes: null,
    rawText: null,
    suggestedDueDate: null,
    source: 'manual',
    createdAt: now(),
  };

  const next = {
    ...base,
    ...pick(input, ['title', 'dueDate', 'dueTime', 'startDate', 'tag', 'important', 'urgent', 'done', 'notes', 'rawText', 'suggestedDueDate', 'source']),
    updatedAt: now(),
  };

  if (typeof next.title !== 'string') next.title = String(next.title ?? '');
  next.title = next.title.trim();
  next.tag = String(next.tag || 'work');
  next.important = Boolean(next.important);
  next.urgent = Boolean(next.urgent);
  next.done = Boolean(next.done);
  if (!['screenshot', 'text', 'manual'].includes(next.source)) next.source = 'manual';
  return next;
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** 列表排序：未完成优先 → 有日期优先 → 日期升序 → 时间升序 → 新建在后 */
export function compare(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const ad = a.dueDate || '9999-99-99';
  const bd = b.dueDate || '9999-99-99';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const at = a.dueTime || '99:99';
  const bt = b.dueTime || '99:99';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.createdAt - b.createdAt;
}
