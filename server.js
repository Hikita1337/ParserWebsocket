// server.js — парсер WebSocket -> краткий рабочий код (ESM)
// Установка: npm i ws node-fetch
import WebSocket from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";

// ---------- Конфиг (ENV) ----------
const WS_URL = process.env.WS_URL || "wss://ws.cs2run.app/connection/websocket";
const TOKEN_URL = process.env.TOKEN_URL || "https://cs2run.app/current-state";
const CHANNEL = process.env.CHANNEL || "csgorun:crash";
const PORT = Number(process.env.PORT || 10000);

const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 40000);
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS || 15000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000); // 5 min

// ---------- Состояние ----------
let ws = null;
let running = true;
let reconnectAttempts = 0;

let sessionStartTs = null;
let lastPongTs = null;
let lastDisconnect = null;

// Текущая собираемая игра
let currentGame = {
  gameId: null,
  status: null,
  players: {}, // userId -> { userId, name, sum, lastCoefficientAuto }
  totalPlayers: 0,
  totalDeposit: 0,
  delta: null
};

// История финальных игр (в памяти)
const finishedGames = []; // push latest first

// Буфер логов (фильтрованный)
const logs = [];

function nowIso(){ return new Date().toISOString(); }
function pushLog(entry){
  entry.ts = nowIso();
  logs.push(entry);
  while (logs.length > MAX_LOG_ENTRIES) logs.shift();
  // Вывод только ключевых типов
  const quiet = new Set(["push_ignored","raw_push","push_full"]);
  if (!quiet.has(entry.type)) {
    console.log(JSON.stringify(entry));
  }
}

// ---------- Вспомогательные ----------
async function fetchToken(){
  try {
    const r = await fetch(TOKEN_URL, { cache: "no-store" });
    const j = await r.json();
    const token = j?.data?.main?.centrifugeToken || null;
    pushLog({ type: "token_fetch", ok: !!token });
    return token;
  } catch (e) {
    pushLog({ type: "token_fetch_error", error: String(e) });
    return null;
  }
}

function colorForCrash(c){
  // цвета по диапазонам: 1-1.19 red, 1.2-1.99 blue, 2-3.99 pink, 4-7.99 green, 8-24.99 yellow, 25+ gradient
  if (c < 1.2) return "red";
  if (c < 2) return "blue";
  if (c < 4) return "pink";
  if (c < 8) return "green";
  if (c < 25) return "yellow";
  return "gradient";
}

function aggregatePlayerFromBet(bet){
  if (!bet || !bet.user) return;
  const uid = bet.user.id;
  if (!uid) return;
  const amount = Number(bet.deposit?.amount || 0) || 0;
  const coefAuto = bet.coefficientAuto ?? null;

  if (!currentGame.players[uid]) {
    currentGame.players[uid] = {
      userId: uid,
      name: bet.user.name || null,
      sum: amount,
      lastCoefficientAuto: coefAuto
    };
  } else {
    // суммируем (на всякий случай), и обновляем последний coefficientAuto
    currentGame.players[uid].sum = (currentGame.players[uid].sum || 0) + amount;
    if (coefAuto !== null && coefAuto !== undefined) currentGame.players[uid].lastCoefficientAuto = coefAuto;
  }
}

// ---------- WS handlers & parsing ----------
function makeBinaryJsonPong(){ return Buffer.from(JSON.stringify({ type: 3 })); }

