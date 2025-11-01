// server.js
// Simple relay server for E2EE messages. Server never decrypts messages.
// - Stores user public keys (in-memory; replace with DB/Redis for production)
// - Exposes HTTP endpoints for registering/fetching public keys
// - WebSocket relay: clients connect and exchange encrypted messages

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// In-memory stores (replace with Redis/DB for production)
const publicKeys = {};        // userId -> base64 publicKey
const clients = new Map();    // userId -> WebSocket

// Register a user's public key
// POST { userId: string, publicKey: base64String }
app.post('/register', (req, res) => {
  const { userId, publicKey } = req.body;
  if (!userId || !publicKey) return res.status(400).json({ error: 'userId and publicKey required' });
  publicKeys[userId] = publicKey;
  return res.json({ ok: true });
});

// Get a user's public key
// GET /keys/:userId
app.get('/keys/:userId', (req, res) => {
  const k = publicKeys[req.params.userId];
  if (!k) return res.status(404).json({ error: 'not found' });
  return res.json({ userId: req.params.userId, publicKey: k });
});

// List all public keys (optional)
app.get('/keys', (req, res) => {
  return res.json(publicKeys);
});

const server = http.createServer(app);

// WebSocket server for relaying messages
const wss = new WebSocket.Server({ server });

/*
 WebSocket message formats (JSON):
 1) When connecting, client SHOULD send an "identify" message:
    { type: 'identify', userId: 'alice' }

 2) To send an encrypted message:
    { type: 'send', to: 'bob', payload: { ciphertext: <base64>, nonce: <base64>, sender: 'alice' } }

 The server relays payload to recipient if connected.
*/

wss.on('connection', (ws, req) => {
  let userId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'identify') {
        if (!msg.userId) return ws.send(JSON.stringify({ type: 'error', message: 'identify requires userId' }));
        userId = msg.userId;
        clients.set(userId, ws);
        console.log(`User connected: ${userId}`);
        ws.send(JSON.stringify({ type: 'identified', userId }));
        return;
      }

      if (msg.type === 'send') {
        const { to, payload } = msg;
        if (!to || !payload) return ws.send(JSON.stringify({ type: 'error', message: 'send requires to and payload' }));
        const dest = clients.get(to);
        // Save message to DB/queue if dest offline (not implemented)
        if (dest && dest.readyState === WebSocket.OPEN) {
          dest.send(JSON.stringify({ type: 'message', payload }));
          ws.send(JSON.stringify({ type: 'sent', to }));
        } else {
          // Optionally, queue or return offline notice
          ws.send(JSON.stringify({ type: 'offline', to }));
        }
        return;
      }

      // Ping/pong or other messages
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

      ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
    } catch (e) {
      console.error('Invalid message', e);
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
    }
  });

  ws.on('close', () => {
    if (userId && clients.get(userId) === ws) {
      clients.delete(userId);
      console.log(`User disconnected: ${userId}`);
    }
  });
});

// Simple heartbeat to drop dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(process.env.PORT || 3000, () => {
  console.log('E2EE relay server listening on port', process.env.PORT || 3000);
});
