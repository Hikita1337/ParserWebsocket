// server.js — Crash Parser (WebSocket)
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

let collectingBets = true; // Всегда включается сразу после очистки кэша игры

const logs = [];
const finishedGames = [];

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


// --- Обновление статуса игры ---
function handleUpdate(data){
  if (data.id) currentGame.gameId = data.id;

  if (typeof data.status === "number") {
    currentGame.status = data.status;
  }

  if (typeof data.delta === "number") {
    currentGame.delta = data.delta;
  }

  if (currentGame.status === 2) {
    if (!sentPlayersToAI) {
      const totalPlayers = Object.keys(currentGame.players).length;
      const totalDeposit = Object.values(currentGame.players).reduce((s,p)=>s+p.sum,0);

      console.log(`[AI] Players collected: players=${totalPlayers} sum=${totalDeposit}`);
      pushLog("SEND_TO_AI", {
        gameId: currentGame.gameId,
        totalPlayers,
        totalDeposit
      });

      sentPlayersToAI = true;
    }

    if (!sentDeltaStartHUD) {
      console.log(`[HUD] Delta START: ${currentGame.delta}`);
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

  console.log(`[AI] Crash: game=${gameId} x${crash} color=${color}`);
  console.log(`[HUD] Crash => x${crash}`);

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
  if (finishedGames.length > 50) finishedGames.pop();

  console.log(`[DB] Game saved: players=${totalPlayers}`);

  // --- Очистка игры ---
  currentGame = {
    gameId: null,
    status: null,
    delta: null,
    players: {}
  };

  sentPlayersToAI = false;
  sentDeltaStartHUD = false;

  // --- Снова готовы собирать ставки ---
  collectingBets = true;
  console.log("[NEW_GAME] Bets collection enabled");
}


// --- Обработка входящих сообщений ---
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

  // Игнорируем:
  //  topBetCreated
  //  changeStatistic
  //  start
  //  other stuff
}


// --- Подключение WS ---
function attachWs(ws){
  ws.on("open", async () => {
    sessionStartTs = Date.now();
    pushLog("WS_OPEN");

    const token = await fetchToken();
    ws.send(JSON.stringify({ id:1, connect:{ token, subs:{} } }));

    setTimeout(()=>{
      ws.send(JSON.stringify({ id:100, subscribe:{ channel:CHANNEL } }));
    },200);
  });

  ws.on("message", d => {
    let p; try { p = JSON.parse(d); } catch {}
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

http.createServer((req, res) => {
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

// =============================
//       KEEP-ALIVE FOR RENDER
// =============================
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

      console.log("Keep-alive ping OK");
    } catch (e) {
      console.log("Keep-alive error:", e.message);
    }

    keepAlive();
  }, delay);
}

keepAlive();