function handleParsedPush(parsed){
  // parsed.push.pub.data is the payload we inspect
  const pub = parsed?.push?.pub;
  const ch = parsed?.push?.channel;

  if (!pub || !ch) return;

  const data = pub.data || pub; // some messages embed .data
  // Detect status updates, delta, bets, crash
  // 1) update with status/delta: { type: "update", delta: X, status: 1|2 }
  // 2) bet events: type: "betCreated" or "betCreated"/"bet" (we will accept 'betCreated' and 'betCreated' payloads with bet)
  // 3) crash event: type: "crash" with { id, crash }
  if (data.type === "update") {
    const st = data.status;
    currentGame.status = st ?? currentGame.status;
    currentGame.delta = (typeof data.delta === "number") ? data.delta : currentGame.delta;
    pushLog({ type: "status_update", channel: ch, status: st, delta: currentGame.delta });
    // if status changed to 2 -> send players to AI stub (once)
    if (st === 2) {
      // aggregate totals
      const playersArr = Object.values(currentGame.players);
      const totalPlayers = playersArr.length;
      const totalDeposit = playersArr.reduce((s,p)=>s+(Number(p.sum)||0),0);
      currentGame.totalPlayers = totalPlayers;
      currentGame.totalDeposit = totalDeposit;
      // AI stub (do not print players)
      pushLog({ type: "send_to_ai_on_status_2", gameId: currentGame.gameId, players_count: totalPlayers, total_deposit: totalDeposit });
      console.log(`[AI] send players for game=${currentGame.gameId} players=${totalPlayers} total=${totalDeposit}`);
      // HUD stub: announce delta once for status 2
      pushLog({ type: "hud_delta_start", gameId: currentGame.gameId, delta: currentGame.delta });
      console.log(`[HUD] start delta for game=${currentGame.gameId} delta=${currentGame.delta}`);
    }
    return;
  }

  if (data.type === "betCreated" || data.type === "bet") {
    const bet = data.bet || data;
    // ignore topBetCreated if you want to skip heavy top bets; user requested to exclude top bets
    // aggregate by user id
    aggregatePlayerFromBet(bet);
    return;
  }

  // Some implementations may use 'topBetCreated' for highlighted bets — user asked to ignore top bets
  if (data.type === "topBetCreated") {
    // ignore entirely
    return;
  }

  if (data.type === "changeStatistic") {
    // possibly contains counts, totals — optional
    pushLog({ type: "stats_update", payload_summary: { count: data.count, totalDeposit: data.totalDeposit } });
    return;
  }

  if (data.type === "crash" || data.type === "end" ) {
    const gameId = data.id || data.gameId || currentGame.gameId;
    const crash = data.crash;
    const color = (typeof crash === "number") ? colorForCrash(crash) : null;

    // finalize game record
    const playersArr = Object.values(currentGame.players);
    const totalPlayers = playersArr.length;
    const totalDeposit = playersArr.reduce((s,p)=>s+(Number(p.sum)||0),0);
    const final = {
      gameId,
      crash,
      color,
      players: playersArr,
      totalPlayers,
      totalDeposit,
      ts: nowIso()
    };
    finishedGames.unshift(final);
    if (finishedGames.length > 2000) finishedGames.pop();

    pushLog({ type: "game_final", gameId, crash, color, players_count: totalPlayers, total_deposit: totalDeposit });
    console.log(`[GAME] final game=${gameId} crash=${crash} color=${color} players=${totalPlayers} total=${totalDeposit}`);

    // AI + HUD stubs
    pushLog({ type: "ai_notify_crash", gameId, crash, color });
    console.log(`[AI] notify crash game=${gameId} crash=${crash} color=${color}`);
    console.log(`[HUD] notify crash ${crash}`);

    // Save to file (meta) to keep a durable footprint (optional)
    try {
      const fn = path.join(os.tmpdir(), `ws_game_${gameId}_${Date.now()}.json`);
      fs.writeFileSync(fn, JSON.stringify(final, null, 2));
      pushLog({ type: "game_saved", file: fn });
    } catch(e){
      pushLog({ type: "game_save_err", error: String(e) });
    }

    // Clear currentGame memory AFTER saving
    currentGame = { gameId: null, status: null, players: {}, totalPlayers: 0, totalDeposit: 0, delta: null };
    return;
  }

  // other push types -> ignore or minimal note
  pushLog({ type: "push_ignored", channel: ch, subtype: data.type || "unknown" });
}

