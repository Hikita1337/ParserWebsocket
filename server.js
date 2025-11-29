// server.js — Crash Parser (WebSocket) с расширенной диагностикой и /abc
// Установка: npm i ws node-fetch

import WebSocket from "ws";
import http from "http";
import fetch from "node-fetch";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash";
const PORT = Number(process.env.PORT || 10000);

// ----------------- Настройки диагностики -----------------
const WS_BUFFER_SIZE = 500;        // количество последних raw сообщений для отладки
const SNAPSHOT_MESSAGES = 200;     // сколько raw сообщений сохранять в каждом critical snapshot
const MAX_SNAPSHOTS = 200;         // сколько снимков хранить максимум
// --------------------------------------------------------

let ws = null;
let running = true;
let sessionStartTs = null;
let lastPongTs = null;

let currentGame = {
  gameId: null,
  status: null,
  delta: null,
  players: {},
};

let collectingBets = true; // Всегда включается сразу после очистки кэша игры

const logs = [];
const finishedGames = [];

// --- Диагностические структуры ---
const wsMessagesBuffer = []; // кольцевой буфер raw входящих сообщений { ts, raw }
const criticalSnapshots = []; // массив снимков { id, gameId, type: 'status_1to2'|'crash', ts, messages: [...] }

function nowIso(){ return new Date().toISOString(); }

function pushLog(type, extra = {}) {
  const entry = { type, ts: nowIso(), ...extra };
  logs.push(entry);
  if (logs.length > 2000) logs.shift();
  console.log(`[${type}]`, extra);
}

function pushRawWsFrame(raw) {
  try {
    const entry = { ts: nowIso(), raw: (typeof raw === "string") ? raw : raw.toString() };
    wsMessagesBuffer.push(entry);
    if (wsMessagesBuffer.length > WS_BUFFER_SIZE) wsMessagesBuffer.shift();
  } catch (e) {
    // не смертельно
    pushLog("RAW_BUFFER_ERR", { error: String(e) });
  }
}

function saveCriticalSnapshot(kind, gameId = null) {
  // делаем копию последних сообщений
  const slice = wsMessagesBuffer.slice(-SNAPSHOT_MESSAGES);
  const snap = {
    id: `${kind}-${gameId || 'nogid'}-${Date.now()}`,
    gameId,
    type: kind,
    ts: nowIso(),
    messages: slice
  };
  criticalSnapshots.unshift(snap);
  if (criticalSnapshots.length > MAX_SNAPSHOTS) criticalSnapshots.pop();
  pushLog("SNAPSHOT_SAVED", { id: snap.id, gameId, type: kind, savedMessages: slice.length });
}

// ----------------- fetch token -----------------
async function fetchToken(){
  try {
    const r = await fetch(TOKEN_URL);
    const j = await r.json();
    return j?.data?.main?.centrifugeToken || null;
  } catch (e) {
    pushLog("TOKEN_FETCH_ERR", { error: String(e) });
    return null;
  }
}

function colorForCrash(c){
  if (c < 1.2) return "red";
  if (c < 2) return "blue";
  if (c < 4) return "pink";
  if (c < 8) return "green";
  if (c < 25) return "yellow";
  return "gradient";
}

// локальные флаги
let sentPlayersToAI = false;
let sentDeltaStartHUD = false;

// ----------------- Обработка ставок -----------------
function handleBet(bet){
  if (!bet?.user?.id) return;
  if (!collectingBets) return;
  if (currentGame.status !== 1) return;  // ПРИНИМАЕМ ТОЛЬКО НА status=1

  const id = bet.user.id;
  const sum = Number(bet.deposit?.amount || 0);
  const auto = bet.coefficientAuto ?? null;

  if (!currentGame.players[id]) {
    currentGame.players[id] = {
      userId: id,
      name: bet.user.name,
      sum,
      lastCoefficientAuto: auto
    };
  } else {
    currentGame.players[id].sum += sum;
    currentGame.players[id].lastCoefficientAuto = auto;
  }
}

