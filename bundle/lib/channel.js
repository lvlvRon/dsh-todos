/**
 * HTTP 通道封装。
 *
 * 背景（README 原文）：dsh-host-webserver「No server-wide authentication or origin
 * policy — route owners enforce their own request policy」。也就是这些路由默认没有任何
 * 鉴权，必须自己挡。
 *
 * 当前两层防御：
 *   1. 同源校验 —— 挡掉恶意网页发起的跨站请求
 *   2. 自定义头 x-dsh-todo —— 挡掉简单表单 POST（CSRF）
 *
 * 已知剩余暴露：本机其它进程可以直接请求。这是本地应用的固有面，写进文档。
 */

const JSON_TYPE = 'application/json; charset=utf-8';

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function fail(res, status, message) {
  send(res, status, { ok: false, error: message });
}

/** 读取并解析 JSON 请求体，带体积上限 */
export async function readJson(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large (limit ' + limit + ')');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * 请求守卫。返回 true 表示放行。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ mutating?: boolean }} options
 */
export function guard(req, res, options = {}) {
  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch (e) {
      sameHost = false;
    }
    if (!sameHost) {
      fail(res, 403, 'cross-origin request rejected');
      return false;
    }
  }
  if (options.mutating && req.headers['x-dsh-todo'] !== '1') {
    fail(res, 403, 'missing x-dsh-todo header');
    return false;
  }
  return true;
}

/**
 * 创建一个 SSE 响应；返回写入函数与关闭函数。
 * @param {import('node:http').ServerResponse} res
 */
export function openSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return {
    event(name, data) {
      if (res.writableEnded) return;
      if (name) res.write('event: ' + name + '\n');
      res.write('data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
    },
    close() {
      if (!res.writableEnded) res.end();
    },
  };
}
