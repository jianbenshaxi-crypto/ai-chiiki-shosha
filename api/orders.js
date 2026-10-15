// GET  /api/orders           自分に関係する仕入れ依頼を返す（飲食店＝自分が送った依頼、農家＝自分あての行だけ）
// POST /api/orders {op,...}  依頼の送信・承認・辞退・条件変更・条件変更への返答・取り下げ・配送・受け取り
//
// 「仕入れ案」（allocate()の計算結果、ローカル保存のみ）とは別物。ここで作る依頼だけが
// 農家に実際に届き、承認されるとその数量だけ本当に在庫（listings）から引かれる。
// 決済・配送の実処理は行わない。「確定」は数量と条件の合意を意味するだけ。

import { setJSON } from '../lib/store.js';
import { ITEMS, UNITS, isISO, isTime } from '../lib/domain.js';
import { KEY as LISTINGS_KEY, load as loadListings } from '../lib/inventory.js';
import { KEY as ORDERS_KEY, load as loadOrders, findLine, viewFor } from '../lib/orders.js';
import { PASSCODE, currentUser, isAdmin } from '../lib/auth.js';

const OPS = new Set(['create', 'respond', 'counter-reply', 'withdraw', 'deliver', 'receive']);
const MAX_ORDERS = 500;
const round1 = v => Math.round(v * 10) / 10;
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

// 承認 / 条件変更の承諾の瞬間に、本当の在庫（listings）から確定数量を引く。
// 他の取引ですでに減っていて足りない場合はエラー文字列を返し、何も変更しない。
function confirmLine(lst, line, amt, unitPrice, date, from, to) {
  const l = lst.listings.find(x => x.id === line.listingId);
  if (!l) return '出品が見つかりません。すでに削除された可能性があります';
  if (!(l.qty >= amt)) return `${l.farm}の現在の販売可能量（${l.qty}${l.unit}）では確定できません。すでに他の取引で確保された可能性があります`;
  l.qty = round1(l.qty - amt);
  l.v++; l.updatedAt = Date.now();
  line.confirmedAmt = round1(amt);
  line.unitPrice = unitPrice; line.date = date; line.from = from; line.to = to;
  return null;
}

