const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

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

// Set up storage directory
const UPLOADS_DIR = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'uploads') : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve static uploads
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure multer (10MB limit)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

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
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id        INTEGER NOT NULL,
    to_id          INTEGER,
    group_id       INTEGER,
    content        TEXT NOT NULL,
    attachment_url TEXT DEFAULT '',
    attachment_type TEXT DEFAULT '',
    timestamp      INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL,
    icon_url   TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    UNIQUE(group_id, user_id)
  );
`);

// Support for existing users (Migration)
try {
  db.exec("ALTER TABLE users ADD COLUMN pfp_url TEXT DEFAULT ''");
} catch (e) { }

try {
  db.exec("ALTER TABLE messages ADD COLUMN attachment_url TEXT DEFAULT ''");
  db.exec("ALTER TABLE messages ADD COLUMN attachment_type TEXT DEFAULT ''");
  db.exec("ALTER TABLE messages ADD COLUMN group_id INTEGER");
} catch (e) { }

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

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, type: req.file.mimetype });
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
    SELECT u.id, u.username, u.pfp_url FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.status = 'accepted'
    UNION
    SELECT u.id, u.username, u.pfp_url FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'accepted'
  `).all(id, id);
  res.json(friends);
});

app.get('/friends/requests/:user_id', (req, res) => {
  const id = parseInt(req.params.user_id);
  const requests = db.prepare(`
    SELECT u.id, u.username, u.pfp_url FROM friends f
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

// --- Groups ---

app.post('/groups/create', (req, res) => {
  const { name, owner_id } = req.body;
  if (!name || !owner_id) return res.status(400).json({ error: 'Missing fields' });
  
  try {
    const result = db.prepare('INSERT INTO groups (name, owner_id) VALUES (?, ?)').run(name, owner_id);
    const groupId = result.lastInsertRowid;
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, owner_id);
    
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    res.json(group);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/groups/add_member', (req, res) => {
  const { group_id, user_id } = req.body;
  try {
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(group_id, user_id);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/groups/:user_id', (req, res) => {
  const { user_id } = req.params;
  const groups = db.prepare(`
    SELECT g.id, g.name, g.icon_url, g.created_at
    FROM groups g
    JOIN group_members m ON g.id = m.group_id
    WHERE m.user_id = ?
  `).all(user_id);
  res.json(groups);
});

app.get('/messages/group/:group_id', (req, res) => {
  const messages = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY timestamp ASC').all(req.params.group_id);
  res.json(messages);
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
        const { to_id, group_id, content, attachment_url = '', attachment_type = '' } = msg;
        if (!content && !attachment_url) return;

        const timestamp = Math.floor(Date.now() / 1000);
        let result;
        
        if (group_id) {
          result = db.prepare(
            'INSERT INTO messages (from_id, group_id, content, attachment_url, attachment_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(userId, group_id, String(content || '').trim(), String(attachment_url), String(attachment_type), timestamp);
        } else {
          result = db.prepare(
            'INSERT INTO messages (from_id, to_id, content, attachment_url, attachment_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(userId, to_id, String(content || '').trim(), String(attachment_url), String(attachment_type), timestamp);
        }

        const savedMsg = {
          id: result.lastInsertRowid,
          from_id: userId,
          to_id,
          group_id,
          content: String(content || '').trim(),
          attachment_url: String(attachment_url),
          attachment_type: String(attachment_type),
          timestamp
        };

        if (group_id) {
          const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(group_id);
          members.forEach(member => {
            if (member.user_id === userId) return;
            const recipientWs = clients.get(member.user_id);
            if (recipientWs && recipientWs.readyState === 1) {
              recipientWs.send(JSON.stringify({ type: 'message', message: savedMsg }));
            }
          });
          ws.send(JSON.stringify({ type: 'message_sent', message: savedMsg }));
        } else {
          const recipientWs = clients.get(to_id);
          if (recipientWs && recipientWs.readyState === 1) {
            recipientWs.send(JSON.stringify({ type: 'message', message: savedMsg }));
          }
          ws.send(JSON.stringify({ type: 'message_sent', message: savedMsg }));
        }
      }

      // WebRTC Signaling
      if (['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_end'].includes(msg.type) && userId) {
        const recipientWs = clients.get(msg.to_id);
        if (recipientWs && recipientWs.readyState === 1) {
          msg.from_id = userId;
          recipientWs.send(JSON.stringify(msg));
        }
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
