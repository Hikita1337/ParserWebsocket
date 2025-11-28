// server.js — Crash Parser (robust message parsing + heartbeat)
// Установка: npm i ws node-fetch

import WebSocket from "ws";
import http from "http";
import fetch from "node-fetch";

const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash";
const PORT = Number(process.env.PORT || 10000);

let ws = null;
let running = true;
let sessionStartTs = null;
let lastPongTs = null;

let currentGame = {
  gameId: null,
  status: null,
  delta: null,
  players: {}
};

let collectingBets = true;
const finishedGames = [];
const logs = [];

function nowIso(){ return new Date().toISOString(); }
function pushLog(type, extra = {}) {
  const entry = { type, ts: nowIso(), ...extra };
  logs.push(entry);
  if (logs.length > 2000) logs.shift();
  console.log(`[${type}]`, extra);
}

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

let sentPlayersToAI = false;
let sentDeltaLogForHUD = false;

// --- Bet handling ---
function handleBet(bet){
  if (!bet?.user?.id) return;
  if (!collectingBets) return;
  if (Number(bet.status) !== 1) return;

  if (currentGame.status !== 1) {
    currentGame.status = 1;
    pushLog("INFER_STATUS_1", { fromBetId: bet.id, gameId: bet.gameId });
  }

  if (!currentGame.gameId && bet.gameId) currentGame.gameId = bet.gameId;

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

// --- Update handling ---
function handleUpdate(data){
  if (data.id) currentGame.gameId = data.id;
  if (typeof data.status === "number") currentGame.status = data.status;
  if (typeof data.delta === "number") currentGame.delta = data.delta;

  if (currentGame.status === 2) {
    if (!sentPlayersToAI) {
      const arr = Object.values(currentGame.players);
      const totalPlayers = arr.length;
      const totalDeposit = arr.reduce((s,p)=>s+p.sum,0);

      pushLog("SEND_TO_AI", { gameId: currentGame.gameId, totalPlayers, totalDeposit });
      sentPlayersToAI = true;
    }

    if (!sentDeltaLogForHUD) {
      pushLog("HUD_DELTA_START", { delta: currentGame.delta });
      sentDeltaLogForHUD = true;
    }
  }
}

// --- Finalize game ---
function finalizeGame(data){
  const crash = Number(data.crash);
  const gameId = data.gameId || data.id || currentGame.gameId;
  const color = colorForCrash(crash);

  const playersArr = Object.values(currentGame.players);
  const totalPlayers = playersArr.length;
  const totalDeposit = playersArr.reduce((s,p)=>s+p.sum,0);

  pushLog("FINALIZE_GAME", { gameId, crash, color, totalPlayers, totalDeposit });

  const final = { gameId, crash, color, players: playersArr, totalPlayers, totalDeposit, ts: nowIso() };

  // Заглушка: записать в БД здесь (заменить на свою функцию)
  // saveGame(final)

  finishedGames.unshift(final);
  if (finishedGames.length > 100) finishedGames.pop();

  // Очистка кэша
  currentGame = { gameId: null, status: null, delta: null, players: {} };
  sentPlayersToAI = false;
  sentDeltaLogForHUD = false;

  // Включаем сбор ставок для новой игры
  collectingBets = true;
  pushLog("NEW_GAME_READY", { msg: "Cache cleared, collecting bets enabled" });
}

// --- Robust parse for multiple JSON objects in one frame ---
function parsePossibleBatch(raw){
  const results = [];
  if (typeof raw === 'object' && raw !== null) {
    results.push(raw);
    return results;
  }

  let s = raw.toString();

  try {
    const parsed = JSON.parse(s);
    results.push(parsed);
    return results;
  } catch (e) {
    // continue to fragment extraction
  }

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
        try {
          const parsed = JSON.parse(piece);
          results.push(parsed);
        } catch (e) {
          // debug, but keep processing
          pushLog("PARSE_FRAGMENT_FAIL", { fragmentPreview: piece.slice(0,200) });
        }
        start = null;
      }
    }
  }

  if (results.length === 0) {
    // best-effort detection for common push envelope
    const re = /\{\"push\":\{.*?\}\}\}/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      try {
        const parsed = JSON.parse(m[0]);
        results.push(parsed);
      } catch (e) {}
    }
  }

  return results;
}

// --- Process one push object ---
function onPushSingle(pushObj){
  const data = pushObj.pub?.data;
  if (!data) return;
  const type = data.type;

  if (type === "crash" || type === "end") {
    finalizeGame(data);
    return;
  }
  if (type === "update") {
    handleUpdate(data);
    return;
  }
  if (type === "betCreated") {
    handleBet(data.bet);
    return;
  }
  // ignore other types (topBetCreated, changeStatistic, etc.)
}

// --- High-level onPush that scans nested envelopes ---
function onPush(p){
  if (!p) return;
  if (p.push && p.push.pub && p.push.pub.data) {
    onPushSingle(p.push);
    return;
  }

  const scan = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.push && obj.push.pub && obj.push.pub.data) {
      onPushSingle(obj.push);
    } else {
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj,k) && typeof obj[k] === 'object') {
          scan(obj[k]);
        }
      }
    }
  };
  scan(p);
}

// --- Attach WS with heartbeat recovery ---
function attachWs(ws){
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

  ws.on("message", d => {
    // Try robust parse
    const parsedList = parsePossibleBatch(d);

    // If nothing parsed, we still reply with keepalive to avoid server closing
    if (parsedList.length === 0) {
      // Some servers send an empty object as ping: {}
      try {
        // respond with type:3 (centrifuge ping/pong semantics)
        ws.send(JSON.stringify({ type: 3 }));
        lastPongTs = Date.now();
      } catch (e) {
        pushLog("WS_PONG_SEND_ERR", { error: String(e) });
      }
      pushLog("UNPARSED_WS_FRAME", { preview: d.toString().slice(0,200) });
      return;
    }

    for (const p of parsedList) {
      try {
        if (p?.push) {
          onPush(p);
        } else {
          onPush(p);
        }
      } catch (e) {
        pushLog("ONPUSH_ERR", { error: String(e), preview: JSON.stringify(p).slice(0,200) });
      }
    }
  });

  // Some servers use WebSocket pong frames; keep track
  ws.on("pong", ()=> lastPongTs = Date.now());

  // If server sends an empty JSON object as a keepalive, it will appear parsed as {}
  // In some runs we receive that as parsed object; respond to it:
  // (Handled above in parse branch when parsedList is empty we send type:3)

  ws.on("close", (code, reason) => {
    pushLog("WS_CLOSE", { code, reason: reason && reason.toString ? reason.toString() : reason });
  });
  ws.on("error", e => pushLog("WS_ERROR", { error: String(e) }));
}

// --- main loop ---
async function loop(){
  while (running){
    try{
      ws = new WebSocket(WS_URL);
      attachWs(ws);
      await new Promise(res=>ws.once("close",res));
    } catch (e) {
      pushLog("WS_LOOP_ERR", { error: String(e) });
    }
    // backoff before reconnect
    await new Promise(r=>setTimeout(r,2000));
  }
}

http.createServer((req, res) => {
  if (req.url === "/game/history") {
    res.end(JSON.stringify({ count: finishedGames.length, games: finishedGames }, null, 2));
    return;
  }

  if (req.url === "/debug/logs") {
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

  res.end("ok");
}).listen(PORT, () => console.log("HTTP listen", PORT));

loop();