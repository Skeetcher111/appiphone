'use strict';

// Локальное хранилище Apple ID и обёртка над ipatool.
//
// Ключевое: НИЧЕГО не уходит на наш сервер. Вход в Apple делает сам ipatool
// (`auth login` / `--auth-code`) — он подписывает запрос к Apple (SAP), а мы
// подпись сформировать не можем. Самописный HTTP-вход на buy.itunes.apple.com
// (был в 1.3.1–1.3.5) Apple теперь отклоняет с HTTP 403 (обязательная
// SAP-подпись), поэтому он убран — осталась ровно схема 1.2.5, которая
// работает: один подписанный запрос через ipatool на каждый шаг.
//
// Для каждого Apple ID — своя изолированная папка-«домашка», внутри ipatool
// держит свой keychain (`.ipatool/`). Изоляция — подменой HOMEDRIVE/HOMEPATH
// (у ipatool 2.5.0 нет флага пути к keychain; USERPROFILE игнорируется).

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const tls = require('tls');
const { execFile } = require('child_process');

const ROOT = () => path.join(app.getPath('userData'), 'accounts');
const CONFIG = () => path.join(ROOT(), 'accounts.json');

// Адрес сервера каталога-кэша по умолчанию. Переопределяется переменной
// APPIPHONE_SERVER_URL. Сюда не ходит ни Apple ID, ни пароль, ни 2FA-код —
// только каталог приложений и статус баланса установок.
const DEFAULT_SERVER_URL = 'https://api.example.com';

// --- Конфиг (список аккаунтов + активный + пасфраза локального keychain) ---

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG(), 'utf8');
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.list)) cfg.list = [];
    if (!cfg.passphrase) cfg.passphrase = crypto.randomBytes(18).toString('base64');
    return cfg;
  } catch {
    return { passphrase: crypto.randomBytes(18).toString('base64'), active: null, list: [] };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(ROOT(), { recursive: true });
  fs.writeFileSync(CONFIG(), JSON.stringify(cfg, null, 2), 'utf8');
}

function safeEmail(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9._@-]/g, '_');
}

function accountDir(email) {
  return path.join(ROOT(), safeEmail(email));
}

// --- Папка-библиотека скачанных .ipa (тел приложений) --------------------
// Постоянная, переживает обновления приложения. По умолчанию —
// %AppData%/AppIPhone/ipa-cache. Пользователь может выбрать свою папку
// (поле ipaCacheDir в accounts.json); пустое значение = вернуть дефолт.
function defaultIpaCacheDir() {
  return path.join(app.getPath('userData'), 'ipa-cache');
}

function getIpaCacheDir() {
  const cfg = loadConfig();
  const dir = (cfg.ipaCacheDir && String(cfg.ipaCacheDir).trim()) || defaultIpaCacheDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* создастся при записи */ }
  return dir;
}

function setIpaCacheDir(dir) {
  const cfg = loadConfig();
  const v = dir ? String(dir).trim() : '';
  if (v) cfg.ipaCacheDir = v; else delete cfg.ipaCacheDir;
  saveConfig(cfg);
  return getIpaCacheDir();
}

// Подпапка библиотеки для КОНКРЕТНОГО аккаунта — тело .ipa из неё содержит
// лицензию именно этого Apple ID, поэтому не может переиспользоваться для
// другого аккаунта. Раньше библиотека была одна на все аккаунты сразу —
// из-за этого чужие скачанные файлы ошибочно засчитывались владением.
function getIpaCacheDirFor(email) {
  const dir = path.join(getIpaCacheDir(), safeEmail(email));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* создастся при записи */ }
  return dir;
}

// --- Запуск ipatool в песочнице конкретного аккаунта -----------------------

function ipatoolPath() {
  const packaged = path.join(process.resourcesPath || '', 'bin', 'ipatool.exe');
  const dev = path.join(__dirname, '..', 'resources', 'bin', 'ipatool.exe');
  return fs.existsSync(packaged) ? packaged : dev;
}

