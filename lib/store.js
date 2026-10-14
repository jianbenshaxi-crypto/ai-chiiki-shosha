// 在庫データの保存先。Upstash Redis（Vercel Marketplace 経由で接続）を REST API で使う。
// 環境変数が無いときはメモリに置く（ローカル確認用。サーバーが再起動すると消え、端末間で共有されない）。

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const hasRedis = Boolean(URL_ && TOKEN);

const mem = new Map();
const memExp = new Map(); // メモリ保存時の有効期限（ミリ秒）
const memAlive = key => { const t = memExp.get(key); if (t && t < Date.now()) { mem.delete(key); memExp.delete(key); } return mem.has(key); };

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`redis ${data.error}`);
  return data.result;
}

export async function getJSON(key) {
  if (!hasRedis) return memAlive(key) ? structuredClone(mem.get(key)) : null;
  const v = await redis(['GET', key]);
  return v == null ? null : JSON.parse(v);
}

// ttlSec を渡すと、その秒数で自動的に消える（ログイン状態の保存に使う）
export async function setJSON(key, value, ttlSec) {
  if (!hasRedis) {
    mem.set(key, structuredClone(value));
    if (ttlSec) memExp.set(key, Date.now() + ttlSec * 1000); else memExp.delete(key);
    return;
  }
  await redis(ttlSec ? ['SET', key, JSON.stringify(value), 'EX', String(ttlSec)] : ['SET', key, JSON.stringify(value)]);
}

export async function delKey(key) {
  if (!hasRedis) { mem.delete(key); memExp.delete(key); return; }
  await redis(['DEL', key]);
}

// 固定ウィンドウのレート制限。true なら許可。
export async function allow(key, limit, windowSec) {
  if (!hasRedis) {
    const now = Date.now();
    const e = mem.get(key);
    if (!e || e.reset < now) { mem.set(key, { n: 1, reset: now + windowSec * 1000 }); return true; }
    e.n++;
    return e.n <= limit;
  }
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, String(windowSec)]);
  return n <= limit;
}
