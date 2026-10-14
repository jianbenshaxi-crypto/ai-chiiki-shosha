// GET  /api/listings          出品・在庫を返す
// POST /api/listings {op,...}  出品・在庫の登録・更新（編集用パスコードが必要）
// AIはこのAPIを呼ばない。データを書き換えられるのは画面の操作だけ。

import { setJSON, hasRedis } from '../lib/store.js';
import { seedListings, validateListing } from '../lib/domain.js';
import { KEY, load } from '../lib/inventory.js';
import { aiReady } from '../lib/ai.js';

const MAX_LISTINGS = 300;
const PASSCODE = process.env.EDIT_PASSCODE || '';
const OPS = new Set(['add', 'edit', 'qty', 'toggle', 'delete', 'reset']);

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
const payload = st => ({ listings: st.listings });
// デモ用の架空の農家名を、利用者の登録に使わせない（実データとデモデータが混ざらないように）
const demoFarmName = (st, name) => st.listings.some(l => l.demo && l.farm === name);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const st = await load();
      return send(res, 200, { ...payload(st), editLocked: Boolean(PASSCODE), shared: hasRedis, aiReady: aiReady() });
    }
    if (req.method !== 'POST') return send(res, 405, { error: '使えない操作です' });

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (!OPS.has(body.op)) return send(res, 400, { error: '使えない操作です' });
    if (PASSCODE && req.headers['x-edit-passcode'] !== PASSCODE) return send(res, 401, { error: '編集用パスコードが違います' });

    const st = await load();
    const find = id => st.listings.find(l => l.id === id);

    switch (body.op) {
      case 'add': {
        if (st.listings.length >= MAX_LISTINGS) return send(res, 400, { error: `出品は${MAX_LISTINGS}件までです` });
        const { errors, listing } = validateListing(body.listing || {});
        if (errors.length) return send(res, 400, { error: errors[0], errors });
        if (demoFarmName(st, listing.farm)) return send(res, 409, { error: `「${listing.farm}」はデモ用の架空の農家名です。あなたの農家名で登録してください` });
        const dup = st.listings.find(x => x.active && x.farm === listing.farm && x.item === listing.item && x.variety === listing.variety && x.date === listing.date && x.place === listing.place && x.unit === listing.unit);
        if (dup) return send(res, 409, { error: `同じ日・同じ場所の「${listing.item}」がすでに出品されています。数量を変えるときは、出品カードの「数量を変更」を使ってください`, id: dup.id });
        const l = { ...listing, id: 'l' + (++st.seq), active: true, v: 1, demo: false, at: Date.now(), updatedAt: Date.now() };
        st.listings.push(l);
        await setJSON(KEY, st);
        return send(res, 200, { ...payload(st), id: l.id });
      }
      case 'edit': {
        const l = find(body.id);
        if (!l) return send(res, 404, { error: '出品が見つかりません。画面を読み込み直してください' });
        const { errors, listing } = validateListing(body.listing || {});
        if (errors.length) return send(res, 400, { error: errors[0], errors });
        // デモの出品はデモの農家名のまま編集できる。利用者の出品をデモの農家名に変えることはできない
        if (!l.demo && demoFarmName(st, listing.farm)) return send(res, 409, { error: `「${listing.farm}」はデモ用の架空の農家名です。あなたの農家名で登録してください` });
        const dup = st.listings.find(x => x.id !== l.id && x.active && x.farm === listing.farm && x.item === listing.item && x.variety === listing.variety && x.date === listing.date && x.place === listing.place && x.unit === listing.unit);
        if (dup) return send(res, 409, { error: `同じ日・同じ場所の「${listing.item}」がほかに出品されています。日付か受け渡し場所を変えてください`, id: dup.id });
        Object.assign(l, listing, { v: l.v + 1, editedAt: Date.now(), updatedAt: Date.now() });
        await setJSON(KEY, st);
        return send(res, 200, { ...payload(st), id: l.id });
      }
      case 'qty': {
        const l = find(body.id);
        const q = Number(body.qty);
        if (!l) return send(res, 404, { error: '出品が見つかりません。画面を読み込み直してください' });
        if (!(q >= 0 && q <= 999)) return send(res, 400, { error: '販売可能量は0〜999で入力してください' });
        l.qty = Math.round(q * 10) / 10;
        l.v++; l.updatedAt = Date.now();
        await setJSON(KEY, st);
        return send(res, 200, payload(st));
      }
      case 'toggle': {
        const l = find(body.id);
        if (!l) return send(res, 404, { error: '出品が見つかりません。画面を読み込み直してください' });
        l.active = !l.active;
        l.v++; l.updatedAt = Date.now();
        await setJSON(KEY, st);
        return send(res, 200, payload(st));
      }
      case 'delete': {
        const i = st.listings.findIndex(l => l.id === body.id);
        if (i < 0) return send(res, 404, { error: '出品が見つかりません。すでに削除されています' });
        st.listings.splice(i, 1);
        await setJSON(KEY, st);
        return send(res, 200, payload(st));
      }
      case 'reset': {
        // デモデータだけを初期状態に戻す。利用者が登録した出品は残す
        const fresh = seedListings();
        const keepL = st.listings.filter(l => !l.demo);
        const next = { ...fresh, seq: Math.max(st.seq || 0, fresh.seq), listings: [...fresh.listings, ...keepL] };
        await setJSON(KEY, next);
        return send(res, 200, { ...payload(next), kept: { listings: keepL.length } });
      }
      default:
        return send(res, 400, { error: '使えない操作です' });
    }
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'データを読み書きできませんでした。少し待ってからもう一度試してください' });
  }
}
