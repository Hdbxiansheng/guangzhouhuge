// 网约车租车方案管理 - 云端后端（Express + Postgres/JSON 存储 + 静态页面）
// 启动：node server/index.js   端口默认 5174（可用 PORT 改）
// 设了 DATABASE_URL 就存云数据库（跨设备持久化），否则存本地 JSON。
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 5174;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_ACCOUNT = '13611472233';
const ADMIN_PASSWORD = '111111';

const sessions = new Map(); // token -> { userId, phone, role }

// ---------- 种子数据 ----------
async function seed() {
  await store.ensureTables();
  const users = await store.load('users');
  if (!users.some((u) => u.role === 'admin')) {
    users.push({ id: 'user-admin-root', phone: ADMIN_ACCOUNT, role: 'admin', name: '超级管理员', createdAt: Date.now() });
    await store.save('users', users);
  }
  const schemes = await store.load('schemes');
  if (schemes.length === 0) {
    schemes.push({
      id: store.uid('sch'), company: '广州祺宸汽车', updateDate: '2026-10-15', monthTag: '2026-10',
      coverImage: '', isRecommended: true, createTime: Date.now(),
      carList: [{ model: '次新Aion-YP(510)', range: '510', powerType: '电动', deposit: 3000,
        installmentPlans: [
          { periods: 3, monthlyRent: 3400, effectiveRent: 3400, giftDays: 0, otherBenefits: '' },
          { periods: 7, monthlyRent: 3300, effectiveRent: 3300, giftDays: 0, otherBenefits: '过年减免600、期满前后杠免油漆' },
          { periods: 12, monthlyRent: 3200, effectiveRent: 3200, giftDays: 7, otherBenefits: '过年减免800、期满免油漆' },
        ], promotions: [] }],
      rules: {},
    });
    await store.save('schemes', schemes);
  }
}

// ---------- 工具 ----------
function normalizeCompany(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
function normalizeModel(m) {
  return String(m || '')
    .replace(/全新|准新|次新|新车|二手/g, '')
    .replace(/续航[（(]?[0-9]+[)）]?(km|公里|KM)?/g, '')
    .replace(/手动|电动|混动|纯电|燃油/g, '')
    .replace(/[黑白灰金银红橙蓝紫]+色/g, '')
    .replace(/[（()）]+/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}
function schemeFingerprint(s) {
  const models = (s.carList || []).map((c) => normalizeModel(c.model)).sort().join(',');
  return `${normalizeCompany(s.company)}|${s.updateDate || ''}|${models}`;
}
function isDuplicate(existing, s) { return existing.some((e) => schemeFingerprint(e) === schemeFingerprint(s)); }

// ---------- 鉴权 ----------
function sessionFrom(req) {
  const h = req.headers.authorization || '';
  return sessions.get(h.replace(/^Bearer\s+/i, ''));
}
function requireAuth(req, res, next) { const s = sessionFrom(req); if (!s) return res.status(401).json({ error: '未登录或登录已失效' }); req.session = s; next(); }
function requireAdmin(req, res, next) { const s = sessionFrom(req); if (!s) return res.status(401).json({ error: '未登录或登录已失效' }); if (s.role !== 'admin') return res.status(403).json({ error: '无权限，仅管理员可操作' }); req.session = s; next(); }

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now(), pg: store.usePg() }));

// ==================== 方案 ====================
app.get('/api/schemes', async (req, res) => {
  let list = await store.load('schemes');
  const { month, keyword, carModel, minRent, maxRent, recommended } = req.query;
  if (month) list = list.filter((s) => (s.monthTag || '') === String(month));
  if (keyword) { const k = String(keyword).toLowerCase(); list = list.filter((s) => (s.company || '').toLowerCase().includes(k) || (s.carList || []).some((c) => (c.model || '').toLowerCase().includes(k))); }
  if (carModel) { const k = String(carModel).toLowerCase(); list = list.filter((s) => (s.carList || []).some((c) => (c.model || '').toLowerCase().includes(k))); }
  if (minRent || maxRent) { const mn = Number(minRent) || 0, mx = Number(maxRent) || Infinity; list = list.filter((s) => { const rents = (s.carList || []).flatMap((c) => (c.installmentPlans || []).map((p) => Number(p.monthlyRent))); return rents.some((r) => r >= mn && r <= mx); }); }
  if (recommended === 'true' || recommended === '1') list = list.filter((s) => s.isRecommended);
  res.json(list);
});