// Low-level attach
function attachWsHandlers(instance){
  instance.on("open", () => {
    reconnectAttempts = 0;
    sessionStartTs = Date.now();
    pushLog({ type: "ws_open", url: WS_URL });
    console.log("[WS] OPEN");
  });

  instance.on("message", (data, isBinary) => {
    // try parse as text JSON
    let parsed = null;
    try {
      const txt = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      parsed = JSON.parse(txt);
    } catch(e){
      parsed = null;
    }

    if (parsed) {
      // If empty object {} => centrifuge ping => reply binary JSON pong
      if (typeof parsed === "object" && Object.keys(parsed).length === 0) {
        try {
          const pong = makeBinaryJsonPong();
          instance.send(pong, { binary: true }, (err) => {
            if (err) pushLog({ type: "json_pong_send_error", error: String(err) });
            else {
              lastPongTs = Date.now();
              pushLog({ type: "json_pong_sent" });
            }
          });
        } catch (e) {
          pushLog({ type: "json_pong_err", error: String(e) });
        }
        return;
      }

      // parsed messages often contain { push: { channel, pub: { data: ... } } }
      if (parsed.push) {
        // parse push but do NOT store raw push bodies
        try { handleParsedPush(parsed); } catch(e) { pushLog({ type: "handle_parsed_err", error: String(e) }); }
        return;
      }

      // connect ack or responses with id
      if (parsed.id === 1 && parsed.connect) {
        pushLog({ type: "connect_ack", client: parsed.connect.client || null, meta: parsed.connect });
        // if connect contains ping pacing, we could respect it, but we'll simply note it
        return;
      }

      // messages with id -> log summary
      if (parsed.id !== undefined) {
        pushLog({ type: "msg_with_id", id: parsed.id, summary: parsed.error ? parsed.error : "ok" });
        return;
      }

      // other parsed messages -> minimal note
      pushLog({ type: "message_parsed_misc" });
      return;
    }

    // non-json => minimal record
    pushLog({ type: "message_nonjson", size: Buffer.isBuffer(data) ? data.length : String(data).length });
  });

  instance.on("ping", (data) => {
    try { instance.pong(data); pushLog({ type: "transport_ping_recv" }); } catch(e){ pushLog({ type: "transport_ping_err", error: String(e) }); }
  });

  instance.on("pong", (data) => {
    lastPongTs = Date.now();
    pushLog({ type: "transport_pong_recv" });
  });

  instance.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf && reasonBuf.length) ? reasonBuf.toString() : "";
    const durationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    lastDisconnect = { code, reason, duration_ms: durationMs, ts: nowIso() };
    pushLog({ type: "ws_close", code, reason, duration_ms: durationMs });
    console.log(`[WS] CLOSE code=${code} reason=${reason} duration=${Math.round(durationMs/1000)}s`);
    sessionStartTs = null;
    // don't clear currentGame here — we'll attempt to recover via reconnection and API later (planned)
  });

  instance.on("error", (err) => {
    pushLog({ type: "ws_error", error: String(err) });
    console.error("[WS ERROR]", err?.message || err);
  });
}

