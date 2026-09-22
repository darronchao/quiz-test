import { nextBox, isMastered, scoreExam, progressStats, wrongQuestionIds, toMarkdown, reviewPriority, guessLevel, nextExam, MASTER_BOX } from './core.js';

const STORE_KEY = 'quiz-test_progress';
const SYNC_URL = 'https://quiz-test-sync.darronchao.workers.dev';
const VAPID_PUBLIC = 'BB9u8wFjV8VQXm6hEQy-sLKc0PuQl3dPTJ68EPVoI_qmq_47hmO9swD0l03Cakcw0Rzeo0-fjhZY4E2WikV16uk';
const $ = (sel) => document.querySelector(sel);
const view = $('#view');

let DATA = { meta: {}, questions: [] };
let CONCEPTS = [];
let EXAMINFO = null;
let store = load();
let pushTimer = null;
let dirty = false; // 有未上傳的本機變動才寫 KV(localStorage 才是本機真相,KV 只跨裝置)

// PWA 安裝：接管 beforeinstallprompt，顯示自家「安裝」按鈕（Android/桌面 Chrome）
// 用單機旗標記住「已關掉/已安裝」就別再顯示（install 狀態每台不同，故不進同步 store）
let deferredInstall = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const installBarOff = () => localStorage.getItem('quiz-test_installbar_off') === '1';
const dismissInstallBar = () => { localStorage.setItem('quiz-test_installbar_off', '1'); const b = document.getElementById('installbar'); if (b) b.hidden = true; deferredInstall = null; };
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const bar = document.getElementById('installbar');
  if (bar && !isStandalone() && !installBarOff()) bar.hidden = false;
});
window.addEventListener('appinstalled', dismissInstallBar);

// ---- localStorage ----
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.q) return s;
  } catch {}
  return { v: 1, syncCode: makeCode(), codeFresh: true, q: {}, recent: [], updatedAt: 0 };
}
// 記一筆最近作答結果(1/0)，保留最近 50 筆，供「近期正確率」
function logRecent(correct) {
  (store.recent ||= []).push(correct ? 1 : 0);
  if (store.recent.length > 50) store.recent = store.recent.slice(-50);
}

// ---- 推播提醒(Web Push)----
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function pushIsOn() {
  if (!pushSupported() || !SYNC_URL) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}
async function enablePush(localHour) {
  if (Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: '未允許通知權限' };
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC) });
  const offsetMin = new Date().getTimezoneOffset();
  let utcMin = (localHour * 60 + offsetMin) % 1440; if (utcMin < 0) utcMin += 1440;
  const r = await fetch(`${SYNC_URL}/push/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: store.syncCode, subscription: sub.toJSON(), hourUtc: Math.floor(utcMin / 60), offsetMin }),
  });
  return { ok: r.ok };
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await fetch(`${SYNC_URL}/push/unsubscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: store.syncCode }),
  }).catch(() => {});
}