app.get('/api/schemes/:id', async (req, res) => { const list = await store.load('schemes'); const f = list.find((s) => s.id === req.params.id); if (!f) return res.status(404).json({ error: '方案不存在' }); res.json(f); });

app.post('/api/schemes', requireAdmin, async (req, res) => {
  const body = req.body || {}; const list = await store.load('schemes');
  const s = { ...body, id: body.id || store.uid('sch'), createTime: body.createTime || Date.now() };
  if (!s.company) s.company = '未知公司';
  if (isDuplicate(list, s)) return res.status(409).json({ error: '重复方案，已自动去重', duplicate: true });
  list.unshift(s); await store.save('schemes', list); res.status(201).json(s);
});

app.post('/api/schemes/batch', requireAdmin, async (req, res) => {
  const items = (req.body && req.body.items) || []; const list = await store.load('schemes');
  let added = 0, skipped = 0;
  for (const it of items) { const s = { ...it, id: it.id || store.uid('sch'), createTime: it.createTime || Date.now() }; if (!s.company) s.company = '未知公司'; if (isDuplicate(list, s)) { skipped++; continue; } list.unshift(s); added++; }
  await store.save('schemes', list); res.json({ added, skipped, total: list.length });
});

app.put('/api/schemes/:id', requireAdmin, async (req, res) => {
  const list = await store.load('schemes'); const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '方案不存在' });
  list[idx] = { ...list[idx], ...(req.body || {}), id: list[idx].id }; await store.save('schemes', list); res.json(list[idx]);
});

app.delete('/api/schemes/:id', requireAdmin, async (req, res) => {
  let list = await store.load('schemes'); const before = list.length; list = list.filter((s) => s.id !== req.params.id);
  if (list.length === before) return res.status(404).json({ error: '方案不存在' }); await store.save('schemes', list); res.json({ ok: true, deleted: before - list.length });
});

app.post('/api/schemes/:id/toggle-recommend', requireAdmin, async (req, res) => {
  const list = await store.load('schemes'); const s = list.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: '方案不存在' }); s.isRecommended = !s.isRecommended; await store.save('schemes', list); res.json({ ok: true, isRecommended: s.isRecommended });
});

app.get('/api/schemes/diffs', async (req, res) => { const { month } = req.query; const list = await store.load('schemes'); res.json({ month: month || '', schemes: list.filter((s) => (s.monthTag || '') === String(month || '')), total: list.length }); });

app.get('/api/schemes/export', async (req, res) => {
  const list = await store.load('schemes'); const fmt = (req.query.format || 'json').toLowerCase();
  if (fmt === 'csv') {
    const header = 'company,updateDate,monthTag,isRecommended,model,deposit,periods,monthlyRent,effectiveRent,giftDays,otherBenefits';
    const rows = [];
    for (const s of list) {
      for (const c of (s.carList || [])) {
        for (const p of (c.installmentPlans || [{}])) {
          rows.push([
            (s.company || '').replace(/,/g, '，'), s.updateDate || '', s.monthTag || '', s.isRecommended ? '是' : '否',
            (c.model || '').replace(/,/g, '，'), c.deposit != null ? c.deposit : '', p.periods != null ? p.periods : '',
            p.monthlyRent != null ? p.monthlyRent : '', p.effectiveRent != null ? p.effectiveRent : '',
            p.giftDays != null ? p.giftDays : '', (p.otherBenefits || '').replace(/,/g, '，')
          ].join(','));
        }
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.send('\uFEFF' + [header].concat(rows).join('\n'));
  } else res.json(list);
});

// ==================== 认证 ====================
function issueToken(user) { const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, { userId: user.id, phone: user.phone, role: user.role }); return token; }

app.post('/api/auth/login', async (req, res) => {
  const { account, password } = req.body || {};
  if (String(account) === ADMIN_ACCOUNT && String(password) === ADMIN_PASSWORD) {
    const user = { id: 'user-admin-root', phone: ADMIN_ACCOUNT, role: 'admin', name: '超级管理员' };
    return res.json({ token: issueToken(user), user });
  }
  return res.status(401).json({ error: '账号或密码错误' });
});

app.post('/api/auth/register', async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ error: '缺少手机号' });
  const users = await store.load('users');
  let u = users.find((x) => x.phone === String(phone));
  if (!u) { u = { id: store.uid('user'), phone: String(phone), role: 'viewer', name: name || '成员', createdAt: Date.now() }; users.push(u); await store.save('users', users); }
  res.json({ token: issueToken(u), user: u });
});

