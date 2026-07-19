const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Create folder for uploaded media and avatars
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Build the externally-reachable base URL from the incoming request, instead of
// hardcoding http://localhost:3000. This makes avatar/upload links work whether
// you're on the same machine as the server or connecting through the ngrok tunnel.
function getBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = forwardedProto ? forwardedProto.split(',')[0] : req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// Connect to SQLite Database
const db = new sqlite3.Database('./whistle.db', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite Database.');
});

// Active sockets and temporary 2FA codes
const onlineUsers = {}; // Format: { "user_id": "socket_id" }
const authCodes = {};   // Format: { "user_id": "1234" }

db.serialize(() => {
  // Users table without name_color, with proper birthday date format
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    nickname TEXT,
    bio TEXT,
    avatar TEXT,
    phone TEXT,
    birthday TEXT
  )`);

  // Sessions table for device management
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    socket_id TEXT,
    device_name TEXT,
    ip TEXT,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Messages table with is_read status
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    text TEXT,
    type TEXT,
    media_url TEXT,
    is_read INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // System account
  db.run(`INSERT OR IGNORE INTO users (id, nickname, bio, avatar) 
          VALUES ('7777777', 'Whistle Notifications', 'Official system notifications', 'http://localhost:3000/uploads/whistle.png')`);
});

function generateNumericID() {
  return Math.floor(1000000 + Math.random() * 9000000).toString();
}

// ================= API: REGISTER =================
app.post('/api/register', (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: "Please enter your name." });

  const newId = generateNumericID();
  const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=3390ec&color=fff`;

  db.run(`INSERT INTO users (id, nickname, bio, avatar) VALUES (?, ?, ?, ?)`,
    [newId, nickname, 'Hey there! I am using Whistle.', defaultAvatar],
    function(err) {
      if (err) { console.error('DB error:', err.message); return res.status(500).json({ error: err.message }); }
      
      const welcomeText = `Welcome to Whistle! Your unique login ID is: ${newId}. Save it, as you will need it to log in on other devices.`;
      db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [newId, welcomeText]);
      
      db.get(`SELECT * FROM users WHERE id = ?`, [newId], (err, user) => {
        res.json({ user });
      });
    }
  );
});

// ================= API: LOGIN & 2FA =================
app.post('/api/login', (req, res) => {
  const { id, code, deviceName } = req.body;
  if (!id) return res.status(400).json({ error: "Please enter your Whistle ID." });

  db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Incorrect ID. User not found.' });

    // 2FA check if already logged in elsewhere
    if (onlineUsers[id] && !code) {
      const verCode = Math.floor(1000 + Math.random() * 9000).toString();
      authCodes[id] = verCode;
      const msgText = `❗️ Verification code for Whistle login: ${verCode}`;
      db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [id, msgText]);
      
      if (onlineUsers[id]) {
        io.to(onlineUsers[id]).emit('receive_message', {
          id: Date.now(), sender_id: '7777777', receiver_id: id, text: msgText, type: 'text', timestamp: new Date(), is_read: 0
        });
      }
      return res.json({ requireCode: true });
    }

    if (code && authCodes[id] !== code) {
      return res.status(400).json({ error: 'Incorrect verification code.' });
    }

    delete authCodes[id];

    const sessionId = Math.random().toString(36).substring(2, 15);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientDevice = deviceName || 'Whistle Desktop Client';

    db.run(`INSERT INTO sessions (session_id, user_id, device_name, ip) VALUES (?, ?, ?, ?)`, 
      [sessionId, user.id, clientDevice, ip], 
      function(dbErr) {
        const logMsg = `❗️ New login detected.\nDevice: ${clientDevice}\nIP: ${ip}\nIf this was not you, terminate the session in "Devices".`;
        db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [user.id, logMsg]);

        res.json({ user, sessionId });
      }
    );
  });
});

// ================= API: PROFILE UPDATE =================
app.post('/api/profile/update', upload.single('avatar'), (req, res) => {
  const { id, nickname, bio, username, phone, birthday, existing_avatar } = req.body;
  const avatarUrl = req.file ? `${getBaseUrl(req)}/uploads/${req.file.filename}` : existing_avatar;

  // Validate username
  let cleanUsername = null;
  if (username && username.trim() !== '') {
    cleanUsername = username.trim().replace(/^@/, '');
    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
      return res.status(400).json({ error: 'Username must be between 3 and 32 characters long.' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores.' });
    }
  }

  db.run(`UPDATE users SET nickname = ?, bio = ?, username = ?, phone = ?, birthday = ?, avatar = ? WHERE id = ?`,
    [nickname || '', bio || '', cleanUsername, phone || '', birthday || '', avatarUrl, id],
    function(err) {
      if (err) {
        // ВОТ СЮДА ДОБАВЛЯЕМ ВЫВОД ОШИБКИ В КОНСОЛЬ ТЕРМИНАЛА:
        console.error("❌ И КСТАТИ ВОТ ОШИБКА БАЗЫ ДАННЫХ:", err.message);
        return res.status(500).json({ error: 'Error updating profile. The @username might already be taken.' });
      }
      db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => res.json({ user }));
    }
  );
});

