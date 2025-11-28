// server.js — Crash Parser (robust message parsing)
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
  status: null,   // 1 = accepting bets, 2 = delta, null = unknown/new
  delta: null,
  players: {}     // key = userId
};

let collectingBets = true; // enabled after cache cleared (finalizeGame sets it)
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

  // Accept only if:
  //  - bet.status === 1 (explicit from WS)
  //  - AND collectingBets is true (we are in new-game mode)
  if (!collectingBets) return;
  if (Number(bet.status) !== 1) return;

  // If parser hasn't seen an update status=1 yet, but bet.status===1 —
  // infer currentGame.status = 1 (helps with race conditions).
  if (currentGame.status !== 1) {
    currentGame.status = 1;
    pushLog("INFER_STATUS_1", { fromBetId: bet.id, gameId: bet.gameId });
  }

  // Ensure gameId is populated
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

  if (typeof data.status === "number") {
    currentGame.status = data.status;
  }
  if (typeof data.delta === "number") currentGame.delta = data.delta;

  if (currentGame.status === 2) {
    // When status becomes 2 — we should snapshot players and send to AI (once)
    if (!sentPlayersToAI) {
      const arr = Object.values(currentGame.players);
      const totalPlayers = arr.length;
      const totalDeposit = arr.reduce((s,p)=>s+p.sum,0);

      pushLog("SEND_TO_AI", {
        gameId: currentGame.gameId,
        totalPlayers,
        totalDeposit
      });

      sentPlayersToAI = true;
    }

    if (!sentDeltaLogForHUD) {
      pushLog("HUD_DELTA_START", { delta: currentGame.delta });
      sentDeltaLogForHUD = true;
    }

    // Important: do NOT flip collectingBets here; bets will be filtered by bet.status === 1.
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

  const final = {
    gameId,
    crash,
    color,
    players: playersArr,
    totalPlayers,
    totalDeposit,
    ts: nowIso()
  };

  // DB write placeholder (replace with your function)
  // saveGameToDb(final).catch(...)

  finishedGames.unshift(final);
  if (finishedGames.length > 100) finishedGames.pop();

  // Clear state (cache) AFTER DB write
  currentGame = {
    gameId: null,
    status: null,
    delta: null,
    players: {}
  };

  sentPlayersToAI = false;
  sentDeltaLogForHUD = false;

  // Enable collecting bets for the next game
  collectingBets = true;
  pushLog("NEW_GAME_READY", { msg: "Cache cleared, collecting bets enabled" });
}

// --- Robust single-message parsing ---
// Some incoming frames contain multiple JSON objects concatenated.
// This function extracts JSON objects and returns array of parsed objects.
function parsePossibleBatch(raw){
  const results = [];

  // If already an object (ws may deliver parsed objects sometimes)
  if (typeof raw === 'object' && raw !== null) {
    results.push(raw);
    return results;
  }

  // raw is Buffer or string
  let s = raw.toString();

  // Fast path: single valid JSON
  try {
    const parsed = JSON.parse(s);
    results.push(parsed);
    return results;
  } catch (e) {
    // fallback to extract multiple JSON blocks
  }

  // Heuristic extraction:
  // Replace "}\n{" and "}{", then try split by newline boundaries
  // We'll scan for balanced braces and extract objects.
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
          // ignore parse failure for this piece but log for debugging
          pushLog("PARSE_FRAGMENT_FAIL", { fragment: piece.slice(0,200) });
        }
        start = null;
      }
    }
  }

  // If nothing parsed, as last resort try to find top-level "push" objects via regex
  if (results.length === 0) {
    const re = /{\"push\":.*?\}\}\}/g; // best-effort (will match some)
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

// --- onPush (process a single push entry) ---
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

  // We only care about betCreated (ignore topBetCreated)
  if (type === "betCreated") {
    handleBet(data.bet);
    return;
  }

  // ignore others but useful to log rare ones
  // pushLog("IGNORED_PUSH", { type });
}

// --- main onPush for the parsed object(s) ---
function onPush(p){
  // p may contain push or be multiple; handle safely
  if (!p) return;

  // If object is single push
  if (p.push && p.push.pub && p.push.pub.data) {
    onPushSingle(p.push);
    return;
  }

  // If it's an envelope array or similar, try to find push.* entries
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

// --- Attach WS ---
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
    // Robust parsing: extract possibly multiple JSON objects from a single message
    const parsedList = parsePossibleBatch(d);
    if (parsedList.length === 0) {
      // No JSON parsed — log and ignore
      pushLog("UNPARSED_WS_FRAME", { preview: d.toString().slice(0,200) });
      return;
    }
    for (const p of parsedList) {
      // normalize: if message is envelope with "push"
      if (p?.push) {
        onPush(p);
      } else {
        // Some frames may be raw push under nested structure - try scan
        onPush(p);
      }
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
    } catch (e) {
      pushLog("WS_LOOP_ERR", { error: String(e) });
    }
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