app.post('/api/auth/logout', (req, res) => { const h = req.headers.authorization || ''; sessions.delete(h.replace(/^Bearer\s+/i, '')); res.json({ ok: true }); });

app.get('/api/auth/users', requireAdmin, async (req, res) => res.json((await store.load('users')).map((u) => ({ id: u.id, phone: u.phone, role: u.role, name: u.name, createdAt: u.createdAt }))));
app.put('/api/auth/users/:id', requireAdmin, async (req, res) => { const users = await store.load('users'); const u = users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: '用户不存在' }); if (req.body.role) u.role = req.body.role; if (req.body.name != null) u.name = req.body.name; await store.save('users', users); res.json(u); });
app.delete('/api/auth/users/:id', requireAdmin, async (req, res) => {
  let users = await store.load('users'); const u = users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.role === 'admin' && users.filter((x) => x.role === 'admin').length <= 1) return res.status(400).json({ error: '不能删除最后一个管理员' });
  users = users.filter((x) => x.id !== req.params.id); await store.save('users', users); res.json({ ok: true });
});

// ==================== 留资 ====================
app.post('/api/leads', async (req, res) => {
  const b = req.body || {}; if (!b.phone) return res.status(400).json({ error: '手机号必填' });
  const leads = await store.load('leads');
  const lead = { id: store.uid('lead'), phone: String(b.phone), wechat: b.wechat || '', name: b.name || '', schemeId: b.schemeId || '', schemeName: b.schemeName || '', company: b.company || '', status: 'pending', note: '', createdAt: Date.now() };
  leads.unshift(lead); await store.save('leads', leads); res.status(201).json(lead);
});
app.get('/api/leads', requireAdmin, async (req, res) => {
  let leads = await store.load('leads'); const { status, keyword } = req.query;
  if (status) leads = leads.filter((l) => l.status === String(status));
  if (keyword) { const k = String(keyword).toLowerCase(); leads = leads.filter((l) => [l.phone, l.wechat, l.name, l.schemeName, l.company].some((v) => String(v || '').toLowerCase().includes(k))); }
  res.json(leads);
});
app.put('/api/leads/:id', requireAdmin, async (req, res) => { const leads = await store.load('leads'); const l = leads.find((x) => x.id === req.params.id); if (!l) return res.status(404).json({ error: '留资不存在' }); if (req.body.status) l.status = req.body.status; if (req.body.note != null) l.note = req.body.note; await store.save('leads', leads); res.json(l); });
app.delete('/api/leads/:id', requireAdmin, async (req, res) => { let leads = await store.load('leads'); const before = leads.length; leads = leads.filter((x) => x.id !== req.params.id); if (leads.length === before) return res.status(404).json({ error: '留资不存在' }); await store.save('leads', leads); res.json({ ok: true }); });
app.get('/api/leads/export', requireAdmin, async (req, res) => {
  const leads = await store.load('leads'); const fmt = (req.query.format || 'json').toLowerCase();
  if (fmt === 'csv') { const header = '手机号,微信号,称呼,关注方案,车源方,状态,备注,留资时间'; const rows = leads.map((l) => [l.phone, (l.wechat||'').replace(/,/g,'，'), (l.name||'').replace(/,/g,'，'), (l.schemeName||'').replace(/,/g,'，'), (l.company||'').replace(/,/g,'，'), l.status||'', (l.note||'').replace(/,/g,'，'), new Date(l.createdAt).toLocaleString('zh-CN')].join(',')); res.setHeader('Content-Type','text/csv; charset=utf-8'); res.send('\uFEFF'+[header].concat(rows).join('\n')); }
  else res.json(leads);
});

// ---------- 静态页面（客户页 / 管理后台） ----------
app.use(express.static(PUBLIC_DIR));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

seed().then(() => {
  app.listen(PORT, () => {
    console.log(`[网约车方案后端] 已启动: http://localhost:${PORT}/api/health`);
    console.log(`[存储] ${store.usePg() ? 'PostgreSQL 云端' : '本地 JSON'}`);
    console.log(`[管理员] ${ADMIN_ACCOUNT}`);
  });
}).catch((e) => { console.error('启动失败', e); process.exit(1); });
