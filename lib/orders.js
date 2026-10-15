// 仕入れ依頼〜承認〜取引確定〜受け渡しの状態。/api/orders が使う。
// 「仕入れ案」（計算だけ・ローカル保存）とは別物。ここに入るのは実際に送信された依頼だけ。

import { getJSON, setJSON } from './store.js';

export const KEY = 'orders:v1';

export async function load() {
  const st = await getJSON(KEY);
  if (st && Array.isArray(st.orders)) return st;
  const fresh = { seq: 0, orders: [] };
  await setJSON(KEY, fresh);
  return fresh;
}

export const save = st => setJSON(KEY, st);

export function findLine(st, orderId, lineId) {
  const order = st.orders.find(o => o.id === orderId);
  if (!order) return { order: null, line: null };
  const line = order.lines.find(l => l.id === lineId);
  return { order, line: line || null };
}

// ログイン中のユーザーから見える範囲だけを返す（農家には自分あての行だけ）
export function viewFor(st, user, admin) {
  if (admin) return st.orders;
  if (!user) return [];
  if (user.role === 'shop') return st.orders.filter(o => o.shopId === user.id);
  return st.orders
    .filter(o => o.lines.some(l => l.farmId === user.id))
    .map(o => ({ ...o, lines: o.lines.filter(l => l.farmId === user.id) }));
}
