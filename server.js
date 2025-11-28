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
  players: {},
  totalPlayers: 0,
  totalDeposit: 0,
  delta: null
};

let collectingBets = false; // <--- ВАЖНО: флаг включения сбора ставок

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

// ЛОГИРОВАНИЕ
let sentPlayersToAI = false;
let sentDeltaLogForHUD = false;
let startedStatus1Log = false;


// --- Обработка ставки ---
function handleBet(bet){
  if (!bet?.user?.id) return;

  if (!collectingBets) return; // <--- Гарантия: собираем только в статусе 1

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
    // Сайт НЕ даёт ставить повторно, но оставляю на всякий
    currentGame.players[id].sum += sum;
    currentGame.players[id].lastCoefficientAuto = auto;
  }

  if (!startedStatus1Log) {
    console.log("[STATUS1] Собираю игроков");
    startedStatus1Log = true;
  }
}


// --- Обновление статуса игры ---
function handleUpdate(data){
  if (data.id) currentGame.gameId = data.id;

  if (typeof data.status === "number") {
    currentGame.status = data.status;

    // ВКЛЮЧЕНИЕ/ВЫКЛЮЧЕНИЕ СБОРА СТАВОК
    if (data.status === 1) {
      collectingBets = true;     // ← включаем сбор ставок
    } else {
      collectingBets = false;    // ← выключаем
    }
  }

  if (typeof data.delta === "number") currentGame.delta = data.delta;

  if (currentGame.status !== 1) startedStatus1Log = false;

  // Когда статус 1 → 2 — отправляем игроков
  if (currentGame.status === 2 && !sentPlayersToAI) {
    const arr = Object.values(currentGame.players);
    const totalPlayers = arr.length;
    const totalDeposit = arr.reduce((s,p)=>s+p.sum,0);

    console.log(`[AI] Игроки собраны | количество: ${totalPlayers} | сумма ставок: ${totalDeposit}`);

    pushLog("SEND_TO_AI", {
      gameId: currentGame.gameId,
      message: "Игроки собраны",
      totalPlayers,
      totalDeposit
    });

    sentPlayersToAI = true;
  }

  if (currentGame.status === 2 && !sentDeltaLogForHUD) {
    console.log(`[HUD] delta START => ${currentGame.delta}`);
    pushLog("HUD_DELTA_START", { delta: currentGame.delta });
    sentDeltaLogForHUD = true;
  }
}


// --- Финализация игры ---
function finalizeGame(data){
  const gameId = data.id || data.gameId || currentGame.gameId;
  const crash = data.crash;
  const color = colorForCrash(crash);

  const playersArr = Object.values(currentGame.players);
  const totalPlayers = playersArr.length;
  const totalDeposit = playersArr.reduce((s,p)=>s+p.sum,0);

  console.log(`[AI] game=${gameId} crash=${crash} color=${color} + [HUD] crash=${crash}`);

  const final = {
    gameId,
    crash,
    color,
    players: playersArr,
    totalPlayers,
    totalDeposit,
    ts: nowIso()
  };

  console.log(`[DB] Игра сохранена game=${gameId} crash=${crash} players=${totalPlayers} totalDeposit=${totalDeposit}`);

  finishedGames.unshift(final);
  if (finishedGames.length > 1) finishedGames.pop();

  // Полный сброс состояния игры
  currentGame = { gameId: null, status: null, players: {}, totalPlayers: 0, totalDeposit: 0, delta: null };
  sentPlayersToAI = false;
  sentDeltaLogForHUD = false;
  startedStatus1Log = false;
  collectingBets = false;
}


// --- Обработка входящих сообщений WebSocket ---
function onPush(msg){
  const data = msg.push?.pub?.data;
  if (!data) return;

  const type = data.type;

  if (type === "crash" || type === "end") return finalizeGame(data);

  if (type === "update") return handleUpdate(data);

  // Ставки идут ТОЛЬКО из betCreated
  if (type === "betCreated" && collectingBets) {
    handleBet(data.bet);
  }
}


// --- Подключение WebSocket ---
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