// ---- 每日目標 / 連續打卡 / 考前倒數 ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };
const dailyGoal = () => (store.settings && store.settings.dailyGoal) || 20;
const todayCount = () => (store.daily && store.daily.date === today() ? store.daily.count : 0);
// 顯示用的連續天數：最後達標日是今天或昨天才還活著，否則歸 0
function liveStreak() {
  const s = store.streak; if (!s || !s.lastDate) return 0;
  return (s.lastDate === today() || s.lastDate === yesterday()) ? s.count : 0;
}
// 倒數要對準哪一場。自己在設定裡填過的一律優先;沒填就自動判:
// 看他練過的題是初級還是中級(id 裡的 -b-/-m-),挑那一級還沒到的最近一場。
// 為什麼要自動:實測 2,137 個使用者只有 131 個(6%)走進設定頁設過日期,
// 而考前那兩天湧進 267 個人,設日期的只多了 5 個。功能一直都在,只是沒人找得到。
function examTarget() {
  const set = store.settings && store.settings.examDate;
  if (set) return { date: set, level: null };
  if (!EXAMINFO) return null;
  return nextExam(EXAMINFO.exams, today(), guessLevel(store.q || {}));
}
function daysUntilExam() {
  const t = examTarget(); if (!t) return null;
  return Math.ceil((new Date(t.date + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
}
// 每答一題呼叫：累加今日題數、記每日歷史、達標當下更新打卡
function bumpDaily(correct) {
  const t = today();
  store.settings ||= { dailyGoal: 20, examDate: '' };
  if (!store.daily || store.daily.date !== t) store.daily = { date: t, count: 0 };
  store.daily.count++;
  // 每日歷史（答題數/答對數），保留最近 30 天
  store.history ||= {};
  const h = (store.history[t] ||= { a: 0, c: 0 });
  h.a++; if (correct) h.c++;
  const days = Object.keys(store.history).sort();
  if (days.length > 30) delete store.history[days[0]];
  store.streak ||= { count: 0, lastDate: '' };
  if (store.daily.count === dailyGoal() && store.streak.lastDate !== t) {
    store.streak = { count: (store.streak.lastDate === yesterday() ? store.streak.count : 0) + 1, lastDate: t };
  }
}
function save() {
  store.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  dirty = true;
  schedulePush();
}

// ---- 雲端同步（同步碼，免帳號） ----
// 寫入策略:checkpoint(交卷/練習完成/切走關頁)立即 flush;持續作答只在停頓 30s 後補寫一次。
// dirty gating = 沒變動就絕不寫,省 KV 寫入額度。
function schedulePush() {
  if (!SYNC_URL) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushSync, 30000); // ponytail: debounce 30s 只當長 session 的保底;真正的寫在 checkpoint
}
async function pushSync(opts = {}) {
  clearTimeout(pushTimer); pushTimer = null;
  if (!SYNC_URL || !store.syncCode) return false;
  if (!dirty) return true; // 沒有未上傳的變動就不寫 KV
  try {
    const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(store),
      keepalive: opts.keepalive || false, // 關頁/切走時讓請求活過頁面卸載
    });
    if (r.ok) dirty = false;
    return r.ok;
  } catch { return false; }
}
async function pullSync() {
  if (!SYNC_URL || !store.syncCode) return false;
  try {
    const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`);
    if (!r.ok) return false;
    const remote = await r.json();
    if (remote && remote.q && (remote.updatedAt || 0) > (store.updatedAt || 0)) {
      store = remote;
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      return true;
    }
  } catch {}
  return false;
}
function qp(id) {
  return (store.q[id] ||= { box: 1, attempts: 0, correct: 0, wrong: 0, note: '', starred: false });
}
// 碼空間 40×40×9000 = 1,440 萬(舊版 10×10×90=9,000,估計已撞出上百對共用碼)
function makeCode() {
  const a = ['fox', 'owl', 'koi', 'elm', 'jade', 'mint', 'sage', 'wren', 'lark', 'reef',
    'ash', 'birch', 'cedar', 'crane', 'deer', 'dove', 'fern', 'finch', 'gull', 'hare',
    'hawk', 'ibis', 'iris', 'kelp', 'kiwi', 'lily', 'lotus', 'lynx', 'mole', 'moss',
    'moth', 'newt', 'orca', 'pine', 'plum', 'quail', 'seal', 'swan', 'teal', 'wolf'];
  const b = ['river', 'cloud', 'stone', 'ember', 'tide', 'grove', 'dune', 'frost', 'maple', 'comet',
    'breeze', 'brook', 'canyon', 'cave', 'cliff', 'coast', 'coral', 'creek', 'delta', 'fjord',
    'gale', 'glade', 'gorge', 'harbor', 'inlet', 'lagoon', 'ledge', 'marsh', 'mesa', 'mist',
    'oasis', 'peak', 'pond', 'rain', 'ridge', 'shore', 'sky', 'snow', 'storm', 'vale'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)}-${pick(b)}-${Math.floor(1000 + Math.random() * 9000)}`;
}
// 自動產生的新碼先跟雲端查重再定案(雙保險):只碰 codeFresh 的全新 store,
// 手動輸入的碼與既有使用者一律不動。離線或伺服器出錯就放行,不擋使用者。
async function ensureFreshCode() {
  if (!store.codeFresh) return;
  if (SYNC_URL && !store.updatedAt && !Object.keys(store.q || {}).length) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${SYNC_URL}/sync/${encodeURIComponent(store.syncCode)}`);
        if (!r.ok) break; // 404 = 沒人用,定案;5xx 也放行
        store.syncCode = makeCode(); // 被占用 → 重抽再查
      } catch { break; }
    }
  }
  delete store.codeFresh;
  localStorage.setItem(STORE_KEY, JSON.stringify(store)); // 只落地碼,不動 updatedAt
}

// ---- helpers ----
const subjects = () => [...new Set(DATA.questions.map((q) => q.subject))];
const papers = () => [...new Set(DATA.questions.map((q) => `${q.level}｜${q.round}｜${q.subject}`))];
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// 注音字典：涵蓋題目敘述常用字、詞性及國小基礎字
const ZHUYIN_DICT = {"一":"ㄧ","七":"ㄑㄧ","丈":"ㄓㄤˋ","三":"ㄙㄢ","上":"ㄕㄤˋ","下":"ㄒㄧㄚˋ","不":"ㄅㄨˋ","中":"ㄓㄨㄥ","之":"ㄓ","九":"ㄐㄧㄡˇ","也":"ㄧㄝˇ","乳":"ㄖㄨˇ","乾":"ㄍㄢ","了":"˙ㄌㄜ","事":"ㄕˋ","二":"ㄦˋ","五":"ㄨˇ","些":"ㄒㄧㄝ","享":"ㄒㄧㄤˇ","亮":"ㄌㄧㄤˋ","人":"ㄖㄣˊ","什":"ㄕˊ","今":"ㄐㄧㄣ","介":"ㄐㄧㄝˋ","仍":"ㄖㄥˊ","他":"ㄊㄚ","代":"ㄉㄞˋ","令":"ㄌㄧㄥˊ","以":"ㄧˇ","件":"ㄐㄧㄢˋ","伯":"ㄅㄛˊ","但":"ㄉㄢˋ","住":"ㄓㄨˋ","何":"ㄏㄜˊ","作":"ㄗㄨㄛˋ","你":"ㄋㄧˇ","來":"ㄌㄞˊ","例":"ㄌㄧˋ","信":"ㄒㄧㄣˋ","個":"ㄍㄜˋ","們":"˙ㄇㄣ","候":"ㄏㄡˋ","假":"ㄐㄧㄚˇ","做":"ㄗㄨㄛˋ","停":"ㄊㄧㄥˊ","健":"ㄐㄧㄢˋ","偶":"ㄡˇ","傍":"ㄅㄤˋ","傘":"ㄙㄢˇ","備":"ㄅㄟˋ","傷":"ㄕㄤ","僅":"ㄐㄧㄣˇ","價":"ㄐㄧㄚˋ","元":"ㄩㄢˊ","兄":"ㄒㄩㄥ","先":"ㄒㄧㄢ","克":"ㄎㄜˋ","免":"ㄇㄧㄢˇ","兒":"ㄦˊ","兔":"ㄊㄨˋ","全":"ㄑㄩㄢˊ","兩":"ㄌㄧㄤˇ","八":"ㄅㄚ","公":"ㄍㄨㄥ","六":"ㄌㄧㄡˋ","其":"ㄑㄧˊ","具":"ㄐㄩˋ","再":"ㄗㄞˋ","冒":"ㄇㄠˋ","冠":"ㄍㄨㄢ","冬":"ㄉㄨㄥ","冰":"ㄅㄧㄥ","冷":"ㄌㄥˇ","出":"ㄔㄨ","刀":"ㄉㄠ","初":"ㄔㄨ","到":"ㄉㄠˋ","刷":"ㄕㄨㄚ","刻":"ㄎㄜˋ","前":"ㄑㄧㄢˊ","副":"ㄈㄨˋ","力":"ㄌㄧˋ","助":"ㄓㄨˋ","動":"ㄉㄨㄥˋ","務":"ㄨˋ","包":"ㄅㄠ","匙":"ㄔˊ","十":"ㄕˊ","午":"ㄨˇ","南":"ㄋㄢˊ","博":"ㄅㄛˊ","卡":"ㄑㄧㄚˇ","原":"ㄩㄢˊ","去":"ㄑㄩˋ","又":"ㄧㄡˋ","叉":"ㄔㄚ","友":"ㄧㄡˇ","叔":"ㄕㄨ","取":"ㄑㄩˇ","受":"ㄕㄡˋ","口":"ㄎㄡˇ","可":"ㄎㄜˇ","右":"ㄧㄡˋ","司":"ㄙ","吃":"ㄔ","名":"ㄇㄧㄥˊ","向":"ㄒㄧㄤˋ","告":"ㄍㄠˋ","味":"ㄨㄟˋ","和":"ㄏㄜˊ","咖":"ㄎㄚ","咬":"ㄧㄠˇ","品":"ㄆㄧㄣˇ","哈":"ㄏㄚ","員":"ㄩㄢˊ","哥":"ㄍㄜ","哪":"ㄋㄚˇ","哭":"ㄎㄨ","唯":"ㄨㄟˊ","唱":"ㄔㄤˋ","商":"ㄕㄤ","問":"ㄨㄣˋ","啡":"ㄈㄟ","喚":"ㄏㄨㄢˋ","喜":"ㄒㄧˇ","喝":"ㄏㄜ","單":"ㄉㄢ","嗨":"ㄏㄞ","嘆":"ㄊㄢˋ","嘗":"ㄔㄤˊ","嘴":"ㄗㄨㄟˇ","器":"ㄑㄧˋ","嚐":"ㄔㄤˊ","囉":"囉","四":"ㄙˋ","回":"ㄏㄨㄟˊ","因":"ㄧㄣ","困":"ㄎㄨㄣˋ","國":"ㄍㄨㄛˊ","園":"ㄩㄢˊ","圖":"ㄊㄨˊ","在":"ㄗㄞˋ","地":"ㄉㄧˋ","圾":"ㄐㄧ","坐":"ㄗㄨㄛˋ","垃":"ㄌㄚ","型":"ㄒㄧㄥˊ","堂":"ㄊㄤˊ","堡":"ㄅㄠˇ","場":"ㄔㄤˊ","壁":"ㄅㄧˋ","壞":"ㄏㄨㄞˋ","士":"ㄕˋ","壯":"ㄓㄨㄤˋ","夏":"ㄒㄧㄚˋ","外":"ㄨㄞˋ","多":"ㄉㄨㄛ","夢":"ㄇㄥˋ","大":"ㄉㄚˋ","天":"ㄊㄧㄢ","太":"ㄊㄞˋ","夫":"ㄈㄨ","夾":"ㄐㄧㄚ","套":"ㄊㄠˋ","奮":"ㄈㄣˋ","女":"n锟斤拷","奶":"ㄋㄞˇ","她":"ㄊㄚ","好":"ㄏㄠˇ","如":"ㄖㄨˊ","妹":"ㄇㄟˋ","姊":"ㄗˇ","始":"ㄕˇ","姐":"ㄐㄧㄝˇ","姑":"ㄍㄨ","姨":"ㄧˊ","婆":"ㄆㄛˊ","媽":"ㄇㄚ","嬰":"ㄧㄥ","子":"˙ㄗ","字":"ㄗˋ","季":"ㄐㄧˋ","孩":"ㄏㄞˊ","學":"ㄒㄩㄝˊ","它":"ㄊㄚ","安":"ㄢ","定":"ㄉㄧㄥˋ","宜":"ㄧˊ","客":"ㄎㄜˋ","室":"ㄕˋ","家":"ㄐㄧㄚ","容":"ㄖㄨㄥˊ","寒":"ㄏㄢˊ","察":"ㄔㄚˊ","寫":"ㄒㄧㄝˇ","寵":"ㄔㄨㄥˇ","將":"ㄐㄧㄤ","對":"ㄉㄨㄟˋ","小":"ㄒㄧㄠˇ","尺":"ㄔˇ","尾":"ㄨㄟˇ","局":"ㄐㄩˊ","展":"ㄓㄢˇ","山":"ㄕㄢ","工":"ㄍㄨㄥ","左":"ㄗㄨㄛˇ","巧":"ㄑㄧㄠˇ","差":"ㄔㄚˋ","巴":"ㄅㄚ","巾":"ㄐㄧㄣ","市":"ㄕˋ","希":"ㄒㄧ","師":"ㄕ","帶":"ㄉㄞˋ","常":"ㄔㄤˊ","帽":"ㄇㄠˋ","幫":"ㄅㄤ","年":"ㄋㄧㄢˊ","床":"ㄔㄨㄤˊ","店":"ㄉㄧㄢˋ","庭":"ㄊㄧㄥˊ","康":"ㄎㄤ","廁":"ㄘㄜˋ","廚":"ㄔㄨˊ","廳":"ㄊㄧㄥ","式":"ㄕˋ","弟":"ㄉㄧˋ","張":"ㄓㄤ","強":"ㄑㄧㄤˊ","彎":"ㄨㄢ","形":"ㄒㄧㄥˊ","彩":"ㄘㄞˇ","影":"ㄧㄥˇ","待":"ㄉㄞˋ","很":"ㄏㄣˇ","後":"ㄏㄡˋ","得":"˙ㄉㄜ","從":"ㄘㄨㄥˊ","復":"ㄈㄨˋ","心":"ㄒㄧㄣ","忙":"ㄇㄤˊ","快":"ㄎㄨㄞˋ","念":"ㄋㄧㄢˋ","思":"ㄙ˙","急":"ㄐㄧˊ","恤":"ㄒㄩˋ","惰":"ㄉㄨㄛˋ","想":"ㄒㄧㄤˇ","愉":"ㄩˊ","意":"ㄧˋ","愛":"ㄞˋ","感":"ㄍㄢˇ","慢":"ㄇㄢˋ","憤":"ㄈㄣˋ","懶":"ㄌㄢˇ","成":"ㄔㄥˊ","我":"ㄨㄛˇ","戲":"ㄒㄧˋ","戴":"ㄉㄞˋ","戶":"ㄏㄨˋ","房":"ㄈㄤˊ","所":"ㄙㄨㄛˇ","扇":"ㄕㄢˋ","手":"ㄕㄡˇ","打":"ㄉㄚˇ","托":"ㄊㄨㄛ","找":"ㄓㄠˇ","把":"ㄅㄚˇ","披":"ㄆㄧ","抱":"ㄅㄠˋ","拉":"ㄌㄚ","拍":"ㄆㄞ","拖":"ㄊㄨㄛ","拼":"ㄆㄧㄣ","拿":"ㄋㄚˊ","捷":"ㄐㄧㄝˊ","掃":"ㄙㄠˇ","掉":"ㄉㄧㄠˋ","接":"ㄐㄧㄝ","描":"ㄇㄧㄠˊ","摩":"ㄇㄛˊ","撞":"ㄓㄨㄤˋ","撿":"ㄐㄧㄢˇ","擔":"ㄉㄢ","擦":"ㄘㄚ","攀":"ㄆㄢ","攜":"ㄒㄧㄝˊ","收":"ㄕㄡ","放":"ㄈㄤˋ","故":"ㄍㄨˋ","教":"ㄐㄧㄠˋ","數":"ㄕㄨˋ","文":"ㄨㄣˊ","斑":"ㄅㄢ","料":"ㄌㄧㄠˋ","新":"ㄒㄧㄣ","方":"ㄈㄤ","於":"ㄩˊ","旁":"ㄆㄤˊ","旅":"l锟斤拷","日":"ㄖˋ","早":"ㄗㄠˇ","明":"ㄇㄧㄥˊ","星":"ㄒㄧㄥ","春":"ㄔㄨㄣ","昨":"ㄗㄨㄛˊ","是":"ㄕˋ","時":"ㄕˊ","晚":"ㄨㄢˇ","晴":"ㄑㄧㄥˊ","暖":"ㄋㄨㄢˇ","曲":"ㄑㄩ","更":"ㄍㄥ","書":"ㄕㄨ","曾":"ㄗㄥ","最":"ㄗㄨㄟˋ","會":"ㄏㄨㄟˋ","月":"ㄩㄝˋ","有":"ㄧㄡˇ","朋":"ㄆㄥˊ","服":"ㄈㄨˊ","朗":"ㄌㄤˇ","望":"ㄨㄤˋ","朝":"ㄓㄠ","期":"ㄑㄧ","本":"ㄅㄣˇ","朵":"ㄉㄨㄛˇ","杯":"ㄅㄟ","東":"ㄉㄨㄥ","板":"ㄅㄢˇ","果":"ㄍㄨㄛˇ","架":"ㄐㄧㄚˋ","某":"ㄇㄡˇ","校":"ㄒㄧㄠˋ","桃":"ㄊㄠˊ","桌":"ㄓㄨㄛ","條":"ㄊㄧㄠˊ","棒":"ㄅㄤˋ","椅":"ㄧˇ","業":"ㄧㄝˋ","樂":"ㄌㄜˋ","樣":"ㄧㄤˋ","樹":"ㄕㄨˋ","橘":"ㄐㄩˊ","機":"ㄐㄧ","橡":"ㄒㄧㄤˋ","檬":"ㄇㄥˊ","檸":"ㄋㄧㄥˊ","次":"ㄘˋ","歉":"ㄑㄧㄢˋ","歌":"ㄍㄜ","歡":"ㄏㄨㄢ","正":"ㄓㄥˋ","步":"ㄅㄨˋ","母":"ㄇㄨˇ","每":"ㄇㄟˇ","比":"ㄅㄧˇ","毛":"ㄇㄠˊ","氣":"ㄑㄧˋ","水":"ㄕㄨㄟˇ","永":"ㄩㄥˇ","汁":"ㄓ","沒":"ㄇㄟˊ","沙":"ㄕㄚ","河":"ㄏㄜˊ","油":"ㄧㄡˊ","治":"ㄓˋ","泣":"ㄑㄧˋ","泳":"ㄩㄥˇ","洋":"ㄧㄤˊ","洗":"ㄒㄧˇ","活":"ㄏㄨㄛˊ","派":"ㄆㄞˋ","流":"ㄌㄧㄡˊ","浴":"ㄩˋ","海":"ㄏㄞˇ","消":"ㄒㄧㄠ","涼":"ㄌㄧㄤˊ","淇":"ㄑㄧˊ","淋":"ㄌㄧㄣˊ","淨":"ㄐㄧㄥˋ","清":"ㄑㄧㄥ","渴":"ㄎㄜˇ","游":"ㄧㄡˊ","湖":"ㄏㄨˊ","湯":"ㄊㄤ","準":"ㄓㄨㄣˇ","溜":"ㄌㄧㄡ","溫":"ㄨㄣ","漂":"ㄆㄧㄠ","漆":"ㄑㄧ","演":"ㄧㄢˇ","漢":"ㄏㄢˋ","潮":"ㄔㄠˊ","濕":"ㄕ","灘":"ㄊㄢ","灣":"ㄨㄢ","火":"ㄏㄨㄛˇ","灰":"ㄏㄨㄟ","為":"ㄨㄟˊ","烏":"ㄨ","無":"ㄨˊ","然":"ㄖㄢˊ","照":"ㄓㄠˋ","熊":"ㄒㄩㄥˊ","熱":"ㄖㄜˋ","燈":"ㄉㄥ","燙":"ㄊㄤˋ","爬":"ㄆㄚˊ","父":"ㄈㄨˋ","爸":"ㄅㄚˋ","爺":"ㄧㄝˊ","爽":"ㄕㄨㄤˇ","牆":"ㄑㄧㄤˊ","片":"ㄆㄧㄢˋ","牙":"ㄧㄚˊ","牛":"ㄋㄧㄡˊ","牠":"牠","物":"ㄨˋ","特":"ㄊㄜˋ","狗":"ㄍㄡˇ","猴":"ㄏㄡˊ","獅":"ㄕ","玩":"ㄨㄢˊ","玻":"ㄅㄛ","班":"ㄅㄢ","現":"ㄒㄧㄢˋ","球":"ㄑㄧㄡˊ","理":"ㄌㄧˇ","琴":"ㄑㄧㄣˊ","璃":"ㄌㄧˊ","瓜":"ㄍㄨㄚ","瓶":"ㄆㄧㄥˊ","甜":"ㄊㄧㄢˊ","生":"ㄕㄥ","用":"ㄩㄥˋ","男":"ㄋㄢˊ","畫":"ㄏㄨㄚˋ","當":"ㄉㄤ","疲":"ㄆㄧˊ","病":"ㄅㄧㄥˋ","痛":"ㄊㄨㄥˋ","瘦":"ㄕㄡˋ","發":"ㄈㄚ","白":"ㄅㄞˊ","百":"ㄅㄞˇ","的":"˙ㄉㄜ","皮":"ㄆㄧˊ","盤":"ㄆㄢˊ","看":"ㄎㄢˋ","真":"ㄓㄣ","眼":"ㄧㄢˇ","睛":"ㄐㄧㄥ","睡":"ㄕㄨㄟˋ","知":"ㄓ","短":"ㄉㄨㄢˇ","矮":"ㄞˇ","碌":"ㄌㄨˋ","碟":"ㄉㄧㄝˊ","碰":"ㄆㄥˋ","確":"ㄑㄩㄝˋ","示":"ㄕˋ","票":"ㄆㄧㄠˋ","禮":"ㄌㄧˇ","秋":"ㄑㄧㄡ","科":"ㄎㄜ","程":"ㄔㄥˊ","空":"ㄎㄨㄥ","穿":"ㄔㄨㄢ","窗":"ㄔㄨㄤ","立":"ㄌㄧˋ","站":"ㄓㄢˋ","端":"ㄉㄨㄢ","笑":"ㄒㄧㄠˋ","第":"ㄉㄧˋ","筆":"ㄅㄧˇ","等":"ㄉㄥˇ","答":"ㄉㄚˊ","筷":"ㄎㄨㄞˋ","箏":"ㄓㄥ","箱":"ㄒㄧㄤ","節":"ㄐㄧㄝˊ","簡":"ㄐㄧㄢˇ","籃":"ㄌㄢˊ","米":"ㄇㄧˇ","粉":"ㄈㄣˇ","精":"ㄐㄧㄥ","糕":"ㄍㄠ","糖":"ㄊㄤˊ","系":"ㄒㄧˋ","紀":"ㄐㄧˋ","約":"ㄩㄝ","紅":"ㄏㄨㄥˊ","紙":"ㄓˇ","級":"ㄐㄧˊ","紫":"ㄗˇ","累":"ㄌㄟˊ","給":"ㄍㄟˇ","綠":"ㄌㄩ","綿":"ㄇㄧㄢˊ","總":"ㄗㄨㄥˇ","罐":"ㄍㄨㄢˋ","羊":"ㄧㄤˊ","美":"ㄇㄟˇ","習":"ㄒㄧˊ","老":"ㄌㄠˇ","考":"ㄎㄠˇ","者":"ㄓㄜˇ","耳":"ㄦˇ","聊":"ㄌㄧㄠˊ","聖":"ㄕㄥˋ","聞":"ㄨㄣˊ","聰":"ㄘㄨㄥ","職":"ㄓˊ","聽":"ㄊㄧㄥ","肉":"ㄖㄡˋ","育":"ㄩˋ","背":"ㄅㄟˋ","腦":"ㄋㄠˇ","腳":"ㄐㄧㄠˇ","腿":"ㄊㄨㄟˇ","膠":"ㄐㄧㄠ","臂":"ㄅㄧˋ","臉":"ㄌㄧㄢˇ","臥":"ㄨㄛˋ","臺":"ㄊㄞˊ","舅":"ㄐㄧㄡˋ","興":"ㄒㄧㄥ","舞":"ㄨˇ","船":"ㄔㄨㄢˊ","色":"ㄙㄜˋ","花":"ㄏㄨㄚ","英":"ㄧㄥ","茶":"ㄔㄚˊ","草":"ㄘㄠˇ","莓":"ㄇㄟˊ","萄":"ㄊㄠˊ","萬":"ㄨㄢˋ","落":"ㄌㄨㄛˋ","著":"ㄓㄨˋ","葡":"ㄆㄨˊ","蕉":"ㄐㄧㄠ","薩":"ㄙㄚˋ","薯":"ㄕㄨˇ","藍":"ㄌㄢˊ","藝":"ㄧˋ","蘋":"ㄆㄧㄥˊ","虎":"ㄏㄨˇ","處":"ㄔㄨˋ","虹":"ㄏㄨㄥˊ","蛇":"ㄕㄜˊ","蛋":"ㄉㄢˋ","蛙":"ㄨㄚ","蛛":"ㄓㄨ","蜂":"ㄈㄥ","蜘":"ㄓ","蜜":"ㄇㄧˋ","蝴":"ㄏㄨˊ","蝶":"ㄉㄧㄝˊ","行":"ㄒㄧㄥˊ","術":"ㄕㄨˋ","街":"ㄐㄧㄝ","衣":"ㄧ","表":"ㄅㄧㄠˇ","衫":"ㄕㄢ","袋":"ㄉㄞˋ","裙":"ㄑㄩㄣˊ","裝":"ㄓㄨㄤ","裡":"ㄌㄧˇ","製":"ㄓˋ","複":"ㄈㄨˋ","褲":"ㄎㄨˋ","襪":"ㄨㄚˋ","襯":"ㄔㄣˋ","西":"ㄒㄧ","要":"ㄧㄠˋ","見":"ㄐㄧㄢˋ","視":"ㄕˋ","親":"ㄑㄧㄣ","覺":"ㄐㄩㄝˊ","解":"ㄐㄧㄝˇ","觸":"ㄔㄨˋ","計":"ㄐㄧˋ","許":"ㄒㄩˇ","訴":"ㄙㄨˋ","註":"ㄓㄨˋ","詞":"ㄘˊ","試":"ㄕˋ","話":"ㄏㄨㄚˋ","認":"ㄖㄣˋ","誕":"ㄉㄢˋ","語":"ㄩˇ","說":"ㄕㄨㄛ","誰":"ㄕㄨㄟˊ","課":"ㄎㄜˋ","談":"ㄊㄢˊ","請":"ㄑㄧㄥˇ","謝":"ㄒㄧㄝˋ","識":"ㄕˊ","警":"ㄐㄧㄥˇ","護":"ㄏㄨˋ","讀":"ㄉㄨˊ","讓":"ㄖㄤˋ","象":"ㄒㄧㄤˋ","豬":"ㄓㄨ","貓":"ㄇㄠ","貨":"ㄏㄨㄛˋ","買":"ㄇㄞˇ","費":"ㄈㄟˋ","賣":"ㄇㄞˋ","賽":"ㄙㄞˋ","贏":"ㄧㄥˊ","走":"ㄗㄡˇ","起":"ㄑㄧˇ","超":"ㄔㄠ","趕":"ㄍㄢˇ","趣":"ㄑㄩˋ","足":"ㄗㄨˊ","跑":"ㄆㄠˇ","路":"ㄌㄨˋ","跳":"ㄊㄧㄠˋ","踏":"ㄊㄚˋ","車":"ㄔㄜ","軍":"ㄐㄩㄣ","較":"ㄐㄧㄠˋ","輕":"ㄑㄧㄥ","轉":"ㄓㄨㄢˇ","辦":"ㄅㄢˋ","農":"ㄋㄨㄥˊ","迎":"ㄧㄥˊ","近":"ㄐㄧㄣˋ","這":"ㄓㄜˋ","通":"ㄊㄨㄥ","速":"ㄙㄨˋ","造":"ㄗㄠˋ","連":"ㄌㄧㄢˊ","遇":"ㄩˋ","遊":"ㄧㄡˊ","運":"ㄩㄣˋ","過":"ㄍㄨㄛˋ","道":"ㄉㄠˋ","遠":"ㄩㄢˇ","邊":"ㄅㄧㄢ","那":"ㄋㄚˋ","部":"ㄅㄨˋ","郵":"ㄧㄡˊ","都":"ㄉㄨ","醒":"ㄒㄧㄥˇ","醫":"ㄧ","重":"ㄓㄨㄥˋ","釣":"ㄉㄧㄠˋ","鉛":"ㄑㄧㄢ","銀":"ㄧㄣˊ","鋼":"ㄍㄤ","錢":"ㄑㄧㄢˊ","錯":"ㄘㄨㄛˋ","錶":"ㄅㄧㄠˇ","鏡":"ㄐㄧㄥˋ","鐘":"ㄓㄨㄥ","鑰":"ㄩㄝˋ","長":"ㄔㄤˊ","門":"ㄇㄣˊ","開":"ㄎㄞ","間":"ㄐㄧㄢ","閱":"ㄩㄝˋ","關":"ㄍㄨㄢ","防":"ㄈㄤˊ","阿":"ㄚ","限":"ㄒㄧㄢˋ","院":"ㄩㄢˋ","陽":"ㄧㄤˊ","雙":"ㄕㄨㄤ","雞":"ㄐㄧ","離":"ㄌㄧˊ","難":"ㄋㄢˊ","雨":"ㄩˇ","雪":"ㄒㄩㄝˇ","雲":"ㄩㄣˊ","零":"ㄌㄧㄥˊ","電":"ㄉㄧㄢˋ","需":"ㄒㄩ","青":"ㄑㄧㄥ","靜":"ㄐㄧㄥˋ","非":"ㄈㄟ","靠":"ㄎㄠˋ","面":"ㄇㄧㄢˋ","鞋":"ㄒㄧㄝˊ","音":"ㄧㄣ","頭":"ㄊㄡˊ","題":"ㄊㄧˊ","顏":"ㄧㄢˊ","風":"ㄈㄥ","颱":"ㄊㄞˊ","飛":"ㄈㄟ","食":"ㄕˊ","飯":"ㄈㄢˋ","飽":"ㄅㄠˇ","餃":"ㄐㄧㄠˇ","餅":"ㄅㄧㄥˇ","餐":"ㄘㄢ","餓":"ㄜˋ","館":"ㄍㄨㄢˇ","香":"ㄒㄧㄤ","馬":"ㄇㄚˇ","駕":"ㄐㄧㄚˋ","駛":"ㄕˇ","騎":"ㄑㄧˊ","髒":"ㄗㄤˋ","體":"ㄊㄧˇ","高":"ㄍㄠ","髮":"ㄈㄚ","魚":"ㄩˊ","鯨":"ㄐㄧㄥ","鳥":"ㄋㄧㄠˇ","鴨":"ㄧㄚ","麗":"ㄌㄧˋ","麥":"ㄇㄞˋ","麵":"ㄇㄧㄢˋ","麼":"˙ㄇㄜ","黃":"ㄏㄨㄤˊ","黑":"ㄏㄟ","點":"ㄉㄧㄢˇ","鼓":"ㄍㄨˇ","鼠":"ㄕㄨˇ","鼻":"ㄅㄧˊ","齒":"ㄔˇ","齡":"ㄌㄧㄥˊ","龜":"ㄍㄨㄟ"};

const isZhuyinOn = () => !store.settings || store.settings.zhuyin !== false;
function formatZhuyinRt(zy) {
  let tone = '';
  let syms = '';
  let isLight = false;

  for (const ch of zy) {
    if (ch === '˙') {
      isLight = true;
    } else if ('ˊˇˋ'.includes(ch)) {
      tone = ch;
    } else {
      syms += ch;
    }
  }

  const symsHtml = Array.from(syms).map((s) => `<span>${s}</span>`).join('');
  if (isLight) {
    return `<rt class="zy-rt"><span class="zy-col"><span class="zy-light">˙</span>${symsHtml}</span></rt>`;
  }
  if (tone) {
    const toneClass = tone === 'ˊ' ? 'tone-2' : tone === 'ˇ' ? 'tone-3' : 'tone-4';
    return `<rt class="zy-rt"><span class="zy-col">${symsHtml}</span><span class="zy-tone ${toneClass}">${tone}</span></rt>`;
  }
  return `<rt class="zy-rt"><span class="zy-col">${symsHtml}</span></rt>`;
}

function withZhuyin(str) {
  if (!isZhuyinOn()) return esc(str);
  return esc(str).replace(/[\u4e00-\u9fff]/g, (ch) => {
    const zy = ZHUYIN_DICT[ch];
    return zy ? `<ruby class="zy">${ch}${formatZhuyinRt(zy)}</ruby>` : ch;
  });
}
// 解析顯示用:在「。/；後面的 (A)-(D) 選項分析」與「記憶點」前斷行並加粗,把長段落變條列(不動資料)
function formatExp(text) {
  const s = esc(text)
    .replace(/([。；])\s*([(（][A-DＡ-Ｄ][)）])/g, '$1<br>$2')
    .replace(/([。；])\s*(核心記憶點|記憶點)/g, '$1<br>$2')
    .replace(/(^|<br>)\s*(正解\s*[(（][A-DＡ-Ｄ][)）]|[(（][A-DＡ-Ｄ][)）]|核心記憶點|記憶點)/g, '$1<strong>$2</strong>');
  if (!isZhuyinOn()) return s;
  return s.replace(/[\u4e00-\u9fff]/g, (ch) => {
    const zy = ZHUYIN_DICT[ch];
    return zy ? `<ruby class="zy">${ch}${formatZhuyinRt(zy)}</ruby>` : ch;
  });
}
// 教材對應：指到該題所屬科目的學習指引章節 + 開啟官方 PDF
function guideLine(q) {
  const url = DATA.meta && DATA.meta.guides && DATA.meta.guides[q.subject];
  if (!url && !q.chapter) return '';
  const ch = q.chapter ? `—『${esc(q.chapter)}』章` : '';
  const link = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">開啟學習指引 ↗</a>` : '';
  return `<p class="guide">教材對應：${esc(q.subject)} ${ch}${link}</p>`;
}
// 回報這題：開 GitHub issue form,自動帶入題號與科目
function reportLink(q) {
  const url = `https://github.com/darronchao/quiz-test/issues/new?template=question-report.yml`
    + `&qid=${encodeURIComponent(q.id)}&subject=${encodeURIComponent(q.subject)}`;
  return `<p class="report-line"><a href="${url}" target="_blank" rel="noopener">這題有誤？回報給作者</a></p>`;
}
// 今日挑戰：用日期當種子，固定挑 3 題（每天不同、當天穩定）
function dailyChallenge() {
  const qs = DATA.questions; if (!qs.length) return [];
  let seed = 0; for (const ch of today()) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const picks = [];
  for (let n = 0; n < 3 && n < qs.length; n++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    let i = seed % qs.length;
    while (picks.includes(i)) i = (i + 1) % qs.length;
    picks.push(i);
  }
  return picks.map((i) => qs[i]);
}
// 今日觀念卡：優先挑「你還沒掌握的章節」(錯題 + 練過未掌握)，逐日輪過；沒練過則全站輪播
function todayConcept() {
  if (!CONCEPTS.length) return null;
  const dayNum = Math.floor(new Date(today() + 'T00:00:00').getTime() / 86400000);
  const byCh = {};
  for (const q of DATA.questions) {
    const p = store.q[q.id]; if (!p) continue;
    const c = (byCh[q.chapter || q.subject] ||= { attempted: 0, mastered: 0, wrongNow: 0 });
    if (p.attempts > 0) c.attempted++;
    if (isMastered(p.box)) c.mastered++;
    else if (p.wrong > 0) c.wrongNow++;
  }
  const weak = Object.entries(byCh)
    .map(([ch, c]) => ({ ch, score: c.attempted ? c.wrongNow * 2 + (c.attempted - c.mastered) : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (weak.length) {
    const chosen = weak[dayNum % weak.length].ch;
    const pool = CONCEPTS.filter((c) => c.chapter === chosen);
    if (pool.length) return { ...pool[dayNum % pool.length], weak: true };
  }
  return CONCEPTS[((dayNum % CONCEPTS.length) + CONCEPTS.length) % CONCEPTS.length];
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

// ---- views ----
function setNav(active) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === active));
}

// 範圍 = 章節（若題目尚未分類則退回科目），供「選擇練習範圍」用
const rangeKey = (q) => q.chapter || q.subject;
const srcOf = (q) => q.source || '歷屆';
function rangeGroups() {
  const m = new Map();
  for (const q of DATA.questions) {
    const k = rangeKey(q);
    const g = m.get(k) || { key: k, level: q.level, count: 0 };
    g.count++; m.set(k, g);
  }
  return [...m.values()];
}

function home() {
  setNav('home');
  const groups = rangeGroups();
  const byLevel = {};
  groups.forEach((g) => (byLevel[g.level] ||= []).push(g));
  const ranges = Object.entries(byLevel).map(([lv, gs]) =>
    `<div class="range-group"><div class="range-lv">${esc(lv)}</div>${gs.map((g) =>
      `<label class="range-item"><input type="checkbox" class="rng" value="${esc(g.key)}" checked><span>${esc(g.key)}</span><b>${g.count}</b></label>`).join('')}</div>`).join('');
  const g = dailyGoal(), dc = todayCount(), strk = liveStreak(), du = daysUntilExam();
  const et = examTarget();
  const goalHit = dc >= g;
  // 開啟提醒的入口本來只在設定頁最底下,2,137 個人裡只有 17 個找到它。
  // 放在倒數旁邊:看到「還有幾天」的那一刻,才是他真的想要被提醒的時候。
  // 預設隱藏,渲染完非同步查到「還沒訂閱」才顯示,免得已訂閱的人看到重複的邀請。
  const remindCta = du != null && du >= 0 && et && pushSupported() && SYNC_URL
    ? `<div id="remind-cta" hidden><button id="remind-on">考前提醒我</button>
         <span class="muted" id="remind-msg">${et.date}${et.level ? `・${esc(et.level)}` : ''}，每天提醒你刷幾題</span></div>`
    : '';
  const dailyStrip = `
    <section class="card daily-card">
      <div class="daily">
        <div><b class="${goalHit ? 'hit' : ''}">${dc}/${g}</b><span>今日題數${goalHit ? ' ✓' : ''}</span></div>
        <div><b>${strk}</b><span>連續天數</span></div>
        ${du != null ? `<div><b>${du < 0 ? '—' : du}</b><span>${du < 0 ? '考試已過' : `距${et && et.level ? esc(et.level) : ''}考試（天）`}</span></div>` : ''}
      </div>
      ${remindCta}
      <button id="share">分享進度</button>
    </section>`;
  const chDone = store.challengeDone === today();
  const challengeCard = `
    <section class="card">
      <div class="row"><h3 style="margin:0">今日挑戰 ${chDone ? '✓ 已完成' : '3 題'}</h3>
        <button class="primary" id="challenge" style="margin:0;padding:8px 14px">${chDone ? '再做一次' : '開始'}</button></div>
      <p class="muted" style="margin:6px 0 0">每天 3 題，養成每日刷題的習慣。</p>
    </section>`;
  const cc = todayConcept();
  const conceptCard = cc ? `
    <section class="card concept-card">
      <div class="ck">今日 AI 觀念${cc.chapter ? ' · ' + esc(cc.chapter) : ''}${cc.weak ? ' · 針對你還沒掌握的範圍' : ''}</div>
      <h3>${esc(cc.title)}</h3>
      <p>${esc(cc.body)}</p>
    </section>` : '';
  view.innerHTML = `${dailyStrip}${challengeCard}${conceptCard}
    <section class="card">
      <h2>練習模式</h2>
      <p class="muted">即時看答案與解析。勾選要練的範圍，預設全選。</p>
      <div class="row range-head"><span class="muted" id="range-sum"></span>
        <span><button id="sel-all">全選</button><button id="sel-none">清除</button></span></div>
      <div id="ranges">${ranges}</div>
      <label>關鍵字（選填）
        <input id="pr-kw" placeholder="例如 RAG、特徵工程、Transformer">
      </label>
      <label>出題方式
        <select id="pr-mode">
          <option value="smart">智慧複習（優先錯題與沒做過的）</option>
          <option value="random">隨機</option>
        </select>
      </label>
      <label>題數
        <select id="pr-count"><option value="10">10</option><option value="20">20</option><option value="0">全部（選取範圍）</option></select>
      </label>
      <label>來源
        <select id="pr-source">
          <option value="">全部（歷屆 + 學習指引）</option>
          <option value="歷屆">只練歷屆考古題</option>
          <option value="學習指引">只練學習指引範例</option>
        </select>
      </label>
      <button class="primary" id="pr-start">開始練習</button>
      <button class="primary alt" id="pr-images">只練看圖題（${DATA.questions.filter((q) => q.image).length} 題,全中級）</button>
    </section>`;
  const selectedKeys = () => new Set([...view.querySelectorAll('.rng:checked')].map((c) => c.value));
  const kw = () => $('#pr-kw').value.trim().toLowerCase();
  const matchKw = (q) => {
    const k = kw();
    if (!k) return true;
    return `${q.question}${q.topic || ''}${q.chapter || ''}${q.options.join(' ')}`.toLowerCase().includes(k);
  };
  const pickPool = () => {
    const keys = selectedKeys();
    const src = $('#pr-source') ? $('#pr-source').value : '';
    return DATA.questions.filter((q) => keys.has(rangeKey(q)) && matchKw(q) && (!src || srcOf(q) === src));
  };
  const updateSum = () => {
    const keys = selectedKeys();
    $('#range-sum').textContent = `已選 ${keys.size} 範圍，共 ${pickPool().length} 題`;
  };
  view.querySelectorAll('.rng').forEach((c) => (c.onchange = updateSum));
  $('#pr-kw').oninput = updateSum;
  $('#pr-source').onchange = updateSum;
  $('#sel-all').onclick = () => { view.querySelectorAll('.rng').forEach((c) => (c.checked = true)); updateSum(); };
  $('#sel-none').onclick = () => { view.querySelectorAll('.rng').forEach((c) => (c.checked = false)); updateSum(); };
  $('#pr-start').onclick = () => {
    const count = +$('#pr-count').value;
    let pool = pickPool();
    if ($('#pr-mode').value === 'smart') {
      // 依優先序排（錯題→沒做過→做過未掌握→已掌握），同級隨機
      pool = pool.map((q) => ({ q, pr: reviewPriority(store.q[q.id]), r: Math.random() }))
        .sort((a, b) => a.pr - b.pr || a.r - b.r).map((x) => x.q);
    } else {
      pool = shuffle(pool);
    }
    if (count) pool = pool.slice(0, count);
    runPractice(pool);
  };
  $('#pr-images').onclick = () => runPractice(shuffle(DATA.questions.filter((q) => q.image)));
  $('#challenge').onclick = () => { store.challengeDone = today(); save(); runPractice(dailyChallenge()); };
  if ($('#remind-cta')) {
    pushIsOn().then((on) => { if (!on) $('#remind-cta').hidden = false; }).catch(() => {});
    $('#remind-on').onclick = async () => {
      const btn = $('#remind-on'); btn.disabled = true; btn.textContent = '設定中…';
      const r = await enablePush((store.settings && store.settings.reminderHour) || 20).catch(() => ({ ok: false }));
      btn.textContent = r.ok ? '已開啟提醒' : '開啟失敗';
      // 失敗多半是使用者按了「封鎖通知」,或 iPhone 沒把本站加到主畫面。指路到設定頁,那裡有完整說明。
      $('#remind-msg').textContent = r.ok
        ? '每天 20:00 提醒，時間可到設定頁改'
        : (r.reason || '這台裝置開不起來，設定頁有說明');
      btn.disabled = !r.ok;
      if (r.ok) btn.disabled = true;
    };
  }
  $('#share').onclick = async () => {
    const cd = (du != null && du >= 0) ? `、距考試 ${du} 天` : '';
    const txt = `我在 iPAS AI 應用規劃師模擬考刷題：連續打卡 ${strk} 天、今日 ${dc}/${g} 題${cd}。一起來練官方試題！`;
    const url = location.origin + location.pathname;
    if (navigator.share) { try { await navigator.share({ title: 'iPAS 模考練習', text: txt, url }); } catch {} }
    else { try { await navigator.clipboard.writeText(`${txt} ${url}`); $('#share').textContent = '已複製連結'; } catch {} }
  };
  updateSum();
}

function runPractice(pool, opts = {}) {
  let i = 0;
  let right = 0, wrong = 0;
  const sessionWrong = [];
  if (!pool.length) {
    view.innerHTML = `<section class="card"><p>沒有符合的題目。</p></section>`;
    return;
  }
  const render = () => {
    const q = pool[i];
    const p = qp(q.id);
    const zyOn = isZhuyinOn();
    view.innerHTML = `
      <section class="card">
        <div class="row"><span class="muted">${i + 1} / ${pool.length}</span>
          <span>
            <button class="zhuyin-toggle ${zyOn ? 'on' : ''}" id="toggle-zy" title="切換注音顯示">ㄅ 注音${zyOn ? '開' : '關'}</button>
            <button class="star ${p.starred ? 'on' : ''}" id="star">${p.starred ? '★ 已標' : '☆ 標記'}</button>
          </span>
        </div>
        <p class="qmeta muted">${esc(q.subject)}${q.topic ? '・' + esc(q.topic) : ''}${q.source === '學習指引' ? ' <span class="src-tag">學習指引範例</span>' : ''}</p>
        <h3 class="q-title">${withZhuyin(q.question)}</h3>
        ${q.image ? `<img class="qfig" src="${esc(q.image)}" alt="題目附圖" loading="lazy">` : ''}
        <div id="opts">${q.options.map((o, k) => `<button class="opt" data-k="${k}">${withZhuyin(o)}</button>`).join('')}</div>
        <div id="fb"></div>
      </section>`;
    $('#toggle-zy').onclick = () => {
      store.settings = store.settings || {};
      store.settings.zhuyin = !zyOn;
      save();
      render();
    };
    $('#star').onclick = () => { p.starred = !p.starred; save(); render(); };
    view.querySelectorAll('.opt').forEach((btn) =>
      (btn.onclick = () => answer(q, +btn.dataset.k)));
  };
  const answer = (q, k) => {
    const p = qp(q.id);
    const correct = k === q.answer;
    p.attempts++;
    if (correct) { p.correct++; right++; } else { p.wrong++; wrong++; sessionWrong.push(q); }
    p.box = nextBox(p.box, correct);
    logRecent(correct);
    bumpDaily(correct);
    save();
    view.querySelectorAll('.opt').forEach((b, idx) => {
      b.disabled = true;
      if (idx === q.answer) b.classList.add('correct');
      if (idx === k && !correct) b.classList.add('wrong');
    });
    $('#fb').innerHTML = `
      <p class="${correct ? 'ok' : 'bad'}">${withZhuyin(correct ? '答對！' : '答錯！')}（${withZhuyin('正解：' + q.options[q.answer])}）</p>
      ${q.explanation ? `<p class="exp">${formatExp(q.explanation)}</p>` : ''}
      ${guideLine(q)}
      ${reportLink(q)}
      <label class="note">筆記<textarea id="note" rows="2" placeholder="寫下你的理解或記憶點…">${esc(p.note || '')}</textarea></label>
      <button class="primary" id="next">${i + 1 < pool.length ? '下一題' : '完成'}</button>`;
    $('#note').oninput = (e) => { p.note = e.target.value; save(); };
    $('#next').onclick = () => { i++; i < pool.length ? render() : finish(); };
  };
  const finish = () => {
    pushSync(); // checkpoint:練習完成立即上傳
    const total = right + wrong;
    const pct = total ? Math.round((right / total) * 1000) / 10 : 0;
    view.innerHTML = `
      <section class="card">
        <h2>練習完成</h2>
        <p class="score">${pct}％</p>
        <p>這組 ${total} 題,答對 ${right}、答錯 ${wrong}</p>
        ${sessionWrong.length ? '<button class="primary" id="redo-wrong">只練這次錯的</button>' : '<p class="muted">這組全對,讚!</p>'}
        <button id="again">再練一次</button>
        <button id="back">回首頁</button>
      </section>`;
    if (sessionWrong.length) $('#redo-wrong').onclick = () => runPractice(sessionWrong.slice());
    $('#again').onclick = () => runPractice(shuffle(pool.slice()));
    $('#back').onclick = home;
  };
  render();
}

function mockSetup() {
  setNav('mock');
  const opts = papers().map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  const lim = DATA.meta.defaultTimeLimitMin || 60;
  view.innerHTML = `
    <section class="card">
      <h2>模擬考模式</h2>
      <p class="muted">整份計時作答，交卷前不顯示答案。練臨場與時間分配。</p>
      <label>試卷<select id="mk-paper">${opts}</select></label>
      <label>時間（分鐘）<input id="mk-min" type="number" value="${lim}" min="1"></label>
      <button class="primary" id="mk-start">開始模擬考</button>
    </section>`;
  $('#mk-start').onclick = () => {
    const paper = $('#mk-paper').value;
    const mins = +$('#mk-min').value || lim;
    const pool = DATA.questions.filter((q) => `${q.level}｜${q.round}｜${q.subject}` === paper);
    runMock(pool, mins);
  };
}

function runMock(pool, mins) {
  const answers = new Array(pool.length).fill(null);
  let i = 0;
  let remaining = mins * 60;
  const fmt = () => `${String((remaining / 60) | 0).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const timer = setInterval(() => {
    remaining--;
    const t = $('#timer');
    if (t) t.textContent = fmt();
    if (remaining <= 0) { clearInterval(timer); submit(); }
  }, 1000);

  const render = () => {
    const q = pool[i];
    const zyOn = isZhuyinOn();
    view.innerHTML = `
      <section class="card">
        <div class="row"><span class="muted">${i + 1} / ${pool.length}</span>
          <span>
            <button class="zhuyin-toggle ${zyOn ? 'on' : ''}" id="toggle-zy" title="切換注音顯示">ㄅ 注音${zyOn ? '開' : '關'}</button>
            <span id="timer" class="timer">${fmt()}</span>
          </span>
        </div>
        <p class="qmeta muted">${esc(q.subject)}</p>
        <h3 class="q-title">${withZhuyin(q.question)}</h3>
        ${q.image ? `<img class="qfig" src="${esc(q.image)}" alt="題目附圖" loading="lazy">` : ''}
        <div id="opts">${q.options.map((o, k) =>
          `<button class="opt ${answers[i] === k ? 'picked' : ''}" data-k="${k}">${withZhuyin(o)}</button>`).join('')}</div>
        <div class="row">
          <button id="prev" ${i === 0 ? 'disabled' : ''}>上一題</button>
          ${i + 1 < pool.length ? '<button id="next">下一題</button>' : '<button class="primary" id="submit">交卷</button>'}
        </div>
      </section>`;
    $('#toggle-zy').onclick = () => {
      store.settings = store.settings || {};
      store.settings.zhuyin = !zyOn;
      save();
      render();
    };
    // 點選項只切換 picked class,不整卡重 render(否則 #timer 被重建會閃 --:--)
    view.querySelectorAll('.opt').forEach((b) => (b.onclick = () => {
      answers[i] = +b.dataset.k;
      view.querySelectorAll('.opt').forEach((x) => x.classList.toggle('picked', +x.dataset.k === answers[i]));
    }));
    if ($('#prev')) $('#prev').onclick = () => { i--; render(); };
    if ($('#next')) $('#next').onclick = () => { i++; render(); };
    if ($('#submit')) $('#submit').onclick = submit;
  };
  function submit() {
    clearInterval(timer);
    // 計入進度（模擬考也更新 Leitner / 統計）
    pool.forEach((q, idx) => {
      const p = qp(q.id);
      const correct = answers[idx] === q.answer;
      p.attempts++;
      if (correct) p.correct++; else p.wrong++;
      p.box = nextBox(p.box, correct);
      logRecent(correct);
      bumpDaily(correct);
    });
    save();
    pushSync(); // checkpoint:交卷立即上傳
    const r = scoreExam(pool, answers);
    view.innerHTML = `
      <section class="card">
        <h2>結果</h2>
        <p class="score">${r.percent}％</p>
        <p>答對 ${r.correct} / ${r.total}，答錯 ${r.wrong}</p>
        <button class="primary" id="review">檢討錯題</button>
        <button id="back">回首頁</button>
      </section>`;
    $('#back').onclick = home;
    $('#review').onclick = () => runPractice(pool.filter((q) => r.wrongIds.includes(q.id)));
  }
  render();
}

function wrongbook() {
  setNav('wrong');
  const ids = wrongQuestionIds(DATA.questions, store.q);
  const list = ids.map((id) => DATA.questions.find((q) => q.id === id));
  view.innerHTML = `
    <section class="card">
      <h2>錯題本</h2>
      <p class="muted">答錯過、還沒掌握的題會留在這。同一題之後「連續答對 ${MASTER_BOX - 1} 次」就算掌握、自動移出。</p>
      ${ids.length ? `<button class="primary" id="drill">只練這些錯題</button>` : '<p>目前沒有錯題，繼續加油。</p>'}
      <ul class="wrong">${list.map((q) => `<li>${withZhuyin(q.question)}<br><span class="ok" style="font-size:13px">${withZhuyin('正解：' + q.options[q.answer])}</span> <span class="muted">（${esc(q.subject)}・再連對 ${Math.max(1, MASTER_BOX - (qp(q.id).box || 1))} 次就掌握）</span></li>`).join('')}</ul>
    </section>`;
  if (ids.length) $('#drill').onclick = () => runPractice(shuffle(list));
}

function notes() {
  setNav('notes');
  const items = DATA.questions.filter((q) => { const p = store.q[q.id]; return p && (p.note || p.starred); });
  view.innerHTML = `
    <section class="card">
      <h2>我的筆記</h2>
      <p class="muted">有寫筆記、或加星 ⭐ 的題目都在這。筆記可直接在下面改,會自動存。</p>
      ${items.length
        ? '<button id="exp-notes">匯出筆記（Markdown）</button>'
        : '<p>還沒有筆記或星標題。練習時在題目下方寫筆記、或點 ☆ 加星,就會出現在這。</p>'}
      ${items.map((q) => {
        const p = qp(q.id);
        return `<div class="note-item">
          <div class="row"><span class="muted">${p.starred ? '⭐ ' : ''}${esc(q.subject)}</span>
            <button class="goto" data-id="${esc(q.id)}">前往該題</button></div>
          <p class="qn">${withZhuyin(q.question)}</p>
          <p style="margin:2px 0 6px;font-size:13px" class="ok">${withZhuyin('正解：' + q.options[q.answer])}</p>
          <textarea class="note-edit" data-id="${esc(q.id)}" rows="2" placeholder="寫下你的理解或記憶點…">${esc(p.note || '')}</textarea>
        </div>`;
      }).join('')}
    </section>`;
  view.querySelectorAll('.note-edit').forEach((t) => (t.oninput = (e) => { qp(e.target.dataset.id).note = e.target.value; save(); }));
  view.querySelectorAll('.goto').forEach((b) => (b.onclick = () => { const q = DATA.questions.find((x) => x.id === b.dataset.id); if (q) runPractice([q]); }));
  if (items.length) $('#exp-notes').onclick = () => download('quiz-test-notes.md', toMarkdown(DATA.questions, store.q), 'text/markdown');
}

function stats() {
  setNav('stats');
  const s = progressStats(DATA.questions, store.q);
  const cover = s.total ? Math.round((s.practiced / s.total) * 1000) / 10 : 0;
  const rec = store.recent || [];
  const recAcc = rec.length ? Math.round((rec.reduce((a, b) => a + b, 0) / rec.length) * 1000) / 10 : null;
  // 各章節（範圍）正確率與掌握度
  const byCh = new Map();
  for (const q of DATA.questions) {
    const k = rangeKey(q);
    const p = store.q[q.id] || {};
    const c = byCh.get(k) || { key: k, total: 0, attempts: 0, correct: 0, mastered: 0 };
    c.total++; c.attempts += p.attempts || 0; c.correct += p.correct || 0;
    if (isMastered(p.box)) c.mastered++;
    byCh.set(k, c);
  }
  const chRows = [...byCh.values()].map((x) =>
    `<tr><td>${esc(x.key)}</td><td>${x.attempts ? Math.round((x.correct / x.attempts) * 1000) / 10 + '％' : '—'}</td><td>${x.mastered}/${x.total}</td></tr>`).join('');
  // 成就徽章
  const strk = liveStreak();
  const badges = [
    { on: s.practiced >= 50, t: '練習 50 題' },
    { on: s.practiced >= 200, t: '練習 200 題' },
    { on: s.practiced >= s.total, t: '全部練過' },
    { on: strk >= 3, t: '連續 3 天' },
    { on: strk >= 7, t: '連續 7 天' },
    { on: strk >= 30, t: '連續 30 天' },
    { on: recAcc != null && recAcc >= 80, t: '近期 80% 命中' },
    { on: [...byCh.values()].some((c) => c.total > 0 && c.mastered === c.total), t: '某範圍全掌握' },
  ];
  const badgeHtml = badges.map((b) => `<span class="badge ${b.on ? '' : 'lock'}">${b.on ? '✓ ' : ''}${b.t}</span>`).join('');
  // 最近 14 天題數趨勢
  const days14 = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(today() + 'T00:00:00'); d.setDate(d.getDate() - i); days14.push(ymd(d)); }
  const hist = store.history || {};
  const maxA = Math.max(1, ...days14.map((d) => (hist[d] && hist[d].a) || 0));
  const bars = days14.map((d) => {
    const a = (hist[d] && hist[d].a) || 0;
    const h = a ? Math.max(3, Math.round((a / maxA) * 56)) : 0;
    return `<div class="tcol" title="${d}：${a} 題"><span class="tnum">${a || ''}</span><div class="bar" style="height:${h}px"></div></div>`;
  }).join('');
  view.innerHTML = `
    <section class="card">
      <h2>學習統計</h2>
      <div class="grid">
        <div><b>${cover}％</b><span>涵蓋率（練過 ${s.practiced}/${s.total}）</span></div>
        <div><b>${recAcc == null ? '—' : recAcc + '％'}</b><span>近期正確率（最近 ${rec.length}）</span></div>
        <div><b>${s.wrongNow}</b><span>目前錯題</span></div>
        <div><b>${s.mastered}</b><span>已掌握</span></div>
      </div>
      <p class="muted" style="font-size:13px">「掌握」= 同一題連續答對 2 次。用「智慧複習」會優先讓你重做沒掌握與答錯的題，掌握數才會往上跑。</p>
      <h3>成就</h3>
      <div class="badges">${badgeHtml}</div>
      <h3>最近 14 天題數</h3>
      <div class="trend">${bars}</div>
      <div class="trend-lab"><span>${days14[0].slice(5)}</span><span>今天</span></div>
      <h3>各範圍弱點</h3>
      <table>
        <tr><th>範圍</th><th>正確率</th><th>掌握</th></tr>
        ${chRows}
      </table>
    </section>`;
}

// 官方考試資訊小區塊:及格標準(穩定)+ 各級下次考試日期一鍵填入(非強制,初級中級日期不同)
function examInfoHtml() {
  if (!EXAMINFO) return '';
  const t = today();
  const next = (arr) => (arr || []).filter((d) => d >= t).sort()[0];
  const picks = Object.entries(EXAMINFO.exams || {})
    .map(([lv, arr]) => { const d = next(arr); return d ? `<button class="exam-pick" data-d="${d}">下次${esc(lv)} ${d}</button>` : ''; })
    .join('');
  return `<div class="guide" style="white-space:normal">
    ${EXAMINFO.pass ? `<p style="margin:0 0 6px">${esc(EXAMINFO.pass)}</p>` : ''}
    ${picks ? `<div style="margin-bottom:6px">一鍵設為倒數日期(初級/中級日期不同,自己選):<br>${picks}</div>` : ''}
    <a href="https://www.geptkids.org.tw/" target="_blank" rel="noopener">官方考試資訊 ↗</a>
  </div>`;
}

function settings() {
  setNav('settings');
  if (SYNC_URL) pushSync(); // 打開設定頁就把最新進度上傳，確保拿碼去別台時雲端已是最新
  const remHour = (store.settings && store.settings.reminderHour) || 20;
  view.innerHTML = `
    <section class="card">
      <h2>設定</h2>
      <h3>安裝成 App</h3>
      <p class="muted">裝起來有 App icon、可全螢幕、離線也能刷。</p>
      <button id="set-install">安裝</button>
      <span id="set-install-msg" class="muted"></span>

      <h3>學習目標</h3>
      <label>每日目標題數
        <input id="set-goal" type="number" min="1" max="790" value="${dailyGoal()}">
      </label>
      <label>考試日期（首頁倒數用）
        <input id="set-exam" type="date" value="${(store.settings && store.settings.examDate) || ''}">
      </label>
      ${examInfoHtml()}

      <h3>題目注音</h3>
      <label class="row" style="cursor:pointer;margin:8px 0">
        <span>題目與選項顯示注音符號（適合國小學童閱讀）</span>
        <input id="set-zhuyin" type="checkbox" ${isZhuyinOn() ? 'checked' : ''} style="width:auto">
      </label>

      <h3>每日提醒（推播）</h3>
      <p class="muted">到設定時間若今天還沒練，會推播提醒你刷題。iPhone 需先把本站「加到主畫面」，並從安裝後的 App 開啟才收得到。</p>
      <label>提醒時間
        <select id="rem-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === remHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
      </label>
      <button id="rem-toggle">${pushSupported() ? '載入中…' : '此瀏覽器不支援推播'}</button>
      <button id="rem-test">傳測試通知</button>
      <span id="rem-msg" class="muted"></span>

      <h3>同步碼</h3>
      <p class="muted">${SYNC_URL
        ? '平常背景自動同步（每隔幾秒、切走 App 時、打開本頁時都會上傳）。換新裝置時：先在舊裝置打開這頁（會上傳），再到新裝置輸入這組碼。'
        : '雲端同步尚未啟用（需在 app.js 填入 Worker 網址）。目前可用下方「匯出/匯入」轉移。'}</p>
      <p class="code" id="code">${esc(store.syncCode)}</p>
      <label>在新裝置輸入既有同步碼
        <input id="code-in" placeholder="例如 fox-river-82">
      </label>
      <button id="code-set">套用此碼</button>
      ${SYNC_URL ? '<button id="sync-now">立即同步</button>' : ''}
      <span id="sync-msg" class="muted"></span>

      <h3>備份 / 轉移</h3>
      <button id="exp">匯出進度（JSON）</button>
      <button id="imp-btn">匯入進度（JSON）</button>
      <input id="imp" type="file" accept="application/json" hidden>
      <button id="exp-md">匯出筆記（Markdown）</button>

      <h3>重設統計</h3>
      <p class="muted" style="font-size:13px">把作答統計歸零、重新練到 100%,但<strong>保留你的筆記與星標</strong>。</p>
      <button id="reset-stats">重設統計(保留筆記與星標)</button>

      <h3 class="danger">重設</h3>
      <button class="danger" id="reset">清除本機所有進度</button>
    </section>`;
  const insBtn = $('#set-install'), insMsg = $('#set-install-msg');
  if (insBtn) {
    if (isStandalone()) { insBtn.textContent = '已安裝 ✓'; insBtn.disabled = true; }
    else if (deferredInstall) {
      insBtn.onclick = async () => {
        deferredInstall.prompt();
        const c = await deferredInstall.userChoice.catch(() => ({}));
        if (c && c.outcome === 'accepted') { insBtn.textContent = '已安裝 ✓'; insBtn.disabled = true; dismissInstallBar(); }
        deferredInstall = null;
      };
    } else {
      insBtn.disabled = true;
      insBtn.textContent = '由瀏覽器選單安裝';
      insMsg.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
        ? '（iPhone:Safari 分享鈕 → 加入主畫面）'
        : '（Chrome ⋮ 選單 → 安裝應用程式 / 加到主畫面）';
    }
  }
  $('#set-goal').onchange = (e) => { store.settings ||= {}; store.settings.dailyGoal = Math.max(1, +e.target.value || 20); save(); };
  $('#set-exam').onchange = (e) => { store.settings ||= {}; store.settings.examDate = e.target.value; save(); };
  if ($('#set-zhuyin')) $('#set-zhuyin').onchange = (e) => { store.settings ||= {}; store.settings.zhuyin = e.target.checked; save(); };
  view.querySelectorAll('.exam-pick').forEach((b) => (b.onclick = () => {
    store.settings ||= {}; store.settings.examDate = b.dataset.d; save();
    $('#set-exam').value = b.dataset.d;
  }));
  if ($('#rem-hour')) $('#rem-hour').onchange = async (e) => {
    store.settings ||= {}; store.settings.reminderHour = +e.target.value; save();
    if (await pushIsOn()) { await enablePush(+e.target.value); $('#rem-msg').textContent = '提醒時間已更新'; }
  };
  if (pushSupported() && $('#rem-toggle')) {
    const btn = $('#rem-toggle');
    pushIsOn().then((on) => { btn.textContent = on ? '關閉提醒' : '開啟提醒'; });
    btn.onclick = async () => {
      btn.disabled = true; $('#rem-msg').textContent = '處理中…';
      try {
        if (await pushIsOn()) { await disablePush(); btn.textContent = '開啟提醒'; $('#rem-msg').textContent = '已關閉提醒'; }
        else {
          const r = await enablePush((store.settings && store.settings.reminderHour) || 20);
          if (r.ok) { btn.textContent = '關閉提醒'; $('#rem-msg').textContent = '已開啟，每天到點提醒'; }
          else { $('#rem-msg').textContent = '開啟失敗：' + (r.reason || '請稍後再試'); }
        }
      } catch { $('#rem-msg').textContent = '發生錯誤，請稍後再試'; }
      btn.disabled = false;
    };
  }
  if ($('#rem-test')) $('#rem-test').onclick = async () => {
    $('#rem-msg').textContent = '傳送測試中…';
    try {
      const r = await fetch(`${SYNC_URL}/push/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: store.syncCode }) });
      const j = await r.json().catch(() => ({}));
      $('#rem-msg').textContent = r.ok ? '已傳送，看通知有沒有跳出' : (j.error === 'not_subscribed' ? '請先「開啟提醒」' : '失敗：' + (j.error || r.status));
    } catch { $('#rem-msg').textContent = '傳送失敗'; }
  };
  $('#code-set').onclick = async () => {
    const v = $('#code-in').value.trim();
    if (!v) return;
    store.syncCode = v;
    store.updatedAt = 0; // 讓開啟時的 pull 一定採用雲端那份
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    if (SYNC_URL) await pullSync();
    settings();
  };
  if ($('#sync-now')) $('#sync-now').onclick = async () => {
    $('#sync-msg').textContent = '同步中…';
    const pulled = await pullSync();
    const pushed = await pushSync();
    $('#sync-msg').textContent = pushed || pulled ? '已同步' : '同步失敗（檢查網路或同步碼）';
    if (pulled) setTimeout(settings, 600);
  };
  $('#exp').onclick = () => download('quiz-test-progress.json', JSON.stringify(store, null, 2), 'application/json');
  $('#exp-md').onclick = () => download('quiz-test-notes.md', toMarkdown(DATA.questions, store.q), 'text/markdown');
  $('#imp-btn').onclick = () => $('#imp').click();
  $('#imp').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (s && s.q) { store = s; save(); alert('已匯入。'); home(); }
      else alert('檔案格式不符。');
    } catch { alert('讀取失敗。'); }
  };
  $('#reset').onclick = async () => {
    if (!confirm('確定清除本機所有作答進度與筆記？')) return;
    store = { v: 1, syncCode: makeCode(), codeFresh: true, q: {} };
    await ensureFreshCode(); // 新碼先查重,再 save(save 會標 dirty 上傳)
    save(); settings();
  };
  $('#reset-stats').onclick = () => {
    if (!confirm('重設統計?掌握度、正確率、錯題本、打卡、趨勢都歸零;保留筆記、星標與設定。')) return;
    for (const id in store.q) {
      const p = store.q[id];
      if (p.note || p.starred) store.q[id] = { box: 1, attempts: 0, correct: 0, wrong: 0, note: p.note || '', starred: !!p.starred };
      else delete store.q[id];
    }
    store.recent = []; store.history = {}; store.streak = { count: 0, lastDate: '' }; store.daily = null;
    save(); settings();
  };
}

