/**
 * 限時視窗鬧鐘——在條件開啟前 N 分鐘通知你。
 *
 * 三個管道同時發：桌面通知（需授權）＋ 音效＋ 頁內 toast。音效走 portal 共用的
 * `FFXIVSettings.playAlarm()`（17 個 FFXIV SE 已中央化），**不自己塞 mp3**。
 *
 * ⚠️ **這是「分頁開著才會響」的鬧鐘**。全站零後端、沒有推播伺服器，所以關掉分頁就不會通知——
 * 這點必須在 UI 上講明白，不能讓人以為關了還會響。
 *
 * 通知文案沿用看板的措辭鐵則：講的是**條件開啟**，不是任務一定出現；含緊急任務時另外註明
 * 還要等伺服器事件。
 */

const KEY = 'ffxiv-tw-cosmic:alarm';
const DEFAULTS = { enabled: false, leadMinutes: 3 };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      enabled: p?.enabled === true,
      leadMinutes: [0, 1, 3, 5, 10].includes(p?.leadMinutes) ? p.leadMinutes : DEFAULTS.leadMinutes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 私密模式／配額滿：設定記不住，但本次 session 仍可運作
  }
}

export function createAlarm(root, { windows, jobs, getJobFilter }) {
  const el = {
    toggle: root.querySelector('#al-enabled'),
    lead: root.querySelector('#al-lead'),
    status: root.querySelector('#al-status'),
  };

  const state = load();
  // 去重鍵＝職業 + 條件 + 該次視窗的起始時刻 ⇒ 同一個視窗只響一次，跨視窗會再響
  const fired = new Set();

  el.toggle.checked = state.enabled;
  el.lead.value = String(state.leadMinutes);

  el.toggle.addEventListener('change', async () => {
    if (el.toggle.checked) {
      const granted = await requestPermission();
      // 桌面通知被拒不等於功能不能用：音效與頁內 toast 照常，只是少一個管道
      if (granted !== 'granted') {
        window.FFXIVToast?.show?.('桌面通知未授權 — 仍會用音效與畫面提示', 'warn');
      }
    }
    state.enabled = el.toggle.checked;
    save(state);
    renderStatus();
  });

  el.lead.addEventListener('change', () => {
    state.leadMinutes = Number(el.lead.value);
    save(state);
    fired.clear();      // 改了提前量，先前「已通知」的判定不再適用
    renderStatus();
  });

  async function requestPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }

  function renderStatus() {
    if (!state.enabled) {
      el.status.textContent = '關閉中';
      return;
    }
    const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const channel = perm === 'granted' ? '桌面通知＋音效' : '音效＋畫面提示（桌面通知未授權）';
    el.status.textContent = `開啟中 · 提前 ${state.leadMinutes} 分鐘 · ${channel} · 分頁需保持開啟`;
  }

  /** 每次 tick 檢查一輪。@param {number} now unix 秒 */
  function check(now) {
    if (!state.enabled) return;
    const leadSeconds = state.leadMinutes * 60;
    const wanted = getJobFilter();
    const filter = wanted.length ? new Set(wanted) : null;

    for (const w of windows) {
      if (w.isOpen(now) !== false) continue;        // 已開或條件未定：不是「即將開啟」
      const at = w.next(now);
      if (!at) continue;
      const eta = at.start - now;
      if (eta > leadSeconds) continue;

      const targets = filter ? w.jobs.filter((j) => filter.has(j)) : w.jobs;
      if (targets.length === 0) continue;

      const key = `${w.condId}:${at.start}:${targets.join(',')}`;
      if (fired.has(key)) continue;
      fired.add(key);
      fire(w, targets, eta);
    }

    // 去重集合只需保留「還沒過去的」視窗；不清會無限長大（長時開 tab 的工具必守）
    if (fired.size > 200) fired.clear();
  }

  function fire(w, targets, eta) {
    // 沒選職業時 targets 是全部 11 職，整串列出來的通知沒人讀得完 ⇒ 超過 3 個就報數量
    const names = targets.length > 3
      ? `${targets.length} 個職業`
      : targets.map((j) => jobs[j]?.label ?? `#${j}`).join('、');
    const mins = Math.max(0, Math.round(eta / 60));

    // 只統計 targets 自己的任務，且緊急分開算（兩者的不確定性等級不同）
    const mine = w.missions.filter((m) => m.jobs.some((j) => targets.includes(j)));
    const crit = mine.filter((m) => m.critical).length;
    const plain = mine.length - crit;

    const title = mins > 0 ? `${mins} 分鐘後：${names}` : `現在：${names}`;
    const lines = [
      `${w.label} 條件即將開啟`,
      plain > 0 ? `可做 ${plain} 個任務` : '',
      crit > 0 ? `⚡ 另有緊急 ${crit} 個 — 條件外還需伺服器觸發事件` : '',
    ].filter(Boolean);
    const body = lines.join('\n');

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        // tag 讓同一個視窗的通知互相取代，不疊一整排
        new Notification(title, { body, tag: `cosmic-${w.condId}`, icon: 'favicon-192.png' });
      } catch {
        // 部分瀏覽器在非 SW 環境限制建構通知：音效與 toast 仍會發，不需處理
      }
    }

    window.FFXIVSettings?.playAlarm?.({ force: true });
    window.FFXIVToast?.show?.(`${title} — ${lines[0]}`, 'ok', 8000);
  }

  renderStatus();
  return { check };
}
