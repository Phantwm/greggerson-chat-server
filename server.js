const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json());

// Persistent storage path for uploads
const uploadsDir = path.join(process.env.DATA_DIR || '.', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// Serve uploads statically
app.use('/uploads', express.static(uploadsDir));

// Allow cross-origin for development / Railway deployment
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Debug Endpoint ---
app.get('/debug/db', (req, res) => {
  try {
    const usersInfo = db.prepare("PRAGMA table_info(users)").all();
    const messagesInfo = db.prepare("PRAGMA table_info(messages)").all();
    const friendsInfo = db.prepare("PRAGMA table_info(friends)").all();
    const groupsInfo = db.prepare("PRAGMA table_info(groups)").all();
    res.json({
      db_path: dbPath,
      tables: {
        users: usersInfo,
        messages: messagesInfo,
        friends: friendsInfo,
        groups: groupsInfo
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Database (built-in node:sqlite, no install needed) ---
const dbPath = process.env.DB_PATH || 'chat.db';
const db = new DatabaseSync(dbPath);

const migrationStatus = {};

function runMigration(name, sql) {
  try {
    db.exec(sql);
    migrationStatus[name] = "Success or already applied";
  } catch (e) {
    migrationStatus[name] = "Skipped/Error: " + e.message;
  }
}

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
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    creator_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS group_members (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    UNIQUE(group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id   INTEGER NOT NULL,
    to_id     INTEGER,
    group_id  INTEGER,
    content   TEXT NOT NULL,
    file_url  TEXT DEFAULT '',
    file_type TEXT DEFAULT '',
    timestamp INTEGER DEFAULT (unixepoch())
  );
`);

// Migrations
runMigration("users_pfp", "ALTER TABLE users ADD COLUMN pfp_url TEXT DEFAULT ''");
runMigration("msgs_to", "ALTER TABLE messages ADD COLUMN to_id INTEGER");
runMigration("msgs_group", "ALTER TABLE messages ADD COLUMN group_id INTEGER");
runMigration("msgs_file", "ALTER TABLE messages ADD COLUMN file_url TEXT DEFAULT ''");
runMigration("msgs_type", "ALTER TABLE messages ADD COLUMN file_type TEXT DEFAULT ''");

// --- REPAIR: Ensure existing friends have 'accepted' status if they pre-date the status column ---
try {
  db.exec("UPDATE friends SET status = 'accepted' WHERE status IS NULL OR status = ''");
} catch (e) { console.error("Repair error:", e.message); }

// --- Debug Endpoint Update ---
app.get('/debug/db', (req, res) => {
  try {
    const usersInfo = db.prepare("PRAGMA table_info(users)").all();
    const messagesInfo = db.prepare("PRAGMA table_info(messages)").all();
    const friendsInfo = db.prepare("PRAGMA table_info(friends)").all();
    const groupsInfo = db.prepare("PRAGMA table_info(groups)").all();
    
    const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    const friendCount = db.prepare("SELECT COUNT(*) as count FROM friends").get().count;
    const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages").get().count;
    const groupCount = db.prepare("SELECT COUNT(*) as count FROM groups").get().count;

    res.json({
      db_path: dbPath,
      migrations: migrationStatus,
      counts: { users: userCount, friends: friendCount, messages: msgCount, groups: groupCount },
      tables: {
        users: usersInfo,
        messages: messagesInfo,
        friends: friendsInfo,
        groups: groupsInfo
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug/repair', (req, res) => {
  try {
    const r = db.exec("UPDATE friends SET status = 'accepted' WHERE status IS NULL OR status = ''");
    res.json({ message: "Repair attempted", notice: "Check /debug/db counts now" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Connected WebSocket clients: Map<user_id, ws>
const clients = new Map();

// --- Media Support ---

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// --- Users ---

app.post('/register', (req, res) => {
  const { hwid, username } = req.body;
  if (!hwid || !username) return res.status(400).json({ error: 'Missing fields' });
  
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
  const user = db.prepare('SELECT id FROM users WHERE hwid = ?').get(hwid);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    db.prepare('UPDATE users SET username = ?, pfp_url = ? WHERE id = ?').run(username, pfp_url || '', user.id);
    const updated = db.prepare('SELECT id, username, pfp_url FROM users WHERE id = ?').get(user.id);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/user/by-hwid/:hwid', (req, res) => {
  const user = db.prepare('SELECT id, username, pfp_url FROM users WHERE hwid = ?').get(req.params.hwid);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.get('/users/search', (req, res) => {
  const q = (req.query.q || '').trim();
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
  const requests = db.prepare(`
    SELECT u.id, u.username, u.pfp_url FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(parseInt(req.params.user_id));
  res.json(requests);
});

app.post('/friends/request', (req, res) => {
  const { from_id, to_id } = req.body;
  try {
    db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)').run(from_id, to_id);
    const recipientWs = clients.get(parseInt(to_id));
    if (recipientWs && recipientWs.readyState === 1) {
      const sender = db.prepare('SELECT id, username, pfp_url FROM users WHERE id = ?').get(from_id);
      recipientWs.send(JSON.stringify({ type: 'friend_request', from: sender }));
    }
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: 'Already sent or friend' }); }
});

app.post('/friends/accept', (req, res) => {
  const { user_id, friend_id } = req.body;
  db.prepare("UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?").run(friend_id, user_id);
  const requesterWs = clients.get(parseInt(friend_id));
  if (requesterWs) {
    const accepter = db.prepare('SELECT id, username, pfp_url FROM users WHERE id = ?').get(user_id);
    requesterWs.send(JSON.stringify({ type: 'friend_accepted', user: accepter }));
  }
  res.json({ success: true });
});

app.post('/friends/decline', (req, res) => {
  const { user_id, friend_id } = req.body;
  try {
    db.prepare("DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)").run(friend_id, user_id, user_id, friend_id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Group Chats ---

app.post('/groups/create', (req, res) => {
  const { name, creator_id, member_ids } = req.body;
  try {
    const r = db.prepare('INSERT INTO groups (name, creator_id) VALUES (?, ?)').run(name, creator_id);
    const groupId = r.lastInsertRowid;
    const allMembers = [creator_id, ...member_ids];
    const stmt = db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
    allMembers.forEach(uid => stmt.run(groupId, uid));
    res.json({ id: groupId, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/groups/:user_id', (req, res) => {
  const groups = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
  `).all(parseInt(req.params.user_id));
  res.json(groups);
});

// --- Messages ---

app.get('/messages/:user_id/:target_id', (req, res) => {
  const { user_id, target_id } = req.params;
  const isGroup = req.query.isGroup === 'true';
  let messages;

  if (isGroup) {
    messages = db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY timestamp ASC').all(target_id);
  } else {
    messages = db.prepare(`
      SELECT * FROM messages
      WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)
      ORDER BY timestamp ASC
    `).all(user_id, target_id, target_id, user_id);
  }
  res.json(messages);
});

// --- WebSocket & WebRTC ---

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
        return;
      }

      if (!userId) return;

      // Handle direct messages & group messages
      if (msg.type === 'message') {
        const { to_id, group_id, content, file_url, file_type } = msg;
        const timestamp = Math.floor(Date.now() / 1000);
        
        const result = db.prepare(
          'INSERT INTO messages (from_id, to_id, group_id, content, file_url, file_type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(userId, to_id || null, group_id || null, content || '', file_url || '', file_type || '', timestamp);

        const savedMsg = { id: result.lastInsertRowid, from_id: userId, to_id, group_id, content, file_url, file_type, timestamp };

        if (group_id) {
          // Broadcast to all group members
          const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(group_id);
          members.forEach(m => {
            const memberWs = clients.get(m.user_id);
            if (memberWs && memberWs.readyState === 1) {
              memberWs.send(JSON.stringify({ type: 'message', message: savedMsg }));
            }
          });
        } else if (to_id) {
          const recipientWs = clients.get(to_id);
          if (recipientWs && recipientWs.readyState === 1) {
            recipientWs.send(JSON.stringify({ type: 'message', message: savedMsg }));
          }
          ws.send(JSON.stringify({ type: 'message_sent', message: savedMsg }));
        }
      }

      // Handle WebRTC signaling
      if (['call-offer', 'call-answer', 'call-ice', 'call-hangup'].includes(msg.type)) {
        const { to_id } = msg;
        const targetWs = clients.get(to_id);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ ...msg, from_id: userId }));
        }
      }

    } catch (e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => { if (userId) clients.delete(userId); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Greggerson Chat running on port ${PORT}`));