// ----------------- Обновление статуса игры -----------------
function handleUpdate(data){
  const prevStatus = currentGame.status;

  if (data.id) currentGame.gameId = data.id;

  if (typeof data.status === "number") {
    currentGame.status = data.status;
  }

  if (typeof data.delta === "number") {
    currentGame.delta = data.delta;
  }

  // Логируем момент перехода 1 -> 2 ровно один раз (и сохраняем snapshot)
  if (prevStatus === 1 && currentGame.status === 2) {
    pushLog("STATUS_TRANSITION", { from: prevStatus, to: currentGame.status, gameId: currentGame.gameId });
    // Сохраняем снимок (включая raw сообщения вокруг момента)
    saveCriticalSnapshot("status_1to2", currentGame.gameId);
  }

  if (currentGame.status === 2) {
    if (!sentPlayersToAI) {
      const totalPlayers = Object.keys(currentGame.players).length;
      const totalDeposit = Object.values(currentGame.players).reduce((s,p)=>s+p.sum,0);

      pushLog("SEND_TO_AI", {
        gameId: currentGame.gameId,
        totalPlayers,
        totalDeposit
      });

      sentPlayersToAI = true;
    }

    if (!sentDeltaStartHUD) {
      pushLog("HUD_DELTA_START", { delta: currentGame.delta });
      sentDeltaStartHUD = true;
    }
  }
}

// ----------------- Финализация игры -----------------
function finalizeGame(data){
  const crash = Number(data.crash);
  const gameId = data.gameId || currentGame.gameId;
  const color = colorForCrash(crash);

  const playersArr = Object.values(currentGame.players);
  const totalPlayers = playersArr.length;
  const totalDeposit = playersArr.reduce((s,p)=>s+p.sum,0);

  pushLog("CRASH_DETECTED", { gameId, crash, color, totalPlayers, totalDeposit });

  // Сохраняем snapshot на момент краша
  saveCriticalSnapshot("crash", gameId);

  const finalRecord = {
    gameId,
    crash,
    color,
    players: playersArr,
    totalPlayers,
    totalDeposit,
    ts: nowIso()
  };

  finishedGames.unshift(finalRecord);
  if (finishedGames.length > 100) finishedGames.pop();

  pushLog("DB_SAVE", { gameId, players: totalPlayers });

  // --- Очистка игры ---
  currentGame = {
    gameId: null,
    status: null,
    delta: null,
    players: {},
  };

  sentPlayersToAI = false;
  sentDeltaStartHUD = false;

  // --- Снова готовы собирать ставки ---
  collectingBets = true;
  pushLog("NEW_GAME", { msg: "Bets collection enabled after cache clear" });
}

// ----------------- Robust parsing (маленькая защита) -----------------
function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

// Разбираем возможные батчи JSON в одном фрейме.
// Возвращаем массив парсенных объектов (часто это объекты с push)
function parsePossibleBatch(raw) {
  // already object
  if (typeof raw === 'object' && raw !== null) return [raw];

  const s = raw.toString();
  const single = tryParseJSON(s);
  if (single) return [single];

  // Простая эвристика: сканируем по балансировке фигурных скобок
  const res = [];
  let depth = 0;
  let start = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== null) {
        const piece = s.slice(start, i+1);
        const p = tryParseJSON(piece);
        if (p) res.push(p);
        start = null;
      }
    }
  }
  return res;
}

// ----------------- Обработка входящих сообщений -----------------
function onPush(msg){
  const data = msg.push?.pub?.data;
  if (!data) return;

  const type = data.type;

  if (type === "crash") {
    return finalizeGame(data);
  }

  if (type === "update") {
    return handleUpdate(data);
  }

  if (type === "betCreated") {
    return handleBet(data.bet);
  }

  // Игнорируем: topBetCreated, changeStatistic, start и т.д.
}