function homeEnvFor(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // dir всегда абсолютный windows-путь вида "X:\..."
    return { HOMEDRIVE: dir.slice(0, 2), HOMEPATH: dir.slice(2), USERPROFILE: dir };
  }
  return { HOME: dir };
}

// input  — пишется в stdin процесса.
// signal — AbortSignal; при .abort() процесс убивается (кнопка «Отмена»).
function runIpatool(email, args, { timeout = 180000, input = null, signal = undefined } = {}) {
  const cfg = loadConfig();
  const env = { ...process.env, ...homeEnvFor(accountDir(email)) };
  const full = [
    ...args,
    '--keychain-passphrase', cfg.passphrase,
    '--non-interactive',
    '--format', 'json',
  ];
  return new Promise((resolve) => {
    const cp = execFile(
      ipatoolPath(), full,
      { timeout, env, windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          exit: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          aborted: !!(err && err.name === 'AbortError'),
          // execFile сам убивает процесс по timeout (err.killed) — это не
          // отмена пользователем (AbortError) и не ответ Apple, а обрыв с
          // нашей стороны, потому что не дождались.
          timedOut: !!(err && err.killed && err.name !== 'AbortError'),
          stdout: stdout || '',
          stderr: stderr || '',
          text: `${stdout || ''}\n${stderr || ''}`,
        });
      },
    );
    try {
      if (input != null) { cp.stdin.write(input); cp.stdin.end(); }
      else { cp.stdin.end(); }
    } catch { /* stdin мог быть уже закрыт */ }
  });
}

// ipatool с --format json печатает по строке JSON на событие; берём поля из
// всех строк (последнее непустое значение выигрывает).
function parseLines(text) {
  const out = { messages: [], success: undefined, error: undefined, email: undefined, name: undefined };
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.message) out.messages.push(String(obj.message));
    if (typeof obj.success === 'boolean') out.success = obj.success;
    if (obj.error) out.error = String(obj.error);
    if (obj.email) out.email = String(obj.email);
    if (obj.name) out.name = String(obj.name);
  }
  return out;
}

// Если ipatool упал без валидной JSON-строки результата (падение/паника до
// печати финального события, антивирус прибил процесс и т.п.) — забрать
// последние непустые строки как есть, чтобы хотя бы видеть сырую причину,
// а не служебную info-строку из более раннего события.
function rawFailureTail(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== '{');
  if (!lines.length) return null;
  return lines.slice(-3).join(' | ').slice(0, 300);
}

function needs2FA(text) {
  return /2fa code is required/i.test(text)
    || /auth code is required/i.test(text)
    || /supply a code using the .*auth-code/i.test(text);
}

// Похоже на сетевую ошибку (ipatool не смог достучаться до Apple), а не на
// реальный отказ Apple по существу (неверный пароль, лимит и т.п.).
const NET_RE = /failed to send http request|failed to make round trip|dial tcp|connectex|i\/o timeout|timeout awaiting|EOF|connection reset|no such host|round trip|certificate|context deadline exceeded|tls handshake/i;

// Служебные info-строки ipatool, которые никогда не объясняют причину
// отказа — если это последнее, что успели напечатать перед быстрым обрывом
// (сеть отвалилась раньше, чем Apple вообще ответила), не показывать их
// как «ошибку входа».
const INFO_ONLY_RE = /preparing authentication/i;

// --- Индикатор доступности серверов Apple ----------------------------------
// Быстрая проверка (TLS-коннект, без реального запроса), не блокирует ли
// сеть/провайдер путь к серверу авторизации Apple (gsa.apple.com — именно
// его использует ipatool на шаге auth login/2FA). Раньше пользователь
// узнавал о блокировке только после нескольких минут ожидания ipatool —
// эта проверка даёт ответ за секунды, ДО того как запускать сам вход.
// rejectUnauthorized: false — нам не важен трастed-сертификат (антивирусы
// на Windows часто подменяют TLS своим сертификатом), важно только сам
// факт, что соединение до хоста устанавливается, а не блокируется на сети.
const APPLE_AUTH_HOST = 'gsa.apple.com';

