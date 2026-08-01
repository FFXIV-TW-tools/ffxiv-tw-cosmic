/**
 * 入口：載資料 → 建分頁 → 每秒推時鐘。
 *
 * 全站零後端：三份 JSON 由 `tools/cosmic-dump` 從台服 client 產生後 commit 進 repo。
 */

import { setupTabs } from './tabs.js';
import { createForecaster } from './weather-forecast.js';
import { buildWindows } from './window-index.js';
import { createForecastView } from './forecast-view.js';
import { createNowPanel } from './now-panel.js';
import { createMissionView } from './mission-view.js';
import { createToolsView } from './tools-view.js';
import { createDevStageView } from './dev-stage-view.js';
import { createJobPicker } from './job-prefs.js';
import { createAlarm } from './alarm.js';

const TICK_MS = 1000;

// 「現在可接」只在條件邊界變動，而兩種條件的邊界都落在 350 秒（＝2 艾歐澤亞小時）的格線上
// ——天氣時段 1400 秒正好是它的 4 倍 ⇒ 用它當節流 key 同時涵蓋兩者，不會漏掉 ET 時段換檔。
const CONDITION_TICK = 350;

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const status = document.querySelector('#app-status');
  let weatherData;
  let missionData;
  let toolData;
  let devData;

  try {
    [weatherData, missionData, toolData, devData] = await Promise.all([
      loadJson('data/weather.json'),
      loadJson('data/missions.json'),
      loadJson('data/cosmic-tools.json'),
      loadJson('data/dev-stages.json'),
    ]);
  } catch (err) {
    // 空狀態要說「發生什麼事、下一步做什麼」，不是只寫「載入失敗」
    status.hidden = false;
    status.textContent = `資料載入失敗（${err.message}）— 請重新整理；若持續發生請回報。`;
    return;
  }
  status.hidden = true;

  const forecaster = createForecaster(weatherData);
  const { conditions, missions, jobs } = missionData;
  const windows = buildWindows(conditions, missions, forecaster);

  const tabs = setupTabs(document.querySelector('#cos-tabs'), () => {});

  const missionView = createMissionView(document.querySelector('#panel-missions'), {
    missions, conditions, jobs, forecaster,
  });

  /** 時間軸／建議面板 → 任務清單的跨分頁跳轉。 */
  function jumpToMissions(filter) {
    missionView.setFilter(filter);
    tabs.select('missions');
    document.querySelector('#panel-missions').scrollIntoView({ block: 'start' });
  }

  const forecastView = createForecastView({ forecaster, weatherData, missions, conditions });

  const nowPanel = createNowPanel(document.querySelector('#panel-forecast'), {
    windows, missions, conditions, jobs, forecaster, onJump: jumpToMissions,
  });

  createToolsView(document.querySelector('#panel-tools'), { chains: toolData.chains });
  createDevStageView(document.querySelector('#panel-dev'), { devData });

  const picker = createJobPicker(document.querySelector('#job-picker'), jobs, (ids) => {
    nowPanel.setJobs(ids);
  });
  nowPanel.setJobs(picker.get());

  // 鬧鐘吃「我練的職業」——沒選就是全部
  const alarm = createAlarm(document.querySelector('#panel-forecast'), {
    windows, jobs, getJobFilter: () => picker.get(),
  });

  document.querySelector('#meta-client').textContent = weatherData.meta.clientVersion;
  document.querySelector('#meta-generated').textContent = weatherData.meta.generatedAt.slice(0, 10);

  tabs.select('forecast');

  let lastBlock = -1;
  function tick() {
    const now = Math.floor(Date.now() / 1000);
    forecastView.render(now);
    nowPanel.render(now);
    alarm.check(now);
    const block = Math.floor(now / CONDITION_TICK);
    if (block !== lastBlock) {
      lastBlock = block;
      missionView.tick(now);
    }
  }
  tick();
  setInterval(tick, TICK_MS);

  // 說明卡（❓ 鐵則：hover 提示一律 [data-help]，禁 title）
  window.FFXIVHelp?.setup?.();
}

main();
