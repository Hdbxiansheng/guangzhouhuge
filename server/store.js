// 存储层：优先使用 PostgreSQL（设 DATABASE_URL 时），否则回退到本地 JSON 文件。
// 部署到托管平台（Render/Supabase）时，把 DATABASE_URL 指到云数据库即可跨设备持久化。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const { Pool } = require('pg');
let pool = null;

function usePg() { return !!process.env.DATABASE_URL; }

function ensurePool() {
  if (pool) return;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
  });
  pool.on('error', () => {});
}

async function ensureTables() {
  if (!usePg()) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return;
  }
  ensurePool();
  for (const n of ['schemes', 'users', 'leads']) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${n} (id text primary key, doc jsonb)`);
  }
}

async function load(name) {
  if (usePg()) {
    ensurePool();
    const { rows } = await pool.query(`SELECT doc FROM ${name}`);
    return (rows || []).map((r) => r.doc);
  }
  const f = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(f)) return [];
  try {
    const a = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

async function save(name, arr) {
  if (usePg()) {
    ensurePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${name}`);
      for (const x of arr) {
        if (!x || !x.id) continue;
        await client.query(
          `INSERT INTO ${name}(id, doc) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET doc=$2`,
          [x.id, JSON.stringify(x)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
    return;
  }
  const f = path.join(DATA_DIR, name + '.json');
  fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

module.exports = { DATA_DIR, load, save, uid, ensureTables, usePg };
