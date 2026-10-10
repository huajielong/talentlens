import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import core from './dist/core.js';
import { isIP } from 'node:net';
import { ClientStore, problem } from './pg-store.mjs';
const cookieName = 'talentlens_session';
const readCookie = req => {
  const pair = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='));
  return pair?.slice(cookieName.length + 1) || '';
};
const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const consent = '2026-10-v1';
export async function createCloudServer(env, fetcher, services, store) {
  const production = env.NODE_ENV === 'production',
    publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null;
  if (production && (!publicUrl || publicUrl.protocol !== 'https:')) throw Error('客户部署必须设置 HTTPS PUBLIC_URL。');
  if (production && !(await store.initialized()) && (!env.TALENTLENS_SETUP_TOKEN || env.TALENTLENS_SETUP_TOKEN.length < 32)) {
    store.close();
    throw Error('首次部署请设置至少 32 位 TALENTLENS_SETUP_TOKEN。');
  }
  let working = false,
    stopping = false,
    runningTask = null,
    controller = null,
    authBusy = 0;
  const activeModels = new Map();
  const meteredFetch = (actor, signal) => async (url, options = {}) => {
    if (!url.endsWith('/chat/completions') && !url.endsWith('/responses')) return fetcher(url, {
      ...options,
      signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal
    });
    const active = activeModels.get(actor.companyId) || 0;
    if (active >= 2) throw problem(429, '团队同时最多运行 2 个模型请求，请稍后重试。');
    const input = JSON.parse(options.body),
      maximum = Buffer.byteLength(options.body) + (input.max_tokens || input.max_output_tokens || 6500),
      usage = await store.reserve(actor, maximum);
    activeModels.set(actor.companyId, active + 1);
    let settled = false;
    const settle = async (tokens, status) => {
      if (settled) return;
      settled = true;
      await store.settle(usage, tokens, status);
      activeModels.set(actor.companyId, (activeModels.get(actor.companyId) || 1) - 1);
    };
    try {
      const r = await fetcher(url, {
        ...options,
        signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal
      });
      if (!r.ok) {
        await settle(null, 'failed');
        return r;
      }
      return {
        ok: r.ok,
        status: r.status,
        json: async () => {
          try {
            const data = await r.json(),
              tokens = data.usage?.total_tokens ?? (data.usage?.input_tokens != null && data.usage?.output_tokens != null ? data.usage.input_tokens + data.usage.output_tokens : null);
            await settle(Number.isInteger(tokens) && tokens >= 0 ? tokens : null, 'completed');
            return data;
          } catch (e) {
            await settle(null, 'failed');
            throw e;
          }
        }
      };
    } catch (e) {
      await settle(null, 'failed');
      throw e;
    }
  };

  const publicActor = async session => session ? {
    authenticated: true,
    user: session.actor,
    csrf: session.csrf,
    company: await store.company(session.actor)
  } : {
    authenticated: false,
    initialized: await store.initialized(),
    setupRequiresToken: production,
    consentVersion: consent
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(JSON.stringify(data));
    };
    const setCookie = (token, age = 28800) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${production ? '; Secure' : ''}`);
    try {
      const url = new URL(req.url, 'http://localhost'),
        origin = publicUrl?.origin || `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw problem(403, '跨站请求已拒绝。');
      if (production && !publicUrl?.host) throw problem(503, '服务配置未完成。');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        await store.db.prepare('SELECT 1').get();
        return send(200, {
          status: 'ok'
        });
      }
      const token = readCookie(req),
        session = await store.session(token);
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return send(200, await publicActor(session));
      let body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem(415, '请使用 JSON 请求。');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > (url.pathname.startsWith('/api/auth') ? 20000 : 20000000)) throw problem(413, '输入过长。');
          chunks.push(chunk);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw problem(400, '请求格式无效。');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, '请求格式无效。');
      }
      if (req.method === 'POST' && ['/api/auth/setup', '/api/auth/login'].includes(url.pathname)) {
        if (authBusy >= 3) throw problem(429, '登录服务繁忙，请稍后重试。');
        authBusy++;
        try {
          if (url.pathname === '/api/auth/setup') {
            if (await store.initialized()) throw problem(409, '工作空间已初始化，请登录。');
            if (production ? body.setupToken !== env.TALENTLENS_SETUP_TOKEN : !isLoopback(req.socket.remoteAddress)) throw problem(403, '首次初始化须从服务器本机进行，或提供正确的部署令牌。');
            await store.setup(body.companyName, body.username, body.name, body.password, services.validateWorkspace);
          }
          const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
          const address = env.TRUST_PROXY === '1' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
          const result = await store.login(body.username, body.password, address);
          setCookie(result.token);
          return send(200, await publicActor({
            actor: result.actor,
            csrf: result.csrf
          }));
        } finally {
          authBusy--;
        }
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) throw problem(401, '请先登录。');
        const actor = session.actor;
        if (req.method === 'POST' && req.headers['x-csrf-token'] !== session.csrf) throw problem(403, '登录校验已过期，请刷新页面。');
        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
          await store.logout(token);
          setCookie('', 0);
          return send(200, {
            loggedOut: true
          });
        }
        if (url.pathname === '/api/auth/password' && req.method === 'POST') {
          await store.changePassword(actor, body.currentPassword, body.password);
          setCookie('', 0);
          return send(200, {
            changed: true
          });
        }
        if (actor.mustChangePassword) throw problem(403, '首次登录请先修改初始密码。');
        if (url.pathname === '/api/config' && req.method === 'GET') {
          const c = services.llmConfig(env);
          return send(200, {
            configured: !!c.key,
            model: c.model,
            provider: c.provider,
            consentVersion: consent
          });
        }
        if (url.pathname === '/api/workspace') {
          if (req.method === 'GET') return send(200, {
            version: 4,
            jobs: await store.jobs(actor),
            tasks: await store.tasks(actor),
            usage: await store.usage(actor)
          });
          if (req.method === 'POST') {
            services.validateWorkspace(body.jobs);
            return send(200, {
              saved: true,
              jobs: await store.saveJobs(actor, body.jobs)
            });
          }
        }
        if (url.pathname === '/api/parse' && req.method === 'POST') {
          if (body.consentVersion !== consent) throw problem(400, '请先确认将 JD 和公开资料发送至模型服务。');
          if (typeof body.jd !== 'string' || !body.jd.trim() || body.jd.length > 20000) throw problem(400, 'JD 需为 1–20000 字。');
          await store.audit(actor, 'jd.parse');
          return send(200, await services.parseJob(body.jd, {
            ...env,
            MODEL_TIMEOUT_MS: '22000'
          }, meteredFetch(actor)));
        }
        if (url.pathname === '/api/tasks' && req.method === 'POST') {
          if (body.consentVersion !== consent) throw problem(400, '请先确认将 JD 和公开资料发送至模型服务。');
          const job = await store.getJob(actor, body.jobId);
          if (!job.job || job.job.jd !== job.jd.trim()) throw problem(400, '请先解析并保存当前岗位。');
          if (!Array.isArray(body.logins) || !body.logins.length || body.logins.length > 10 || body.logins.some(n => typeof n !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(n))) throw problem(400, '每批最多 10 个有效账号。');
          const names = [...new Set(body.logins.map(n => n.toLowerCase()))].filter(n => body.force || !job.people.some(p => p.login.toLowerCase() === n && core.profile(p, {
            ...job.job,
            criteria: job.skills
          }).valid));
          const tasks = await store.addTasks(actor, job, names, !!body.force);
          return send(202, {
            tasks
          });
        }
        if (url.pathname === '/api/tasks/cancel' && req.method === 'POST') {
          const id = await store.cancel(actor, body.id);
          if (runningTask?.id === id) controller?.abort();
          return send(200, {
            cancelled: true
          });
        }
        if (url.pathname === '/api/reviews' && req.method === 'POST') return send(200, {
          job: await store.review(actor, body)
        });
        if (url.pathname === '/api/admin/users') {
          store.requireAdmin(actor);
          if (req.method === 'GET') return send(200, {
            users: await store.users(actor)
          });
          if (req.method === 'POST') {
            const users = body.id ? await store.updateUser(actor, body) : await store.addUser(actor, body);
            if (body.id && body.enabled === false && runningTask?.actorId === body.id) controller?.abort();
            return send(200, {
              users
            });
          }
        }
        if (url.pathname === '/api/admin/assign' && req.method === 'POST') return send(200, {
          jobs: await store.assign(actor, body.jobId, body.ownerId, body.revision)
        });
        if (url.pathname === '/api/usage' && req.method === 'GET') return send(200, await store.usage(actor));
        if (url.pathname === '/api/admin/limits' && req.method === 'POST') return send(200, await store.limits(actor, body));
        if (url.pathname === '/api/admin/audit' && req.method === 'GET') return send(200, {
          events: await store.audits(actor)
        });
        if (url.pathname === '/api/admin/health' && req.method === 'GET') {
          store.requireAdmin(actor);
          return send(200, await store.health());
        }
        throw problem(404, '接口不存在。');
      }
      if (req.method !== 'GET') throw problem(405, '方法不支持。');
      const files = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/style.css': 'style.css',
        '/app.js': 'app.js',
        '/core.js': 'core.js',
        '/client.js': 'client.js'
      };
      const file = files[url.pathname];
      if (!file) throw problem(404, '页面不存在。');
      res.writeHead(200, {
        'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      });
      res.end(await readFile(new URL('./dist/' + file, import.meta.url)));
    } catch (e) {
      const internal = !e.status && (/^[0-9A-Z]{5}$/.test(e.code || '') || ['EIO','ENOSPC','EACCES','EPERM'].includes(e.code));
      if (internal) console.error('Storage failure:', e.code);
      send(internal ? 500 : e.status || 400, {
        error: internal ? '数据保存服务异常，请联系管理员。' : e.name === 'TimeoutError' ? '接口超时，请重试。' : e.message
      });
    }
  });
  server.customerStore = store;
  server.maxConnections = 100;
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  return server;
}
