// server.js — Crash Parser (WebSocket) + RAW DIAGNOSTIC LOGS
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
  players: {},
};

let collectingBets = true;

const logs = [];
const finishedGames = [];

// ===== RAW DIAGNOSTIC STORAGE =====
const rawGameLogs = []; // [{ gameId, messages: [...] }]
const RAW_LIMIT = 5000; // max messages per game
let recordingRaw = false;

function saveRaw(raw) {
  if (!recordingRaw) return;
  const txt = raw.toString();
  const active = rawGameLogs[0];
  if (!active) return;
  active.messages.push({ ts: nowIso(), raw: txt });
  if (active.messages.length > RAW_LIMIT) active.messages.shift();
}

function startRecording(gameId) {
  recordingRaw = true;
  rawGameLogs.unshift({ gameId, messages: [] });
  if (rawGameLogs.length > 2) rawGameLogs.pop();
  pushLog("RAW_ON", { gameId });
}

function stopRecording() {
  if (!recordingRaw) return;
  recordingRaw = false;
  pushLog("RAW_OFF");
}

// ===================================

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
  } catch {
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
let sentDeltaStartHUD = false;

// --- Обработка ставок ---
function handleBet(bet){
  if (!bet?.user?.id) return;
  if (!collectingBets) return;
  if (currentGame.status !== 1) return;

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


// --- Обновление статуса игры ---
function handleUpdate(data){
  const prev = currentGame.status;

  if (data.id) currentGame.gameId = data.id;
  if (typeof data.status === "number") currentGame.status = data.status;
  if (typeof data.delta === "number") currentGame.delta = data.delta;

  // STOP RAW RECORDING on status=2
  if (prev === 1 && currentGame.status === 2) {
    stopRecording();
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


// --- Финализация игры ---
function finalizeGame(data){
  const crash = Number(data.crash);
  const gameId = data.gameId || currentGame.gameId;
  const color = colorForCrash(crash);

  const playersArr = Object.values(currentGame.players);
  const totalPlayers = playersArr.length;
  const totalDeposit = playersArr.reduce((s,p)=>s+p.sum,0);

  pushLog("CRASH", { gameId, crash, color, totalPlayers });

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
  if (finishedGames.length > 1) finishedGames.pop();

  // RESET GAME
  currentGame = {
    gameId: null,
    status: null,
    delta: null,
    players: {}
  };

  sentPlayersToAI = false;
  sentDeltaStartHUD = false;
  collectingBets = true;

  // ENABLE RAW FOR NEXT GAME
  startRecording(gameId);
}


// --- WS PUSH Handler ---
function onPush(msg){
  const data = msg.push?.pub?.data;
  if (!data) return;

  const type = data.type;

  if (type === "crash") return finalizeGame(data);
  if (type === "update") return handleUpdate(data);
  if (type === "betCreated") return handleBet(data.bet);
}


// --- WS attach ---
function attachWs(ws){
  ws.on("open", async () => {
    sessionStartTs = Date.now();
    pushLog("WS_OPEN");

    const token = await fetchToken();
    ws.send(JSON.stringify({ id:1, connect:{ token, subs:{} } }));
    setTimeout(()=> ws.send(JSON.stringify({ id:100, subscribe:{ channel:CHANNEL } })), 200);
  });

  ws.on("message", raw => {
    saveRaw(raw);

    let p; try { p = JSON.parse(raw); } catch {}
    if (p?.push) return onPush(p);

    if (p && Object.keys(p).length === 0) {
      ws.send(JSON.stringify({ type:3 }));
      lastPongTs = Date.now();
    }
  });

  ws.on("pong", ()=> lastPongTs = Date.now());
  ws.on("close", ()=> pushLog("WS_CLOSE"));
  ws.on("error", e=> pushLog("WS_ERROR",{error:String(e)}));
}


// --- WS Loop ---
async function loop(){
  while (running){
    try{
      ws = new WebSocket(WS_URL);
      attachWs(ws);
      await new Promise(res=>ws.once("close",res));
    } catch {}
    await new Promise(r=>setTimeout(r,2000));
  }
}


// --- HTTP Server ---
http.createServer((req, res) => {

  if (req.url === "/abc") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      serverTime: nowIso(),
      rawGameLogs
    }, null, 2));
  }

  if (req.url === "/game/history") {
    res.end(JSON.stringify({ count: finishedGames.length, games: finishedGames }, null, 2));
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

// RENDER keep alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://parserwebsocket.onrender.com" ;

function keepAlive() {
  if (!SELF_URL) return;
  const delay = 240000 + Math.random() * 120000;
  setTimeout(async () => {
    try {
      await fetch(SELF_URL + "/healthz", {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "X-Keep-Alive": String(Math.random()),
        },
      });
      console.log("Keep-alive ping OK");
    } catch (e) {
      console.log("Keep-alive error:", e.message);
    }
    keepAlive();
  }, delay);
}
keepAlive();