// ================= API: USERS & CHAT LIST (WITH LAST MESSAGE & UNREAD COUNT) =================
app.get('/api/users/:currentId', (req, res) => {
  const { currentId } = req.params;
  const sql = `
    SELECT u.*,
      (SELECT text FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY timestamp DESC LIMIT 1) as last_msg_text,
      (SELECT type FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY timestamp DESC LIMIT 1) as last_msg_type,
      (SELECT timestamp FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY timestamp DESC LIMIT 1) as last_msg_time,
      (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread_count
    FROM users u
    WHERE u.id != ?
    ORDER BY (u.id = '7777777') DESC, last_msg_time DESC, u.nickname ASC
  `;
  db.all(sql, [currentId, currentId, currentId, currentId, currentId, currentId, currentId, currentId], (err, rows) => {
    if (err) { console.error('DB error:', err.message); return res.status(500).json({ error: err.message }); }
    res.json(rows || []);
  });
});

// ================= API: MESSAGE HISTORY =================
app.get('/api/messages/:u1/:u2', (req, res) => {
  const { u1, u2 } = req.params;
  db.all(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY timestamp ASC`,
    [u1, u2, u2, u1], (err, rows) => res.json(rows || []));
});

// ================= API: FILE UPLOAD =================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File upload failed.' });
  res.json({ url: `${getBaseUrl(req)}/uploads/${req.file.filename}` });
});

// Get user active sessions
app.get('/api/devices/:userId', (req, res) => {
  db.all(`SELECT session_id, device_name, ip, login_time FROM sessions WHERE user_id = ?`, [req.params.userId], (err, rows) => {
    if (err) { console.error('DB error:', err.message); return res.status(500).json({ error: err.message }); }
    res.json(rows || []);
  });
});

// Remote session termination
app.post('/api/devices/terminate', (req, res) => {
  const { userId, sessionId } = req.body;
  
  db.get(`SELECT socket_id FROM sessions WHERE session_id = ? AND user_id = ?`, [sessionId, userId], (err, session) => {
    if (session && session.socket_id) {
      const targetSocket = io.sockets.sockets.get(session.socket_id);
      if (targetSocket) {
        targetSocket.emit('forced_logout', { message: 'Your session has been terminated from another device.' });
        targetSocket.disconnect();
      }
    }
    
    db.run(`DELETE FROM sessions WHERE session_id = ? AND user_id = ?`, [sessionId, userId], function(err) {
      if (err) { console.error('DB error:', err.message); return res.status(500).json({ error: err.message }); }
      res.json({ success: true });
    });
  });
});

// ================= WEBSOCKETS =================
io.on('connection', (socket) => {
  socket.on('register_socket', ({ userId, sessionId }) => {
    onlineUsers[userId] = socket.id;
    if (sessionId) {
      db.run(`UPDATE sessions SET socket_id = ? WHERE session_id = ?`, [socket.id, sessionId]);
    }
    io.emit('online_status', Object.keys(onlineUsers));
  });

  socket.on('send_message', (data) => {
    const { sender_id, receiver_id, text, type, media_url } = data;
    const timestamp = new Date().toISOString();
    
    db.run(`INSERT INTO messages (sender_id, receiver_id, text, type, media_url, is_read, timestamp) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [sender_id, receiver_id, text, type || 'text', media_url || null, timestamp],
      function(err) {
        const msgObj = { id: this.lastID, sender_id, receiver_id, text, type, media_url, is_read: 0, timestamp };
        if (onlineUsers[receiver_id]) {
          io.to(onlineUsers[receiver_id]).emit('receive_message', msgObj);
        }
        socket.emit('message_sent', msgObj);
      }
    );
  });

  // Mark messages as read
  socket.on('mark_as_read', ({ sender_id, receiver_id }) => {
    db.run(`UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [sender_id, receiver_id], function(err) {
        if (this.changes > 0 && onlineUsers[sender_id]) {
          io.to(onlineUsers[sender_id]).emit('messages_read', { by_user: receiver_id });
        }
      }
    );
  });

  socket.on('disconnect', () => {
    for (let uid in onlineUsers) {
      if (onlineUsers[uid] === socket.id) delete onlineUsers[uid];
    }
    io.emit('online_status', Object.keys(onlineUsers));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'website/index.html'));
});

server.listen(3000, () => console.log('Whistle Server running on port 3000'));