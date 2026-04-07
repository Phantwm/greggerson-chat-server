const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());

// Allow cross-origin for development / Railway deployment
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Database (built-in node:sqlite, no install needed) ---
const dbPath = process.env.DB_PATH || 'chat.db';
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hwid       TEXT UNIQUE NOT NULL,
    username   TEXT UNIQUE NOT NULL,
    pfp_url    TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS friends (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status    TEXT DEFAULT 'pending',
    UNIQUE(user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   INTEGER NOT NULL,
    to_id     INTEGER NOT NULL,
    content   TEXT NOT NULL,
    timestamp INTEGER DEFAULT (unixepoch())
  );
`);

// Support for existing users (Migration)
try {
  db.exec("ALTER TABLE users ADD COLUMN pfp_url TEXT DEFAULT ''");
} catch (e) {
  // Column likely already exists
}

// Connected WebSocket clients: Map<user_id, ws>
const clients = new Map();

// --- Users ---

app.post('/register', (req, res) => {
  const { hwid, username } = req.body;
  if (!hwid || !username) return res.status(400).json({ error: 'Missing fields' });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 2–20 characters: letters, numbers, underscores only' });

  const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (taken) return res.status(409).json({ error: 'Username already taken' });

  try {
    const r = db.prepare('INSERT INTO users (hwid, username) VALUES (?, ?)').run(hwid, username);
    const user = db.prepare('SELECT id, username, pfp_url FROM users WHERE id = ?').get(r.lastInsertRowid);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/user/update', (req, res) => {
  const { hwid, username, pfp_url } = req.body;
  if (!hwid || !username) return res.status(400).json({ error: 'Missing fields' });

  const user = db.prepare('SELECT id FROM users WHERE hwid = ?').get(hwid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Check if new username is taken by someone else
  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, user.id);
  if (taken) return res.status(409).json({ error: 'Username already taken' });

  try {
    db.prepare('UPDATE users SET username = ?, pfp_url = ? WHERE id = ?').run(username, pfp_url || '', user.id);
    const updated = db.prepare('SELECT id, username, pfp_url FROM users WHERE id = ?').get(user.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/user/by-hwid/:hwid', (req, res) => {
  const user = db.prepare('SELECT id, username, pfp_url FROM users WHERE hwid = ?').get(req.params.hwid);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.get('/users/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const users = db.prepare('SELECT id, username, pfp_url FROM users WHERE username LIKE ? LIMIT 15').all(`%${q}%`);
  res.json(users);
});

// --- Friends ---

app.get('/friends/:user_id', (req, res) => {
  const id = parseInt(req.params.user_id);
  const friends = db.prepare(`
    SELECT u.id, u.username FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.status = 'accepted'
    UNION
    SELECT u.id, u.username FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'accepted'
  `).all(id, id);
  res.json(friends);
});

app.get('/friends/requests/:user_id', (req, res) => {
  const id = parseInt(req.params.user_id);
  const requests = db.prepare(`
    SELECT u.id, u.username FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(id);
  res.json(requests);
});

app.post('/friends/request', (req, res) => {
  const { from_id, to_id } = req.body;
  if (!from_id || !to_id) return res.status(400).json({ error: 'Missing fields' });
  if (from_id === to_id) return res.status(400).json({ error: 'Cannot add yourself' });

  const toUser = db.prepare('SELECT id FROM users WHERE id = ?').get(to_id);
  if (!toUser) return res.status(404).json({ error: 'User not found' });

  const existing = db.prepare(
    'SELECT * FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)'
  ).get(from_id, to_id, to_id, from_id);

  if (existing) {
    return res.status(409).json({
      error: existing.status === 'accepted' ? 'Already friends' : 'Friend request already sent'
    });
  }

  db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)').run(from_id, to_id);

  // Notify recipient if online
  const recipientWs = clients.get(to_id);
  if (recipientWs && recipientWs.readyState === 1) {
    const sender = db.prepare('SELECT id, username FROM users WHERE id = ?').get(from_id);
    recipientWs.send(JSON.stringify({ type: 'friend_request', from: sender }));
  }

  res.json({ success: true });
});

app.post('/friends/accept', (req, res) => {
  const { user_id, friend_id } = req.body; // user_id = accepter, friend_id = who sent the request
  const result = db.prepare(
    "UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=? AND status='pending'"
  ).run(friend_id, user_id);

  if (result.changes === 0) return res.status(404).json({ error: 'Request not found' });

  // Notify the original requester if online
  const requesterWs = clients.get(friend_id);
  if (requesterWs && requesterWs.readyState === 1) {
    const accepter = db.prepare('SELECT id, username FROM users WHERE id = ?').get(user_id);
    requesterWs.send(JSON.stringify({ type: 'friend_accepted', user: accepter }));
  }

  res.json({ success: true });
});

app.post('/friends/decline', (req, res) => {
  const { user_id, friend_id } = req.body; // user_id = decliner, friend_id = who sent request
  db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(friend_id, user_id);
  res.json({ success: true });
});

// --- Messages ---

app.get('/messages/:user_id/:other_id', (req, res) => {
  const { user_id, other_id } = req.params;
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
    ORDER BY timestamp ASC
  `).all(user_id, other_id, other_id, user_id);
  res.json(messages);
});

// --- WebSocket ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'auth') {
        userId = parseInt(msg.user_id);
        clients.set(userId, ws);
        console.log(`[+] User ${userId} connected  (${clients.size} online)`);
        return;
      }

      if (msg.type === 'message' && userId) {
        const { to_id, content } = msg;
        if (!content || !String(content).trim()) return;

        const timestamp = Math.floor(Date.now() / 1000);
        const result = db.prepare(
          'INSERT INTO messages (from_id, to_id, content, timestamp) VALUES (?, ?, ?, ?)'
        ).run(userId, to_id, String(content).trim(), timestamp);

        const savedMsg = {
          id: result.lastInsertRowid,
          from_id: userId,
          to_id,
          content: String(content).trim(),
          timestamp
        };

        // Deliver to recipient if online
        const recipientWs = clients.get(to_id);
        if (recipientWs && recipientWs.readyState === 1) {
          recipientWs.send(JSON.stringify({ type: 'message', message: savedMsg }));
        }

        // Echo back to sender with server-assigned id/timestamp
        ws.send(JSON.stringify({ type: 'message_sent', message: savedMsg }));
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`[-] User ${userId} disconnected (${clients.size} online)`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Greggerson Chat server running on http://localhost:${PORT}`);
});
