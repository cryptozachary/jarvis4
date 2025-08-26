// server.js — Jarvis Voice Assistant (Phase 1: reliability/health)
// - Serves index.html
// - Optional HTTPS for LAN/IP use (set HTTPS=true)
// - Realtime OpenAI WS relay
// - Heartbeat/TTL, continuity replay
// - NEW: quick WS ping/pong for client RTT; favicon shim
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

const USE_HTTPS = String(process.env.HTTPS || 'false').toLowerCase() === 'true';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3001);

let server;
if (USE_HTTPS) {
  const keyPath = process.env.SSL_KEY_PATH;
  const certPath = process.env.SSL_CERT_PATH;
  if (!keyPath || !certPath) {
    console.error('HTTPS is true but SSL_KEY_PATH / SSL_CERT_PATH not set in .env');
    process.exit(1);
  }
  server = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, app);
} else {
  server = http.createServer(app);
}
const wss = new WebSocket.Server({ server });

const OPENAI_API_KEY =
  process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL =
  process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES || 30);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const PONG_GRACE_MS = Number(process.env.PONG_GRACE_MS || 10000);
const MAX_CONTEXT_MESSAGES = Number(process.env.MAX_CONTEXT_MESSAGES || 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve UI
const staticDir = __dirname;
app.use(express.static(staticDir));
app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));

// Avoid noisy favicon 404 in dev tools
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Serve the resampler worklet
app.get('/pcm-resampler.worklet.js', (_req, res) => {
  res.type('application/javascript').send(`
    class PCMResampler extends AudioWorkletProcessor {
      constructor(options){ super(); this.targetRate=(options&&options.processorOptions&&options.processorOptions.targetSampleRate)||24000; }
      static get parameterDescriptors(){ return []; }
      process(inputs){
        const input = inputs[0]; if(!input||!input[0]||input[0].length===0) return true;
        const src=input[0], sr=sampleRate, ratio=this.targetRate/sr;
        const outLen=Math.floor(src.length*ratio+1), out=new Float32Array(outLen);
        for(let i=0;i<outLen;i++){ const idx=i/ratio; const i0=Math.floor(idx), i1=Math.min(i0+1,src.length-1); const t=idx-i0; out[i]=src[i0]*(1-t)+src[i1]*t; }
        const pcm=new Int16Array(out.length);
        for(let i=0;i<out.length;i++){ let s=Math.max(-1,Math.min(1,out[i])); pcm[i]=(s<0?s*32768:s*32767)|0; }
        this.port.postMessage(pcm.buffer,[pcm.buffer]); return true;
      }
    }
    registerProcessor('pcm-resampler', PCMResampler);
  `);
});

/** ---------- In-memory state ---------- */
const clients = new Map();          // clientId -> { ws, sessionId, isAlive, lastPongAt, conversationHistory[], assistantBuffer }
const openaiConnections = new Map();// clientId -> openaiWs
const sessionData = new Map();      // sessionId -> { created, lastActivity, model, voice, instructions }

/** ---------- Helpers ---------- */
function sendToClient(clientId, payload) {
  const c = clients.get(clientId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) return;
  try { c.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); } catch {}
}
function sendError(clientId, code, message, details) {
  sendToClient(clientId, { type: 'error', code, message, details: details ? String(details) : undefined });
}

/** ---------- API: Create/configure a session ---------- */
app.post('/api/session', (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'openai_key_missing', message: 'OpenAI API key not configured' });
  }
  const sessionId = uuidv4();
  const { model, voice, instructions } = req.body || {};
  sessionData.set(sessionId, {
    created: new Date(),
    lastActivity: new Date(),
    model: model || DEFAULT_MODEL,
    voice: voice || 'alloy',
    instructions:
      instructions ||
      "You are Jarvis, Tony Stark's AI assistant. Helpful, clever, slightly sarcastic. Keep responses brief and engaging.",
  });
  console.log(`[session] created ${sessionId}`);
  res.json({ sessionId, status: 'success' });
});

