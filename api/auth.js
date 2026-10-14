// GET  /api/auth            ログイン中のユーザーを返す（Authorization: Bearer <token>）
// POST /api/auth {op,...}   signup / login / logout / update
// 新規登録には共通の編集用パスコードが必要。名前・パスワードの変更には今のパスワードが必要。

import { allow, setJSON } from '../lib/store.js';
import { KEY as LISTINGS_KEY, load as loadListings } from '../lib/inventory.js';
import {
  ROLES, PASSCODE, hashPassword, verifyPassword, loadUsers, saveUsers,
  createSession, endSession, currentUser, publicUser,
} from '../lib/auth.js';

const OPS = new Set(['signup', 'login', 'logout', 'update']);
const LOGIN_ID = /^[a-z0-9_-]{3,20}$/;
const s = v => (typeof v === 'string' ? v.trim() : '');

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

const passwordError = pw => (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) ? 'パスワードは8〜72文字で入力してください' : null;

// 名前の検証。農家名は出品に表示されるので、デモの農家名やほかの農家と同じ名前は使えない
async function nameError(name, role, users, selfId) {
  if (!name || name.length > 30) return `${role === 'farm' ? '農家名' : '店名'}を30文字以内で入力してください`;
  if (role !== 'farm') return null;
  if (Object.values(users.users).some(u => u.id !== selfId && u.role === 'farm' && u.name === name)) return `「${name}」はほかの農家が使っています`;
  const st = await loadListings();
  if (st.listings.some(l => l.demo && l.farm === name)) return `「${name}」はデモ用の架空の農家名です。あなたの農家名で登録してください`;
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const u = await currentUser(req);
      return send(res, 200, { user: publicUser(u), signupNeedsPasscode: Boolean(PASSCODE) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: '使えない操作です' });

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (!OPS.has(body.op)) return send(res, 400, { error: '使えない操作です' });
    const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

    switch (body.op) {
      case 'signup': {
        if (!(await allow(`rl:signup:${ip}`, 10, 3600))) return send(res, 429, { error: '登録の回数が多すぎます。しばらく待ってからもう一度試してください' });
        if (PASSCODE && body.passcode !== PASSCODE) return send(res, 401, { error: '編集用パスコードが違います' });
        const loginId = s(body.loginId).toLowerCase();
        const role = s(body.role);
        const name = s(body.name);
        if (!LOGIN_ID.test(loginId)) return send(res, 400, { error: 'ユーザー名は半角の英小文字・数字・-・_ の3〜20文字で入力してください' });
        if (!ROLES[role]) return send(res, 400, { error: '農家か飲食店かを選んでください' });
        const pwErr = passwordError(body.password);
        if (pwErr) return send(res, 400, { error: pwErr });
        const users = await loadUsers();
        if (users.users[loginId]) return send(res, 409, { error: 'このユーザー名はすでに使われています' });
        const nErr = await nameError(name, role, users);
        if (nErr) return send(res, 409, { error: nErr });
        const u = { id: loginId, role, name, hash: hashPassword(body.password), sessVer: 1, at: Date.now() };
        users.users[loginId] = u;
        await saveUsers(users);
        return send(res, 200, { token: await createSession(u), user: publicUser(u) });
      }
      case 'login': {
        if (!(await allow(`rl:login:${ip}`, 10, 600))) return send(res, 429, { error: 'ログインの試行が多すぎます。10分ほど待ってからもう一度試してください' });
        const users = await loadUsers();
        const u = users.users[s(body.loginId).toLowerCase()];
        if (!u || !verifyPassword(body.password, u.hash)) return send(res, 401, { error: 'ユーザー名かパスワードが違います' });
        return send(res, 200, { token: await createSession(u), user: publicUser(u) });
      }
      case 'logout': {
        await endSession(req);
        return send(res, 200, { user: null });
      }
      case 'update': {
        const users = await loadUsers();
        const u = await currentUser(req, users);
        if (!u) return send(res, 401, { error: 'ログインしてください' });
        if (!(await allow(`rl:update:${u.id}`, 10, 600))) return send(res, 429, { error: '操作が多すぎます。しばらく待ってからもう一度試してください' });
        if (!verifyPassword(body.currentPassword, u.hash)) return send(res, 401, { error: '今のパスワードが違います' });
        const out = {};
        if (body.name != null) {
          const name = s(body.name);
          const nErr = await nameError(name, u.role, users, u.id);
          if (nErr) return send(res, 409, { error: nErr });
          // 農家名を変えたら、自分の出品に表示される農家名もそろえる
          if (u.role === 'farm' && name !== u.name) {
            const st = await loadListings();
            let changed = false;
            for (const l of st.listings) if (l.owner === u.id) { l.farm = name; l.v++; l.updatedAt = Date.now(); changed = true; }
            if (changed) await setJSON(LISTINGS_KEY, st);
          }
          u.name = name;
        }
        if (body.newPassword != null) {
          const pwErr = passwordError(body.newPassword);
          if (pwErr) return send(res, 400, { error: pwErr });
          u.hash = hashPassword(body.newPassword);
          u.sessVer++; // ほかの端末のログインは無効にする
          await endSession(req);
        }
        await saveUsers(users);
        if (body.newPassword != null) out.token = await createSession(u);
        return send(res, 200, { ...out, user: publicUser(u) });
      }
      default:
        return send(res, 400, { error: '使えない操作です' });
    }
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'データを読み書きできませんでした。少し待ってからもう一度試してください' });
  }
}
