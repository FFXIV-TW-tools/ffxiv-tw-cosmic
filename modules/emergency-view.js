/**
 * 緊急事件分頁——現況、通報、附議／否認。
 *
 * **這一頁的資訊主張跟全站其他頁不同，必須講清楚**：其他頁的東西是算出來的（天氣、ET 時段），
 * 對就是對；這一頁的東西是**別人回報的**，沒人回報就是空的，而空的**不代表沒有事件**。
 * 任何會讓人誤以為「這裡沒亮＝安全」的措辭都是 bug。
 *
 * 倒數用本地時鐘算，只有每 60 秒才真的打一次後端——事件長 20 分鐘，不需要更即時，
 * 而每秒打 API 會把免費額度燒在沒有資訊增益的地方。
 */

import { formatDuration, clockText } from './eorzea-time.js';
import { emergencyApi } from './emergency-api.js';

/** 後端輪詢間隔（秒）。 */
const POLL_SECONDS = 60;

const LEAD_OPTIONS = [
  [0, '已經開始'],
  [1, '1 分鐘後'],
  [3, '3 分鐘後'],
  [5, '5 分鐘後'],
  [10, '10 分鐘後'],
];

/**
 * @param {HTMLElement} root #panel-emergency
 * @param {{worlds: string[], onState?: (state:object)=>void}} opts
 */
export function createEmergencyView(root, { worlds, onState }) {
  const el = {
    list: root.querySelector('#em-list'),
    status: root.querySelector('#em-status'),
    world: root.querySelector('#em-world'),
    lead: root.querySelector('#em-lead'),
    submit: root.querySelector('#em-submit'),
    msg: root.querySelector('#em-msg'),
  };

  /** 最近一次成功取得的現況；後端掛掉時保留上一份並標明時間，不清空。 */
  let state = null;
  let fetchedAt = 0;
  let lastPoll = 0;
  let offline = false;

  for (const w of worlds) el.world.append(new Option(w, w));
  for (const [v, label] of LEAD_OPTIONS) el.lead.append(new Option(label, String(v)));

  el.submit.addEventListener('click', submit);

  async function submit() {
    el.submit.disabled = true;
    const world = el.world.value;
    const lead = Number(el.lead.value);
    const r = await emergencyApi.report(world, lead);
    if (r.ok) {
      say(
        r.duplicate
          ? `${world} 已經有進行中的事件了 — 你這筆算成附議。`
          : `已通報 ${world}，訂閱這台的人會收到通知。感謝。`,
        'ok',
      );
      await poll(true);
    } else {
      say(r.message, 'warn');
    }
    el.submit.disabled = false;
  }

  function say(text, tone) {
    el.msg.textContent = text;
    el.msg.dataset.tone = tone;
  }

  async function vote(eventId, kind) {
    const r = await emergencyApi.vote(eventId, kind);
    say(
      r.ok
        ? kind === 'confirm' ? '已附議。' : '已記錄否認 — 三個人否認且無人附議就會下架。'
        : r.message,
      r.ok ? 'ok' : 'warn',
    );
    await poll(true);
  }

  async function poll(force = false) {
    const r = await emergencyApi.getState();
    if (!r.ok) {
      offline = true;
      renderStatus();
      return;
    }
    offline = false;
    state = r.data;
    fetchedAt = Math.floor(Date.now() / 1000);
    onState?.(state);
    if (force) render(fetchedAt);
  }

  function renderStatus() {
    if (offline) {
      el.status.textContent = fetchedAt
        ? `⚠️ 連不上通報伺服器，畫面停在 ${clockText(fetchedAt)} 的資料。`
        : '⚠️ 連不上通報伺服器 — 本站其他分頁不受影響。';
      return;
    }
    el.status.textContent = fetchedAt ? `更新於 ${clockText(fetchedAt)}` : '載入中…';
  }

  /** 一台伺服器一列。沒有事件的也要列出來——「查過了，沒有」跟「不知道」是兩回事。 */
  function row(world, ev, now) {
    const li = document.createElement('li');
    li.className = 'cos-em__row';

    const name = document.createElement('span');
    name.className = 'cos-em__world';
    name.textContent = world;
    li.append(name);

    if (!ev) {
      const none = document.createElement('span');
      none.className = 'codex-small cos-em__none';
      none.textContent = '目前沒有人回報';
      li.append(none);
      return li;
    }

    const badge = document.createElement('span');
    badge.className = `codex-badge ${ev.source === 'plugin' ? 'codex-badge--ok' : 'codex-badge--warn'}`;
    badge.textContent = ev.source === 'plugin' ? '插件偵測' : '玩家通報';
    li.append(badge);

    const when = document.createElement('strong');
    when.className = 'cos-em__when';
    when.textContent = ev.startAt > now
      ? `${formatDuration(ev.startAt - now)}後開始`
      : `進行中 · 剩 ${formatDuration(ev.endAt - now)}`;
    li.append(when);

    const votes = document.createElement('span');
    votes.className = 'codex-small cos-em__votes';
    votes.textContent = `附議 ${ev.confirms}　否認 ${ev.disputes}`;
    li.append(votes);

    const actions = document.createElement('span');
    actions.className = 'cos-em__actions';
    actions.append(
      voteBtn('我也看到了', 'confirm', ev.id),
      voteBtn('查無此事', 'dispute', ev.id),
    );
    li.append(actions);
    return li;
  }

  function voteBtn(label, kind, eventId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'codex-btn codex-btn--ghost codex-small';
    b.textContent = label;
    b.addEventListener('click', () => vote(eventId, kind));
    return b;
  }

  function render(now) {
    if (now - lastPoll >= POLL_SECONDS) {
      lastPoll = now;
      poll();
    }
    renderStatus();
    if (!state) return;

    el.list.replaceChildren(
      ...worlds.map((w) => {
        const ev = state.events[w];
        // 後端算過期是用它自己的時鐘；這邊再用本地時鐘過濾一次，避免時鐘偏差讓已結束的事件多留幾秒
        return row(w, ev && ev.endAt > now ? ev : null, now);
      }),
    );
  }

  return { render };
}