// 從 UA 粗略判斷裝置/瀏覽器,給「意見回饋」表單預填(僅 OS + 瀏覽器名,不含版本)
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Version\/[\d.]+.*Safari/.test(ua) ? 'Safari' : '瀏覽器';
  return `${os} · ${br}`;
}

const ROUTES = { home, mock: mockSetup, wrong: wrongbook, notes, stats, settings };

// ---- boot ----
async function boot() {
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => ROUTES[b.dataset.v]()));
  // 「意見回饋」連結自動帶入裝置/瀏覽器(GitHub issue form 以 &env= 預填同名欄位)
  const fbLink = document.getElementById('fb-link');
  if (fbLink) fbLink.href += `&env=${encodeURIComponent(deviceLabel())}`;
  if (isStandalone() || installBarOff()) { const b = document.getElementById('installbar'); if (b) b.hidden = true; }
  const ib = document.getElementById('install-btn');
  if (ib) ib.onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    dismissInstallBar();
  };
  const ix = document.getElementById('install-x');
  if (ix) ix.onclick = dismissInstallBar;
  try {
    DATA = await (await fetch('questions.json')).json();
  } catch {
    view.innerHTML = `<section class="card"><p class="bad">載入 questions.json 失敗。請用本機伺服器開啟（例如 <code>python3 -m http.server</code>）。</p></section>`;
    return;
  }
  try { CONCEPTS = ((await (await fetch('concepts.json')).json()).cards) || []; } catch { CONCEPTS = []; }
  try { EXAMINFO = await (await fetch('exam-dates.json')).json(); } catch { EXAMINFO = null; }
  if (DATA.meta?.title) $('#title').textContent = DATA.meta.title;
  if (DATA.meta?.note) { const n = $('#banner'); n.textContent = DATA.meta.note; n.hidden = false; }
  localStorage.setItem(STORE_KEY, JSON.stringify(store)); // 落地可能新生成的 syncCode(不動 updatedAt)
  await ensureFreshCode(); // 全新自動碼先查重(要在 pull 之前,否則撞碼會拉到陌生人的進度)
  if (SYNC_URL) await pullSync(); // 開啟先拉雲端，單人多裝置就不會互蓋
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushSync({ keepalive: true }); }); // checkpoint:切走/關頁前 flush
  home();
}
boot();