function checkAppleReachability(host = APPLE_AUTH_HOST, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* уже закрыт */ }
      resolve(ok);
    };
    try {
      socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs, rejectUnauthorized: false });
    } catch {
      resolve(false);
      return;
    }
    socket.once('secureConnect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

// Успешен ли `auth info` — самый надёжный признак, что сессия легла.
async function loggedIn(email) {
  const info = parseLines((await runIpatool(email, ['auth', 'info'])).text);
  if (info.email || info.success === true) return { email: info.email || email, name: info.name };
  return null;
}

// --- Ограничение частоты неудачных попыток входа (по email, в памяти) ------

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failMap = new Map(); // email -> { count, firstAt }

function checkThrottle(email) {
  const rec = failMap.get(email);
  if (!rec) return null;
  if (Date.now() - rec.firstAt > FAIL_WINDOW_MS) { failMap.delete(email); return null; }
  if (rec.count >= FAIL_LIMIT) {
    const leftMin = Math.ceil((FAIL_WINDOW_MS - (Date.now() - rec.firstAt)) / 60000);
    return `Слишком много неудачных попыток входа для этого Apple ID. Подождите ~${leftMin} мин и попробуйте снова.`;
  }
  return null;
}

function noteFail(email) {
  const rec = failMap.get(email);
  if (!rec || Date.now() - rec.firstAt > FAIL_WINDOW_MS) failMap.set(email, { count: 1, firstAt: Date.now() });
  else rec.count += 1;
}

// --- Повторный запрос кода 2FA -----------------------------------------
// Легаси-авторизация Apple, которой пользуется ipatool, не даёт выбрать
// канал доставки (push / SMS): код Apple шлёт сама на доверенные
// устройства, при повторных попытках обычно добавляет SMS на доверенный
// номер. Поэтому «запросить код заново» = повторно инициировать вход без
// кода. Ограничиваем частоту, иначе Apple временно блокирует аккаунт.
const RESEND_MIN_INTERVAL_MS = 25 * 1000;
const RESEND_MAX = 4;
const codeReqMap = new Map(); // email -> { count, lastAt }

function noteCodeRequested(email) {
  codeReqMap.set(email, { count: 1, lastAt: Date.now() });
}

function checkResend(email) {
  const rec = codeReqMap.get(email);
  const now = Date.now();
  if (!rec) { codeReqMap.set(email, { count: 1, lastAt: now }); return null; }
  const since = now - rec.lastAt;
  if (since < RESEND_MIN_INTERVAL_MS) return { wait: Math.ceil((RESEND_MIN_INTERVAL_MS - since) / 1000) };
  if (rec.count >= RESEND_MAX) return { blocked: true };
  rec.count += 1;
  rec.lastAt = now;
  return null;
}

function noteSuccess(email) {
  failMap.delete(email);
  codeReqMap.delete(email);
}

// --- Публичное API для main-процесса --------------------------------------

function list() {
  const cfg = loadConfig();
  return { list: cfg.list.map((a) => ({ email: a.email, addedAt: a.addedAt })), active: cfg.active };
}

function getActive() {
  return loadConfig().active;
}

function getServerUrl() {
  return (process.env.APPIPHONE_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function setActive(email) {
  const cfg = loadConfig();
  if (!cfg.list.some((a) => a.email === email)) return { ok: false, error: 'Аккаунт не найден' };
  cfg.active = email;
  saveConfig(cfg);
  return { ok: true };
}

function rememberAccount(email) {
  const cfg = loadConfig();
  if (!cfg.list.some((a) => a.email === email)) {
    cfg.list.push({ email, addedAt: new Date().toISOString() });
  }
  cfg.active = email;
  saveConfig(cfg);
}

// Шаг входа. code необязателен — без него ipatool сам скажет, нужен ли 2FA.
// Второй аргумент log — колбэк прогресса в «Журнал» (необязателен).
async function login({ email, password, code }, log = () => {}) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!email || !password) return { ok: false, error: 'Введите Apple ID и пароль.' };

  const throttled = checkThrottle(email);
  if (throttled) return { ok: false, error: throttled };

  log(code
    ? '\nВход: отправляю код в Apple (обрабатывается локально на вашем компьютере)…\n'
    : '\nВход: запрашиваю у Apple 2FA-код (обрабатывается локально на вашем компьютере)…\n');

  // Параллельно с самим входом — быстрая (секунды) проверка, не блокирует
  // ли эта сеть путь к серверу авторизации Apple. Не мешает и не отменяет
  // сам вход (ipatool мог бы пройти другим путём/повторной попыткой) — это
  // just диагностика в «Журнал», чтобы не ждать несколько минут неясной
  // ошибки, если дело в сети.
  checkAppleReachability().then((reachable) => {
    if (!reachable) {
      log('Проверка сети: сервер авторизации Apple (gsa.apple.com) не отвечает с этого компьютера — похоже на блокировку провайдера. Попробуйте включить VPN, не дожидаясь конца попытки.\n');
    }
  });

  const args = ['auth', 'login', '-e', email, '-p', password];
  if (code) args.push('--auth-code', String(code).trim());
  // ipatool сам предупреждает: первый вход под аккаунтом может занимать
  // несколько минут (готовит anisette/GSA-сессию) — дефолтных 3 минут не
  // хватает, процесс обрывался по таймауту раньше, чем Apple успевала
  // ответить хоть чем-то (даже запросом 2FA-кода).
  const r = await runIpatool(email, args, { timeout: 600000 });

  if (needs2FA(r.text) && !code) {
    noteCodeRequested(email);
    log('Apple: код отправлен на доверенные устройства.\n');
    return { ok: false, need2FA: true };
  }

  const ok = await loggedIn(email);
  if (ok) {
    noteSuccess(email);
    rememberAccount(email);
    log('Вход выполнен.\n');
    return { ok: true, email: ok.email, name: ok.name };
  }

  noteFail(email);
  let msg;
  if (r.timedOut) {
    // Не настоящий отказ Apple — просто не дождались ответа. Раньше сюда
    // просачивалась служебная info-строка ipatool ("preparing
    // authentication...") и выглядела как ошибка входа.
    msg = 'Apple долго отвечает на первый вход этого аккаунта — это нормально, вход обрабатывается локально на вашем компьютере и может занять несколько минут. Попробуйте войти ещё раз.';
  } else if (NET_RE.test(r.text)) {
    // ipatool упал быстро (секунды-десятки секунд) с сетевой ошибкой — до
    // Apple запрос вообще не дошёл. Частая причина в РФ — провайдер
    // блокирует/режет доступ к серверам авторизации Apple без VPN.
    msg = 'Не получилось связаться с серверами Apple с этого компьютера и этой сети (это не отказ по паролю или коду). Проверьте интернет, попробуйте через VPN, и что антивирус/файрвол не блокирует эту программу.';
  } else {
    const parsed = parseLines(r.text);
    let lastMsg = parsed.messages[parsed.messages.length - 1];
    if (lastMsg && INFO_ONLY_RE.test(lastMsg)) lastMsg = undefined;
    const raw = !parsed.error && !lastMsg ? rawFailureTail(r.text) : null;
    msg = parsed.error || lastMsg || (raw ? `Обработка входа завершилась без ответа Apple: ${raw}` : 'Не удалось войти. Проверьте Apple ID, пароль и код.');
    if (code && needs2FA(r.text)) msg = 'Код подтверждения не подошёл или истёк. Запросите новый и попробуйте снова.';
  }
  // Сообщение об ошибке дублируем в «Журнал» — раньше оно было видно только
  // в баннере рядом с кнопкой и пропадало без следа, если пользователь не
  // успел его сфотографировать до следующей попытки.
  log(`\nОшибка входа: ${msg}\n`);
  // На шаге с кодом остаёмся на экране 2FA (не выкидываем на ввод пароля).
  return code ? { ok: false, need2FA: true, error: msg } : { ok: false, error: msg };
}

// Повторно попросить Apple прислать код 2FA (кнопка «Запросить код заново
// / по SMS»). Возвращает need2FA + notice — код всё равно вводится отдельно.
async function requestCode({ email, password }, log = () => {}) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!email || !password) return { ok: false, error: 'Данные для входа потерялись — нажмите «Начать заново».' };

  const throttled = checkThrottle(email);
  if (throttled) return { ok: false, error: throttled };

  const rs = checkResend(email);
  if (rs && rs.wait) return { ok: false, need2FA: true, notice: `Код уже запрошен. Повторить можно через ${rs.wait} с.` };
  if (rs && rs.blocked) {
    return {
      ok: false,
      need2FA: true,
      notice: 'Код запрошен много раз. Возьми код на доверенном устройстве (Настройки → имя → «Вход и безопасность» → «Получить проверочный код») или подожди пару минут.',
    };
  }

  log('\nЗапрашиваю у Apple новый 2FA-код (обрабатывается локально на вашем компьютере)…\n');
  checkAppleReachability().then((reachable) => {
    if (!reachable) {
      log('Проверка сети: сервер авторизации Apple (gsa.apple.com) не отвечает с этого компьютера — похоже на блокировку провайдера. Попробуйте включить VPN, не дожидаясь конца попытки.\n');
    }
  });
  const r = await runIpatool(email, ['auth', 'login', '-e', email, '-p', password], { timeout: 600000 });

  if (needs2FA(r.text)) {
    return { ok: false, need2FA: true, notice: 'Код запрошен заново — проверь доверенное устройство и SMS.' };
  }

  const ok = await loggedIn(email);
  if (ok) {
    noteSuccess(email);
    rememberAccount(email);
    return { ok: true, email: ok.email, name: ok.name };
  }

  if (r.timedOut) {
    return { ok: false, error: 'Apple долго отвечает — попробуйте запросить код ещё раз через минуту.' };
  }
  if (NET_RE.test(r.text)) {
    return { ok: false, error: 'Не получилось связаться с серверами Apple с этого компьютера и этой сети. Проверьте интернет, попробуйте через VPN, и что антивирус/файрвол не блокирует эту программу.' };
  }
  const parsed = parseLines(r.text);
  let lastMsg = parsed.messages[parsed.messages.length - 1];
  if (lastMsg && INFO_ONLY_RE.test(lastMsg)) lastMsg = undefined;
  const raw = !parsed.error && !lastMsg ? rawFailureTail(r.text) : null;
  const msg = parsed.error || lastMsg || (raw ? `Обработка завершилась без ответа Apple: ${raw}` : 'Не удалось запросить код заново.');
  log(`\nОшибка: ${msg}\n`);
  return { ok: false, error: msg };
}

async function remove(email) {
  const cfg = loadConfig();
  cfg.list = cfg.list.filter((a) => a.email !== email);
  if (cfg.active === email) cfg.active = cfg.list[0] ? cfg.list[0].email : null;
  saveConfig(cfg);
  try { await runIpatool(email, ['auth', 'revoke'], { timeout: 30000 }); } catch { /* не критично */ }
  try { fs.rmSync(accountDir(email), { recursive: true, force: true }); } catch { /* не критично */ }
  return { ok: true, active: cfg.active };
}

module.exports = {
  list, getActive, setActive, login, requestCode, remove, runIpatool, accountDir, NET_RE,
  getServerUrl, DEFAULT_SERVER_URL,
  getIpaCacheDir, setIpaCacheDir, defaultIpaCacheDir, getIpaCacheDirFor,
  checkAppleReachability,
};