/** ---------- WebSocket: App <-> This server ---------- */
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, {
    ws, sessionId: null, isAlive: true, lastPongAt: Date.now(),
    conversationHistory: [], assistantBuffer: ''
  });

  ws.on('pong', () => {
    const c = clients.get(clientId);
    if (c) { c.isAlive = true; c.lastPongAt = Date.now(); }
  });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const c = clients.get(clientId);
    if (!c) return;
    if (c.sessionId) {
      const s = sessionData.get(c.sessionId);
      if (s) s.lastActivity = new Date();
    }

    // Local RTT ping for health HUD
    if (data.type === 'client.ping') {
      return sendToClient(clientId, { type: 'server.pong', t: data.t || Date.now() });
    }

    if (data.type === 'session.init') return handleSessionInit(clientId, data.sessionId);
    if (data.type === 'session.end')  return handleSessionEnd(clientId);

    // record conversation items (for continuity)
    if (data.type === 'conversation.item.create' && data.item) {
      c.conversationHistory.push({ role: data.item.role, content: data.item.content });
      while (c.conversationHistory.length > MAX_CONTEXT_MESSAGES * 2) c.conversationHistory.shift();
    }

    // forward anything else to OpenAI
    const ows = openaiConnections.get(clientId);
    if (ows && ows.readyState === WebSocket.OPEN) {
      ows.send(raw.toString());
    } else {
      sendError(clientId, 'openai_not_connected', 'No active OpenAI connection');
    }
  });

  ws.on('close', () => {
    safeCloseOpenAI(clientId, 1001, 'client_ws_closed');
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[ws] client error ${clientId}`, err);
    sendError(clientId, 'client_ws_error', 'WebSocket error', err.message);
  });

  sendToClient(clientId, { type: 'server.welcome', clientId, message: 'Connected to Jarvis server' });
});

/** ---------- OpenAI Realtime connect/close ---------- */
async function handleSessionInit(clientId, maybeSessionId) {
  const c = clients.get(clientId);
  if (!c) return;

  let sessionId = maybeSessionId;
  if (!sessionId || !sessionData.has(sessionId)) {
    sessionId = uuidv4();
    sessionData.set(sessionId, {
      created: new Date(), lastActivity: new Date(),
      model: DEFAULT_MODEL, voice: 'alloy',
      instructions: "You are Jarvis, Tony Stark's AI assistant. Helpful, clever, slightly sarcastic. Keep responses brief and engaging."
    });
  }
  c.sessionId = sessionId;

  safeCloseOpenAI(clientId, 1000, 'reinit');
  const sess = sessionData.get(sessionId);
  if (!OPENAI_API_KEY) {
    sendError(clientId, 'openai_key_missing', 'OpenAI API key not configured'); return;
  }

  try {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(sess.model)}`;
    const openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    openaiConnections.set(clientId, openaiWs);

    openaiWs.on('open', () => {
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          voice: sess.voice,
          instructions: sess.instructions,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: { type: 'server_vad', threshold: 0.3, prefix_padding_ms: 300, silence_duration_ms: 2000 }
        }
      }));
      const past = (c.conversationHistory || []).slice(-MAX_CONTEXT_MESSAGES * 2);
      for (const msg of past) {
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: msg.role, content: msg.content }
        }));
      }
      sendToClient(clientId, { type: 'openai.connected', sessionId });
    });

    openaiWs.on('message', (raw) => {
      const s = raw.toString();
      sendToClient(clientId, s);
      try {
        const evt = JSON.parse(s);
        if ((evt.type === 'response.text.delta' || evt.type === 'response.output_text.delta') && typeof evt.delta === 'string') {
          const cc = clients.get(clientId); if (cc) cc.assistantBuffer += evt.delta;
        }
        if (['response.text.done', 'response.output_text.done', 'response.complete', 'response.done'].includes(evt.type)) {
          const cc = clients.get(clientId);
          if (cc && cc.assistantBuffer.trim()) {
            cc.conversationHistory.push({ role: 'assistant', content: [{ type: 'output_text', text: cc.assistantBuffer }] });
            while (cc.conversationHistory.length > MAX_CONTEXT_MESSAGES * 2) cc.conversationHistory.shift();
            cc.assistantBuffer = '';
          }
        }
      } catch {}
    });

    openaiWs.on('close', (code, reason) => {
      openaiConnections.delete(clientId);
      sendToClient(clientId, { type: 'openai.disconnected', code, reason: String(reason || '') });
    });

    openaiWs.on('error', (err) => {
      console.error('[openai] error', err);
      sendError(clientId, 'openai_ws_error', 'OpenAI connection error', err.message);
      openaiConnections.delete(clientId);
    });
  } catch (err) {
    console.error('[openai] connect failed', err);
    sendError(clientId, 'openai_connect_failed', 'Failed to connect to OpenAI', err.message);
  }
}

async function handleSessionEnd(clientId) {
  const ows = openaiConnections.get(clientId);
  if (ows && ows.readyState === WebSocket.OPEN) {
    try { ows.send(JSON.stringify({ type: 'session.end' })); } catch {}
  }
  safeCloseOpenAI(clientId, 1000, 'session_end');
  sendToClient(clientId, { type: 'openai.disconnected', code: 1000, reason: 'session ended by client' });
}

function safeCloseOpenAI(clientId, code = 1000, reason = 'close') {
  const ows = openaiConnections.get(clientId);
  if (!ows) return;
  try { if (ows.readyState === WebSocket.OPEN) ows.close(code, reason); } catch {}
  openaiConnections.delete(clientId);
}

/** ---------- Housekeeping ---------- */
setInterval(() => {
  const cutoffMs = SESSION_TTL_MINUTES * 60 * 1000;
  const now = Date.now();
  for (const [sid, s] of sessionData.entries()) {
    const inactive = now - new Date(s.lastActivity || s.created).getTime();
    if (inactive > cutoffMs) { sessionData.delete(sid); }
  }
}, 60_000);

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    const ws = c.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (now - c.lastPongAt > HEARTBEAT_INTERVAL_MS + PONG_GRACE_MS) {
      try { ws.terminate(); } catch {}
      safeCloseOpenAI(id, 1006, 'heartbeat_timeout');
      clients.delete(id);
      continue;
    }
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

/** ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`Jarvis server running on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${OPENAI_API_KEY ? 'Yes' : 'No'}`);
  if (!OPENAI_API_KEY) console.error('Set OPEN_AI_KEY or OPENAI_API_KEY in your .env');
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (r,p) => console.error('Unhandled:', r));