// ----------------- WebSocket attach -----------------
function attachWs(ws) {
  ws.on("open", async () => {
    sessionStartTs = Date.now();
    pushLog("WS_OPEN");
    const token = await fetchToken();
    try {
      ws.send(JSON.stringify({ id:1, connect:{ token, subs:{} } }));
      setTimeout(()=> ws.send(JSON.stringify({ id:100, subscribe:{ channel:CHANNEL } })), 200);
    } catch (e) {
      pushLog("WS_SEND_ERR", { error: String(e) });
    }
  });

  ws.on("message", raw => {
    // Сохраняем raw сообщение в диагностике
    try {
      pushRawWsFrame(raw);
    } catch (e) {
      pushLog("RAW_SAVE_ERR", { error: String(e) });
    }

    // Пытаемся распарсить (возможно в одном фрейме несколько JSON)
    const parsedList = parsePossibleBatch(raw);

    if (!parsedList || parsedList.length === 0) {
      // Иногда сервер посылает пустой объект {} как ping — отвечаем keepalive
      try {
        ws.send(JSON.stringify({ type: 3 }));
        lastPongTs = Date.now();
      } catch (e) {
        pushLog("KEEPALIVE_SEND_ERR", { error: String(e) });
      }
      pushLog("UNPARSED_FRAME", { preview: raw.toString().slice(0,200) });
      return;
    }

    for (const p of parsedList) {
      try {
        if (p?.push) {
          onPush(p);
        } else {
          // Некоторые фреймы могут быть обёрнуты иначе — пытаемся найти push внутри
          if (p.push) onPush(p);
          else {
            // сканируем по полям
            for (const k in p) {
              if (p[k] && p[k].push) onPush(p[k]);
            }
          }
        }
      } catch (e) {
        pushLog("ONPUSH_ERR", { error: String(e), preview: JSON.stringify(p).slice(0,200) });
      }
    }
  });

  ws.on("pong", () => lastPongTs = Date.now());
  ws.on("close", () => pushLog("WS_CLOSE"));
  ws.on("error", e => pushLog("WS_ERROR", { error: String(e) }));
}

// ----------------- Loop -----------------
async function loop() {
  while (running) {
    try {
      ws = new WebSocket(WS_URL);
      attachWs(ws);
      await new Promise(res => ws.once("close", res));
    } catch (e) {
      pushLog("WS_LOOP_ERR", { error: String(e) });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ----------------- HTTP endpoints -----------------
http.createServer((req, res) => {
  if (req.url === "/game/history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: finishedGames.length, games: finishedGames }, null, 2));
    return;
  }

  if (req.url === "/abc") {
    // Возвращаем последние снимки и последние raw сообщений
    res.writeHead(200, { "Content-Type": "application/json" });
    const out = {
      serverTime: nowIso(),
      lastSnapshotsCount: criticalSnapshots.length,
      snapshots: criticalSnapshots.slice(0, 50),     // по умолчанию отдаём первые 50 кратких
      lastRawFrames: wsMessagesBuffer.slice(-100)    // даём последние 100 raw фреймов
    };
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  if (req.url === "/debug/logs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs: logs.slice(-200) }, null, 2));
    return;
  }

  if (req.url === "/dd") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Shutting down...\n");
    running = false;
    try { if (ws) ws.close(); } catch(e) {}
    setTimeout(() => process.exit(0), 500);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(PORT, () => console.log("HTTP listen", PORT));


loop();

// ----------------- keep-alive ping для Render (если нужно) -----------------
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://parserwebsocket.onrender.com" ;
function keepAlive() {
  if (!SELF_URL) return;
  const delay = 240000 + Math.random() * 120000; // 4–6 минут
  setTimeout(async () => {
    try {
      await fetch(SELF_URL + "/healthz", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-Keep-Alive": String(Math.random()),
        },
      });
      pushLog("KEEPALIVE_PING_OK");
    } catch (e) {
      pushLog("KEEPALIVE_PING_ERR", { error: e.message });
    }
    keepAlive();
  }, delay);
}
keepAlive();
