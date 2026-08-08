/**
 * 天氣與艾奧傑亞時間的數值測試（2026-08-08 健檢 tests-ci/T2 ＋ correctness-core/A2）。
 *
 * 整站的核心承諾是「時間資訊要對」（看錯就白等），而在這之前 `eorzea-time.js` 與
 * `weather-forecast.js` **一條數值斷言都沒有**——雜湊改一個位元、單位差一個係數，
 * 畫面照樣在倒數，只是倒到錯的時間。沒有任何東西會紅。
 *
 * 這裡釘的是**不變量與已知定值**，不是實作細節：
 * 週期長度、ET 尺度、種子值域、機率表與長期分布的一致性、連續同天氣段的邊界。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(`file:///${join(ROOT, 'modules', 'eorzea-time.js').replace(/\\/g, '/')}`);
const W = await import(`file:///${join(ROOT, 'modules', 'weather-forecast.js').replace(/\\/g, '/')}`);
const weatherData = JSON.parse(readFileSync(join(ROOT, 'data', 'weather.json'), 'utf8'));
const f = W.createForecaster(weatherData);

const WINDY = weatherData.table.find((w) => w.name === '靈風').id;

test('時間常數：週期 1400 秒＝8 ET 小時；ET 一天 4200 現實秒', () => {
  assert.equal(T.WEATHER_PERIOD, 1400);
  assert.equal(T.EORZEA_DAY, 4200);
  // 1 ET 小時 = 175 現實秒 ⇒ ET 比現實快 3600/175 ≈ 20.57 倍（四格註記寫的「1 小時＝現實 2 分 55 秒」）
  assert.equal(T.EORZEA_DAY / 24, 175);
});

test('eorzeaClock / eorzeaHour：邊界與繞回', () => {
  // unix 0 ＝ ET 00:00
  assert.deepEqual(T.eorzeaClock(0), { hour: 0, minute: 0 });
  assert.equal(T.eorzeaHour(0), 0);
  // 走一個完整 ET 日回到 00:00
  assert.deepEqual(T.eorzeaClock(T.EORZEA_DAY), { hour: 0, minute: 0 });
  // 半個 ET 日 ＝ ET 12:00
  assert.equal(T.eorzeaClock(T.EORZEA_DAY / 2).hour, 12);
  // eorzeaHour 恆在 [0,24)
  for (const t of [1, 12345, 1785984157, T.EORZEA_DAY - 1]) {
    const h = T.eorzeaHour(t);
    assert.ok(h >= 0 && h < 24, `eorzeaHour(${t}) = ${h} 超出 [0,24)`);
  }
});

test('inEorzeaWindow：半開區間 [start, end)', () => {
  const at = (h) => Math.floor(h * 175);         // 該 ET 日內第 h 小時
  assert.equal(T.inEorzeaWindow(at(10), 10, 12), true, '起點含在內');
  assert.equal(T.inEorzeaWindow(at(12), 10, 12), false, '終點不含（否則兩個相鄰視窗會重疊）');
  assert.equal(T.inEorzeaWindow(at(11.99), 10, 12), true);
  assert.equal(T.inEorzeaWindow(at(9.99), 10, 12), false);
});

test('forecastTarget：值域 0–99 且不得為負（32 位元有號數的老坑）', () => {
  for (let i = 0; i < 5000; i++) {
    const seed = T.forecastTarget(1785000000 + i * 137);
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 100, `seed 超出值域：${seed}`);
  }
});

test('天氣長期分布與 client 的機率表一致（±1.5%）', () => {
  const N = 30000;
  const seen = new Map();
  for (let i = 0; i < N; i++) {
    const w = f.weatherAt(1785000000 + i * T.WEATHER_PERIOD);
    seen.set(w.name, (seen.get(w.name) ?? 0) + 1);
  }
  for (const row of weatherData.table) {
    const pct = ((seen.get(row.name) ?? 0) / N) * 100;
    assert.ok(Math.abs(pct - row.rate) < 1.5,
      `${row.name} 實際 ${pct.toFixed(1)}% vs 表定 ${row.rate}%——機率表與演算法對不上`);
  }
});

test('同一時段內任何時刻的天氣相同（天氣以時段為單位，不是逐秒）', () => {
  const base = T.periodStart(1785984157);
  const w0 = f.weatherAt(base).id;
  for (const off of [1, 700, T.WEATHER_PERIOD - 1]) {
    assert.equal(f.weatherAt(base + off).id, w0);
  }
  assert.notEqual(base + T.WEATHER_PERIOD, base);   // 邊界確實換段（值可能同天氣，時刻必不同）
});

test('currentRunEnd：連續同天氣要一路算到底，不是只到本時段邊界', () => {
  // 找一個「這段是靈風、下一段也是靈風」的時刻——實測約 12.8% 的靈風時段屬此
  let t = null;
  for (let i = 0; i < 20000; i++) {
    const at = 1785000000 + i * T.WEATHER_PERIOD;
    if (f.weatherAt(at).id === WINDY && f.weatherAt(at + T.WEATHER_PERIOD).id === WINDY) { t = at; break; }
  }
  assert.ok(t !== null, '掃描範圍內找不到連續兩段靈風——樣本或演算法有異');

  const end = f.currentRunEnd(t, WINDY);
  assert.ok(end > t + T.WEATHER_PERIOD,
    '連續段的結束時刻不得停在本時段邊界（那正是 2026-08-08 修掉的 bug：提早 23 分 20 秒）');
  assert.equal(f.weatherAt(end).id === WINDY, false, '結束時刻那一段必須已經不是靈風');
  assert.equal(f.weatherAt(end - 1).id, WINDY, '結束時刻前一秒必須還是靈風');
  assert.equal((end - T.periodStart(t)) % T.WEATHER_PERIOD, 0, '結束時刻必須落在時段邊界上');

  // 對照組：單段靈風時，結束時刻就是本時段邊界
  let single = null;
  for (let i = 0; i < 20000; i++) {
    const at = 1785000000 + i * T.WEATHER_PERIOD;
    if (f.weatherAt(at).id === WINDY && f.weatherAt(at + T.WEATHER_PERIOD).id !== WINDY) { single = at; break; }
  }
  assert.equal(f.currentRunEnd(single, WINDY), single + T.WEATHER_PERIOD);
});

test('nextWeather：回的時段確實是該天氣，且不早於起點', () => {
  const from = 1785984157;
  const n = f.nextWeather(from, WINDY);
  assert.ok(n, '400 段內找不到靈風＝機率表壞了');
  assert.equal(f.weatherAt(n.start).id, WINDY);
  assert.ok(n.start >= T.periodStart(from));
});
