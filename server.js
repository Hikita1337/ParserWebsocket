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

// Флаги для логов
let sentPlayersToAI = false;
let sentDeltaLogForHUD = false;
let startedStatus1Log = false;

function handleBet(bet){
  if (!bet?.user?.id) return;
  const id = bet.user.id;
  const sum = Number(bet.deposit?.amount || 0);
  const auto = bet.coefficientAuto ?? null;

  // Статус 1 — выводим лог "Собираю людей" только один раз
  if (currentGame.status === 1 && !startedStatus1Log) {
    console.log("[STATUS1] Собираю людей");
    startedStatus1Log = true;
  }

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

function handleUpdate(data){
  if (data.id) currentGame.gameId = data.id;
  if (typeof data.status === "number") currentGame.status = data.status;
  if (typeof data.delta === "number") currentGame.delta = data.delta;

  // Сброс флага при выходе из статуса 1
  if (currentGame.status !== 1) startedStatus1Log = false;

  // Статус 1 → 2 впервые
  if (currentGame.status === 2 && !sentPlayersToAI) {
    const arr = Object.values(currentGame.players);
    const totalPlayers = arr.length;
    const totalDeposit = arr.reduce((s,p)=>s+p.sum,0);

    // Логируем только агрегированно
    console.log(`[AI] Игроки найдены | количество: ${totalPlayers} | сумма ставок: ${totalDeposit}`);

    pushLog("SEND_TO_AI", {
        gameId: currentGame.gameId,
        message: "Игроки собраны",
        totalPlayers,
        totalDeposit
    });
    
    sentPlayersToAI = true;
  }

  // Статус 2 — дельта HUD один раз
  if (currentGame.status === 2 && !sentDeltaLogForHUD) {
    console.log(`[HUD] delta START => ${currentGame.delta}`);
    pushLog("HUD_DELTA_START", { delta: currentGame.delta });
    sentDeltaLogForHUD = true;
  }
}

function finalizeGame(data){
  const gameId = data.id || data.gameId || currentGame.gameId;
  const crash = data.crash;
  const color = colorForCrash(crash);

  const playersArr = Object.values(currentGame.players);
  const totalPlayers = playersArr.length;
  const totalDeposit = playersArr.reduce((s,p)=>s+p.sum,0);

  // Отправка AI + HUD в одну строку
  console.log(`[AI] game=${gameId} crash=${crash} color=${color} + [HUD] crash=${crash}`);

  // Подготовка объекта для базы
  const final = {
    gameId,
    crash,
    color,
    players: playersArr,
    totalPlayers,
    totalDeposit,
    ts: nowIso()
  };

  // Заглушка сохранения в базу
  // saveToDB(final);
  console.log(`[DB] Игра сохранена game=${gameId} crash=${crash} players=${totalPlayers} totalDeposit=${totalDeposit}`);

  finishedGames.unshift(final);
  if (finishedGames.length > 2) finishedGames.pop();

  // Очистка текущей игры
  currentGame = { gameId: null, status: null, players: {}, totalPlayers: 0, totalDeposit: 0, delta: null };
  sentPlayersToAI = false;
  sentDeltaLogForHUD = false;
  startedStatus1Log = false;
}

function onPush(msg){
  const data = msg.push?.pub?.data;
  if (!data) return;

  const t = data.type;

  if (t === "update") return handleUpdate(data);
  if (t === "betCreated" || t === "bet") return handleBet(data.bet || data);
  if (t === "topBetCreated") return;
  if (t === "crash" || t === "end") return finalizeGame(data);
}

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
      ws.send(JSON.stringify({ type:3 })); // pong
      lastPongTs = Date.now();
    }
  });

  ws.on("pong", ()=> lastPongTs = Date.now());
  ws.on("close", ()=> pushLog("WS_CLOSE"));
  ws.on("error", e=> pushLog("WS_ERROR",{error:String(e)}));
}

async function loop(){
  while(running){
    try{
      ws = new WebSocket(WS_URL);
      attachWs(ws);
      await new Promise(res=>ws.once("close",res));
    } catch{}
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

    console.log("[SERVER] Shutdown initiated via /shutdown endpoint");
    pushLog({ type: "shutdown_endpoint", reason: "manual_request" });

    // Остановить основной цикл и закрыть WS
    running = false;
    try {
      if (ws) ws.close();
    } catch (e) {
      console.error("[SERVER] Error closing WS:", e.message);
    }

    // Небольшая задержка перед полным выходом, чтобы обработались события
    setTimeout(() => process.exit(0), 500);
    return;
  }

  res.end("ok");
}).listen(PORT, () => console.log("HTTP listen", PORT));

loop();