// ---------- Main loop ----------
async function mainLoop(){
  while (running){
    try {
      const token = await fetchToken();
      if (!token) {
        console.log("[MAIN] token missing, retry in 3s");
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      pushLog({ type: "start_connect", url: WS_URL, channel: CHANNEL, token_present: !!token });
      console.log("[RUN] connecting to", WS_URL);

      ws = new WebSocket(WS_URL, { handshakeTimeout: OPEN_TIMEOUT_MS });

      attachWsHandlers(ws);

      // wait for open or error
      await new Promise((resolve, reject) => {
        const to = setTimeout(()=> reject(new Error("ws open timeout")), OPEN_TIMEOUT_MS);
        ws.once("open", () => { clearTimeout(to); resolve(); });
        ws.once("error", (e) => { clearTimeout(to); reject(e); });
      });

      // send connect payload (centrifuge-like)
      try {
        const connectPayload = { id: 1, connect: { token, subs: {} } };
        ws.send(JSON.stringify(connectPayload));
        pushLog({ type: "connect_sent" });
        console.log("[WS->] CONNECT sent");
      } catch (e) {
        pushLog({ type: "connect_send_error", error: String(e) });
      }

      // subscribe to channel (only for visibility)
      await new Promise(r => setTimeout(r, 150));
      try {
        const payload = { id: 100, subscribe: { channel: CHANNEL } };
        ws.send(JSON.stringify(payload));
        pushLog({ type: "subscribe_sent", channel: CHANNEL });
        console.log("[WS->] subscribe", CHANNEL);
      } catch (e) {
        pushLog({ type: "subscribe_send_error", error: String(e) });
      }

      // wait until closed
      await new Promise((resolve) => {
        ws.once("close", resolve);
        ws.once("error", resolve);
      });

      // backoff
      reconnectAttempts++;
      const backoff = Math.min(30000, 2000 * Math.pow(1.5, reconnectAttempts));
      pushLog({ type: "reconnect_backoff", attempt: reconnectAttempts, backoff_ms: Math.round(backoff) });
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      pushLog({ type: "main_exception", error: String(e) });
      console.error("[MAIN EXC]", e?.message || e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ---------- HTTP endpoints ----------
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, {"Content-Type":"text/plain"}); res.end("ok\n"); return;
  }

  if (req.url === "/status") {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    const sessionDurationMs = sessionStartTs ? (Date.now() - sessionStartTs) : 0;
    const payload = {
      ts: nowIso(),
      connected,
      channel: CHANNEL,
      session_start: sessionStartTs ? new Date(sessionStartTs).toISOString() : null,
      session_duration_ms: sessionDurationMs,
      last_pong_ts: lastPongTs ? new Date(lastPongTs).toISOString() : null,
      last_disconnect: lastDisconnect || null,
      current_game: { gameId: currentGame.gameId, status: currentGame.status, players_count: Object.keys(currentGame.players).length }
    };
    res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify(payload)); return;
  }

  if (req.url === "/logs") {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ ts: nowIso(), count: logs.length, tail: logs.slice(-1000) }));
    return;
  }

  if (req.url === "/game/current") {
    const playersArr = Object.values(currentGame.players).map(p => ({ userId: p.userId, name: p.name, sum: p.sum, lastCoefficientAuto: p.lastCoefficientAuto }));
    const payload = {
      ts: nowIso(),
      game: { gameId: currentGame.gameId, status: currentGame.status, delta: currentGame.delta, totalPlayers: playersArr.length, totalDeposit: playersArr.reduce((s,p)=>s+Number(p.sum||0),0), players: playersArr }
    };
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.url === "/game/history") {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ ts: nowIso(), count: finishedGames.length, games: finishedGames.slice(0,100) }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => {
  pushLog({ type: "http_listen", port: PORT });
  console.log("[HTTP] listening", PORT);
});

// Heartbeat (save small meta to disk for Render visibility)
setInterval(()=> {
  pushLog({ type: "heartbeat", connected: !!(ws && ws.readyState === WebSocket.OPEN), current_players: Object.keys(currentGame.players).length, finishedGames: finishedGames.length });
  try {
    const fn = path.join(os.tmpdir(), `ws_meta_${Date.now()}.json`);
    fs.writeFileSync(fn, JSON.stringify({ ts: nowIso(), players: Object.keys(currentGame.players).length, finishedGames: finishedGames.length }, null, 2));
    pushLog({ type: "meta_saved", file: fn });
  } catch(e){ pushLog({ type: "meta_save_err", error: String(e) }); }
}, HEARTBEAT_MS);

// Graceful shutdown
process.on("SIGINT", ()=>{ pushLog({ type: "shutdown", signal:"SIGINT"}); running=false; try{ if(ws) ws.close(); }catch{} process.exit(0); });
process.on("SIGTERM", ()=>{ pushLog({ type: "shutdown", signal:"SIGTERM"}); running=false; try{ if(ws) ws.close(); }catch{} process.exit(0); });

// Start
mainLoop().catch(e=>{ pushLog({ type: "fatal", error: String(e) }); console.error("[FATAL]", e); process.exit(1); });