export default async function handler(req, res) {
  try {
    const user = await currentUser(req);
    const admin = !PASSCODE || isAdmin(req);

    if (req.method === 'GET') {
      if (!admin && !user) return send(res, 401, { error: 'ログインしてください' });
      const st = await loadOrders();
      return send(res, 200, { orders: viewFor(st, user, admin) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: '使えない操作です' });
    if (!admin && !user) return send(res, 401, { error: 'ログインしてください' });

    const body = typeof req.body === 'object' && req.body ? req.body : {};
    if (!OPS.has(body.op)) return send(res, 400, { error: '使えない操作です' });

    if (body.op === 'create') {
      // 依頼は実在の飲食店アカウントに紐づく必要があるため、ここだけはadmin（編集用パスコード）での代行を許さない
      if (!user || user.role !== 'shop') return send(res, 403, { error: '仕入れ依頼を送れるのは飲食店のアカウントだけです' });
      const r = body.req && typeof body.req === 'object' ? body.req : null;
      const picks = Array.isArray(body.picks) ? body.picks.slice(0, 20) : [];
      if (!r || !ITEMS.includes(r.item) || !UNITS.includes(r.unit) || !picks.length) {
        return send(res, 400, { error: '依頼の内容を確認してください' });
      }
      const lst = await loadListings();
      const lines = [];
      for (const p of picks) {
        const l = lst.listings.find(x => x.id === p.listingId);
        const amt = Number(p.amt);
        if (!l) return send(res, 404, { error: '出品が見つかりません。画面を読み込み直してください' });
        if (!l.owner) return send(res, 400, { error: `「${l.farm}」はデモの出品のため、依頼を送れません。実在の農家アカウントの出品で作り直してください` });
        if (!l.active || l.qty <= 0) return send(res, 409, { error: `${l.farm}の${l.item}は現在公開されていません。画面を読み込み直してください` });
        if (l.item !== r.item || l.unit !== r.unit) return send(res, 400, { error: '品目または単位が条件と一致しません' });
        if (!(amt > 0 && amt <= l.qty)) return send(res, 409, { error: `${l.farm}の販売可能量（${l.qty}${l.unit}）を超えています。画面を読み込み直してください` });
        lines.push({ listingId: l.id, farmId: l.owner, farmName: l.farm, item: l.item, variety: l.variety || '', unit: l.unit,
          requestedAmt: round1(amt), unitPrice: l.price, requestedCost: Math.round(amt * l.price),
          date: l.date, from: l.from, to: l.to, place: l.place,
          status: 'pending', counter: null, confirmedAmt: null, declineReason: null, updatedAt: Date.now() });
      }
      const ost = await loadOrders();
      if (ost.orders.length >= MAX_ORDERS) return send(res, 400, { error: `依頼は${MAX_ORDERS}件までです` });
      const id = 'o' + (++ost.seq);
      const order = {
        id, shopId: user.id, shopName: user.name,
        req: { item: r.item, qty: Number(r.qty) || 0, unit: r.unit, deadline: r.deadline || null, dateMode: r.dateMode || null, region: r.region || null, maxPrice: r.maxPrice ?? null, allowOff: Boolean(r.allowOff), place: r.place || null },
        createdAt: Date.now(), updatedAt: Date.now(),
        lines: lines.map((l, i) => ({ id: `${id}-${i + 1}`, ...l })),
      };
      ost.orders.unshift(order);
      await setJSON(ORDERS_KEY, ost);
      return send(res, 200, { orders: viewFor(ost, user, admin), id: order.id });
    }

    // ここから先はすべて既存の依頼に対する操作
    const ost = await loadOrders();
    const { order, line } = findLine(ost, body.orderId, body.lineId);
    if (!order || !line) return send(res, 404, { error: '依頼が見つかりません。画面を読み込み直してください' });

    if (body.op === 'respond') {
      if (!admin && line.farmId !== user.id) return send(res, 403, { error: '自分あての依頼だけ操作できます' });
      if (line.status !== 'pending') return send(res, 409, { error: 'すでに返答済みの依頼です。画面を読み込み直してください' });
      if (body.action === 'approve') {
        const lst = await loadListings();
        const err = confirmLine(lst, line, line.requestedAmt, line.unitPrice, line.date, line.from, line.to);
        if (err) return send(res, 409, { error: err });
        line.status = 'confirmed';
        await setJSON(LISTINGS_KEY, lst);
      } else if (body.action === 'decline') {
        line.status = 'declined'; line.declineReason = clip(body.reason, 200) || null;
      } else if (body.action === 'counter') {
        const c = body.counter && typeof body.counter === 'object' ? body.counter : {};
        const amt = Number(c.amt), unitPrice = Number(c.unitPrice);
        if (!(amt > 0 && amt <= 999)) return send(res, 400, { error: '数量を正しく入力してください' });
        if (!(Number.isInteger(unitPrice) && unitPrice >= 1 && unitPrice <= 100000)) return send(res, 400, { error: '単価は1〜100,000円の整数で入力してください' });
        const date = String(c.date || ''), from = String(c.from || ''), to = String(c.to || '');
        if (!isISO(date)) return send(res, 400, { error: '日付を正しく入力してください' });
        if (!isTime(from) || !isTime(to) || from >= to) return send(res, 400, { error: '受渡時間の「から」を「まで」より前にしてください' });
        line.counter = { amt: round1(amt), unitPrice, date, from, to, note: clip(c.note, 200), at: Date.now() };
        line.status = 'countered';
      } else return send(res, 400, { error: '使えない操作です' });
    } else if (body.op === 'counter-reply') {
      if (!admin && order.shopId !== user.id) return send(res, 403, { error: '自分の依頼だけ操作できます' });
      if (line.status !== 'countered') return send(res, 409, { error: 'この依頼には条件変更の提案がありません。画面を読み込み直してください' });
      if (body.action === 'accept') {
        const c = line.counter;
        const lst = await loadListings();
        const err = confirmLine(lst, line, c.amt, c.unitPrice, c.date, c.from, c.to);
        if (err) return send(res, 409, { error: err });
        line.status = 'confirmed';
        await setJSON(LISTINGS_KEY, lst);
      } else if (body.action === 'reject') {
        line.status = 'declined'; line.declineReason = '条件変更の提案が合意に至りませんでした';
      } else return send(res, 400, { error: '使えない操作です' });
    } else if (body.op === 'withdraw') {
      if (!admin && order.shopId !== user.id) return send(res, 403, { error: '自分の依頼だけ操作できます' });
      if (line.status !== 'pending') return send(res, 409, { error: '返答前の依頼だけ取り下げられます。画面を読み込み直してください' });
      line.status = 'withdrawn';
    } else if (body.op === 'deliver') {
      if (!admin && line.farmId !== user.id) return send(res, 403, { error: '自分あての依頼だけ操作できます' });
      if (line.status !== 'confirmed') return send(res, 409, { error: '確定した依頼だけ配送完了にできます。画面を読み込み直してください' });
      line.status = 'delivered';
    } else if (body.op === 'receive') {
      if (!admin && order.shopId !== user.id) return send(res, 403, { error: '自分の依頼だけ操作できます' });
      if (line.status !== 'delivered') return send(res, 409, { error: '配送完了後に受け取りを確認できます。画面を読み込み直してください' });
      line.status = 'received';
    }

    line.updatedAt = Date.now(); order.updatedAt = Date.now();
    await setJSON(ORDERS_KEY, ost);
    return send(res, 200, { orders: viewFor(ost, user, admin) });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'データを読み書きできませんでした。少し待ってからもう一度試してください' });
  }
}
