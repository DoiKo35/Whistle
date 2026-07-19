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

// Создаем папку для загружаемых медиа и аватаров
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// Настройка Multer для сохранения файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Подключение к базе данных SQLite
const db = new sqlite3.Database('./whistle.db', (err) => {
  if (err) console.error('Ошибка подключения к БД:', err.message);
  else console.log('Подключено к базе данных SQLite.');
});

// Хранилище активных подключений и временных кодов для входа
const onlineUsers = {}; // Формат: { "ID_пользователя": "ID_сокета" }
const authCodes = {};   // Формат: { "ID_пользователя": "1234" }

db.serialize(() => {
  // Добавлены поля: phone, birthday, name_color
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    nickname TEXT,
    bio TEXT,
    avatar TEXT,
    phone TEXT,
    birthday TEXT,
    name_color TEXT
  )`);

  // Таблица сессий для управления устройствами
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    socket_id TEXT,
    device_name TEXT,
    ip TEXT,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    text TEXT,
    type TEXT,
    media_url TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Системный аккаунт теперь ссылается на локальную аватарку whistle.png
  db.run(`INSERT OR IGNORE INTO users (id, nickname, bio, avatar) 
          VALUES ('7777777', 'Whistle Notifications', 'system notifications', 'http://localhost:3000/uploads/whistle.png')`);
});

// Функция генерации 7-значного случайного ID
function generateNumericID() {
  return Math.floor(1000000 + Math.random() * 9000000).toString();
}

// ================= API: РЕГИСТРАЦИЯ =================
app.post('/api/register', (req, res) => {
  const { nickname } = req.body;
  if (!nickname) return res.status(400).json({ error: "Please, enter name." });

  const newId = generateNumericID();
  const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nickname)}&background=3390ec&color=fff`;

  db.run(`INSERT INTO users (id, nickname, bio, avatar) VALUES (?, ?, ?, ?)`,
    [newId, nickname, 'Hey there! I am using Whistle.', defaultAvatar],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Отправляем приветственное сообщение от официального аккаунта
      const welcomeText = `Добро пожаловать в Whistle! Ваш уникальный ID для входа: ${newId}. Сохраните его, он понадобится для авторизации на других устройствах.`;
      db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [newId, welcomeText]);
      
      db.get(`SELECT * FROM users WHERE id = ?`, [newId], (err, user) => {
        res.json({ user });
      });
    }
  );
});

// ================= API: АВТОРИЗАЦИЯ И 2FA =================
app.post('/api/login', (req, res) => {
  const { id, code, deviceName } = req.body; // Получаем имя устройства от клиента
  if (!id) return res.status(400).json({ error: "Введите ID" });

  db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Incorrect ID. User not found.' });

    // Проверка 2FA
    if (onlineUsers[id] && !code) {
      const verCode = Math.floor(1000 + Math.random() * 9000).toString();
      authCodes[id] = verCode;
      const msgText = `❗️ Code for login in Whistle: ${verCode}`;
      db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [id, msgText]);
      
      if (onlineUsers[id]) {
        io.to(onlineUsers[id]).emit('receive_message', {
          id: Date.now(), sender_id: '7777777', receiver_id: id, text: msgText, type: 'text', timestamp: new Date()
        });
      }
      return res.json({ requireCode: true });
    }

    if (code && authCodes[id] !== code) {
      return res.status(400).json({ error: 'Incorrect login code.' });
    }

    delete authCodes[id];

    // Успешный вход: генерируем ID сессии
    const sessionId = Math.random().toString(36).substring(2, 15);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientDevice = deviceName || 'Whistle Desktop Client';

    // Записываем сессию в БД
    db.run(`INSERT INTO sessions (session_id, user_id, device_name, ip) VALUES (?, ?, ?, ?)`, 
      [sessionId, user.id, clientDevice, ip], 
      function(dbErr) {
        // Отправляем уведомление о новом входе в чат Whistle Notifications
        const logMsg = `❗️ New login. \nDevice: ${clientDevice}\nIP: ${ip}\nIf it was not you, end session in "Devices"`;
        db.run(`INSERT INTO messages (sender_id, receiver_id, text, type) VALUES ('7777777', ?, ?, 'text')`, [user.id, logMsg]);

        res.json({ user, sessionId });
      }
    );
  });
});

// ================= API: ОБНОВЛЕНИЕ ПРОФИЛЯ =================
app.post('/api/profile/update', upload.single('avatar'), (req, res) => {
  const { id, nickname, bio, username, existing_avatar } = req.body;
  const avatarUrl = req.file ? `http://localhost:3000/uploads/${req.file.filename}` : existing_avatar;

  db.run(`UPDATE users SET nickname = ?, bio = ?, username = ?, avatar = ? WHERE id = ?`,
    [nickname || '', bio || '', username || null, avatarUrl, id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Error when updating profile. Maybe, @username not available.' });
      db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => res.json({ user }));
    }
  );
});

// ================= API: ПОЛУЧЕНИЕ СПИСКА ЧАТОВ И ПОЛЬЗОВАТЕЛЕЙ =================
app.get('/api/users/:currentId', (req, res) => {
  const { currentId } = req.params;
  // Возвращаем официальный чат первым, затем остальных пользователей (кроме самого себя)
  db.all(`SELECT * FROM users WHERE id != ? ORDER BY (id = '7777777') DESC, nickname ASC`, [currentId], (err, rows) => {
    res.json(rows || []);
  });
});

// ================= API: ИСТОРИЯ СООБЩЕНИЙ =================
app.get('/api/messages/:u1/:u2', (req, res) => {
  const { u1, u2 } = req.params;
  db.all(`SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY timestamp ASC`,
    [u1, u2, u2, u1], (err, rows) => res.json(rows || []));
});

// ================= API: ЗАГРУЗКА ФАЙЛОВ В ЧАТ =================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File not uploaded.' });
  res.json({ url: `http://localhost:3000/uploads/${req.file.filename}` });
});

// Получение списка активных сессий пользователя
app.get('/api/devices/:userId', (req, res) => {
  db.all(`SELECT session_id, device_name, ip, login_time FROM sessions WHERE user_id = ?`, [req.params.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Дистанционное завершение сессии (удаление устройства)
app.post('/api/devices/terminate', (req, res) => {
  const { userId, sessionId } = req.body;
  
  // Находим socket_id удаляемой сессии, чтобы отключить пользователя в реальном времени
  db.get(`SELECT socket_id FROM sessions WHERE session_id = ? AND user_id = ?`, [sessionId, userId], (err, session) => {
    if (session && session.socket_id) {
      const targetSocket = io.sockets.sockets.get(session.socket_id);
      if (targetSocket) {
        targetSocket.emit('forced_logout', { message: 'Session ended.' });
        targetSocket.disconnect();
      }
    }
    
    db.run(`DELETE FROM sessions WHERE session_id = ? AND user_id = ?`, [sessionId, userId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

// ================= WEBSOCKETS (Реальное время) =================
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
    db.run(`INSERT INTO messages (sender_id, receiver_id, text, type, media_url) VALUES (?, ?, ?, ?, ?)`,
      [sender_id, receiver_id, text, type || 'text', media_url || null],
      function(err) {
        const msgObj = { id: this.lastID, sender_id, receiver_id, text, type, media_url, timestamp: new Date() };
        if (onlineUsers[receiver_id]) {
          io.to(onlineUsers[receiver_id]).emit('receive_message', msgObj);
        }
        socket.emit('message_sent', msgObj);
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

server.listen(3000, () => console.log('Whistle Server запущен на порту 3000'));