// ユーザー（農家・飲食店）とログイン状態。/api/auth と /api/listings が共有する。
// パスワードは scrypt でハッシュ化して保存し、元の文字列は保存しない。
// ログイン状態はランダムなトークンで表し、サーバーにはそのハッシュだけを有効期限つきで置く。

import crypto from 'node:crypto';
import { getJSON, setJSON, delKey } from './store.js';

export const USERS_KEY = 'users:v1';
export const ROLES = { farm: '農家', shop: '飲食店' };
// 共通の編集用パスコード。管理者の操作と、新規登録のときに使う（未設定ならローカル確認用に誰でも書き込める）
export const PASSCODE = process.env.EDIT_PASSCODE || '';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30日

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

export async function loadUsers() {
  const st = await getJSON(USERS_KEY);
  return st && st.users ? st : { users: {} };
}
export const saveUsers = st => setJSON(USERS_KEY, st);

const tokenOf = req => {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
};
const sessKey = t => 'sess:v1:' + crypto.createHash('sha256').update(t).digest('hex');

export async function createSession(u) {
  const t = crypto.randomBytes(32).toString('base64url');
  await setJSON(sessKey(t), { uid: u.id, ver: u.sessVer }, SESSION_TTL);
  return t;
}

export async function endSession(req) {
  const t = tokenOf(req);
  if (t) await delKey(sessKey(t));
}

// ログイン中のユーザー。パスワードを変えると sessVer が上がり、それまでのログインは無効になる
export async function currentUser(req, users) {
  const t = tokenOf(req);
  if (!t) return null;
  const s = await getJSON(sessKey(t));
  if (!s) return null;
  const st = users || await loadUsers();
  const u = st.users[s.uid];
  return u && u.sessVer === s.ver ? u : null;
}

export const publicUser = u => (u ? { id: u.id, role: u.role, name: u.name } : null);
export const isAdmin = req => Boolean(PASSCODE) && req.headers['x-edit-passcode'] === PASSCODE;
