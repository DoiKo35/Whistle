const SERVER_URL = 'https://ninety-camels-bet.loca.lt/';
const socket = io(SERVER_URL);

let currentUser = null;
let activeChat = null;
let allUsers = [];
let onlineUsersList = [];
let avatarFileToUpload = null;

// ================= ПРОВЕРКА СЕССИИ (АВТО-ВХОД) =================
window.addEventListener('DOMContentLoaded', async () => {
  initGeometryCanvas();
  const savedId = localStorage.getItem('whistle_id');
  if (savedId) {
    try {
      const res = await fetch(`${SERVER_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: savedId, deviceName: navigator.userAgent.split(') ')[0] + ')' })
      });
      const data = await res.json();
      if (data.user) {
        currentUser = data.user;
        currentSessionId = data.sessionId;
        localStorage.setItem('whistle_session_id', data.sessionId);
        startApplication();
        return;
      }
    } catch (e) { console.log('Сессия недействительна'); }
  }
  showScreen('welcome-screen');
});

function startApplication() {
  showScreen('app-screen');
  updateMenuUI();
  // Передаем и ID пользователя, и ID сессии для связки сокета
  socket.emit('register_socket', { userId: currentUser.id, sessionId: currentSessionId });
  loadRealUsers();
}

socket.on('forced_logout', (data) => {
  alert(data.message);
  logout();
});

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');
}

// ================= РЕГИСТРАЦИЯ И ВХОД =================
async function registerAccount() {
  const nickname = document.getElementById('reg-nickname').value.trim();
  if (!nickname) return alert('Пожалуйста, введите ваше имя');

  const res = await fetch(`${SERVER_URL}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname })
  });
  const data = await res.json();
  if (data.user) {
    currentUser = data.user;
    localStorage.setItem('whistle_id', currentUser.id);
    startApplication();
  }
}

async function loginAccount() {
  const id = document.getElementById('login-id').value.trim();
  const code = document.getElementById('login-code').value.trim();
  if (!id) return alert('Введите 7-значный ID');

  const res = await fetch(`${SERVER_URL}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, code })
  });
  const data = await res.json();

  if (data.requireCode) {
    document.getElementById('code-group').classList.remove('hidden');
    alert('Этот аккаунт активен на другом устройстве! Мы отправили проверочный код в служебный чат Whistle.');
    return;
  }

  if (data.error) return alert(data.error);

  if (data.user) {
    currentUser = data.user;
    localStorage.setItem('whistle_id', currentUser.id);
    startApplication();
  }
}

function logout() {
  localStorage.removeItem('whistle_id');
  location.reload();
}

// ================= ЗАГРУЗКА РЕАЛЬНЫХ ЧАТОВ =================
async function loadRealUsers() {
  const res = await fetch(`${SERVER_URL}/api/users/${currentUser.id}`);
  allUsers = await res.json();
  renderChatsList(allUsers);
}

function renderChatsList(users) {
  const list = document.getElementById('chats-list');
  list.innerHTML = '';

  users.forEach(u => {
    const isOnline = onlineUsersList.includes(u.id);
    const div = document.createElement('div');
    div.className = `chat-item ${activeChat && activeChat.id === u.id ? 'active' : ''}`;
    div.innerHTML = `
      <img class="chat-avatar" src="${u.avatar}" alt="avatar">
      <div class="chat-info">
        <span class="chat-name">${u.nickname} ${u.id === '7777777' ? '<i class="fa-solid fa-circle-check" style="color: #3390ec;"></i>' : ''}</span>
        <span class="chat-preview">${u.bio || 'Нет описания'}</span>
      </div>
    `;
    div.onclick = () => selectChat(u, div);
    list.appendChild(div);
  });
}

function filterChats() {
  const query = document.getElementById('search-input').value.toLowerCase().replace('@', '');
  const filtered = allUsers.filter(u => 
    u.nickname.toLowerCase().includes(query) || 
    u.id.includes(query) || 
    (u.username && u.username.toLowerCase().includes(query))
  );
  renderChatsList(filtered);
}

// ================= РАБОТА С ЧАТОМ =================
async function selectChat(contact, element) {
  activeChat = contact;
  document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');

  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-contact-name').innerHTML = `${contact.nickname}`;
  
  const statusEl = document.getElementById('chat-contact-status');
  
  if (contact.id === '7777777') {
    statusEl.textContent = 'system notifications'; // Уникальный статус для системного бота
    statusEl.style.color = '#e53935';
  } else {
    const isOnline = onlineUsersList.includes(contact.id);
    statusEl.textContent = isOnline ? 'online' : 'offline';
    statusEl.style.color = isOnline ? '#3390ec' : 'var(--text-secondary)';
  }

  const res = await fetch(`${SERVER_URL}/api/messages/${currentUser.id}/${contact.id}`);
  const messages = await res.json();
  const container = document.getElementById('messages-container');
  container.innerHTML = '';
  messages.forEach(msg => appendMessageUI(msg));
  container.scrollTop = container.scrollHeight;
}

function sendTextMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !activeChat) return;

  socket.emit('send_message', {
    sender_id: currentUser.id,
    receiver_id: activeChat.id,
    text: text,
    type: 'text'
  });

  input.value = '';
}

async function sendImageFile(input) {
  if (!input.files[0] || !activeChat) return;
  const formData = new FormData();
  formData.append('file', input.files[0]);

  const res = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: formData });
  const data = await res.json();

  if (data.url) {
    socket.emit('send_message', {
      sender_id: currentUser.id,
      receiver_id: activeChat.id,
      text: 'Photo',
      type: 'image',
      media_url: data.url
    });
  }
}

function appendMessageUI(msg) {
  const container = document.getElementById('messages-container');
  const isOut = msg.sender_id === currentUser.id;
  
  const div = document.createElement('div');
  div.className = `msg ${isOut ? 'out' : 'in'}`;
  
  let contentHtml = '';
  if (msg.type === 'image' && msg.media_url) {
    contentHtml += `<img src="${msg.media_url}" alt="image">`;
  } else {
    contentHtml += `<div class="msg-text">${msg.text}</div>`;
  }

  div.innerHTML = contentHtml;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ================= СОБЫТИЯ WEBSOCKET =================
socket.on('receive_message', (msg) => {
  document.getElementById('sound-out').play();
  if (activeChat && (activeChat.id === msg.sender_id || activeChat.id === msg.receiver_id)) {
    appendMessageUI(msg);
  }
});

socket.on('message_sent', (msg) => {
  document.getElementById('sound-out').play();
  appendMessageUI(msg);
});

socket.on('online_status', (onlineIds) => {
  onlineUsersList = onlineIds;
  if (allUsers.length > 0) renderChatsList(allUsers);
  if (activeChat) {
    const isOnline = onlineUsersList.includes(activeChat.id) || activeChat.id === '7777777';
    document.getElementById('chat-contact-status').textContent = isOnline ? 'online' : 'offline';
    document.getElementById('chat-contact-status').style.color = isOnline ? '#3390ec' : 'var(--text-secondary)';
  }
});

// ================= РЕДАКТИРОВАНИЕ ПРОФИЛЯ =================
function updateMenuUI() {
  document.getElementById('menu-nickname').textContent = currentUser.nickname;
  document.getElementById('menu-id-display').textContent = `ID: ${currentUser.id}`;
  document.getElementById('menu-avatar').src = currentUser.avatar;
}

function openProfileModal() {
  document.getElementById('profile-modal').classList.remove('hidden');
  document.getElementById('edit-nickname').value = currentUser.nickname || '';
  document.getElementById('edit-username').value = currentUser.username || '';
  document.getElementById('edit-bio').value = currentUser.bio || '';
  document.getElementById('edit-avatar-preview').src = currentUser.avatar;
  avatarFileToUpload = null;
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

function previewAvatar(input) {
  if (input.files[0]) {
    avatarFileToUpload = input.files[0];
    document.getElementById('edit-avatar-preview').src = URL.createObjectURL(avatarFileToUpload);
  }
}

async function saveProfile() {
  const formData = new FormData();
  formData.append('id', currentUser.id);
  formData.append('nickname', document.getElementById('edit-nickname').value.trim());
  formData.append('username', document.getElementById('edit-username').value.trim());
  formData.append('bio', document.getElementById('edit-bio').value.trim());
  formData.append('existing_avatar', currentUser.avatar);
  if (avatarFileToUpload) formData.append('avatar', avatarFileToUpload);

  const res = await fetch(`${SERVER_URL}/api/profile/update`, { method: 'POST', body: formData });
  const data = await res.json();
  
  if (data.user) {
    currentUser = data.user;
    updateMenuUI();
    closeProfileModal();
    loadRealUsers();
  } else {
    alert(data.error || 'Ошибка обновления');
  }
}

// ================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =================
function toggleMenu() {
  document.getElementById('side-menu').classList.toggle('hidden');
  document.getElementById('side-menu-overlay').classList.toggle('hidden');
}

function toggleNightMode(checkbox) {
  document.body.className = checkbox.checked ? 'dark-theme' : 'light-theme';
}

function initGeometryCanvas() {
  const canvas = document.getElementById('geometry-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight * 0.45; }
  window.addEventListener('resize', resize); resize();
  
  const particles = Array.from({ length: 25 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 1, vy: (Math.random() - 0.5) * 1, radius: 2
  }));

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    particles.forEach((p, i) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
      for (let j = i + 1; j < particles.length; j++) {
        if (Math.hypot(p.x - particles[j].x, p.y - particles[j].y) < 90) {
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(particles[j].x, particles[j].y); ctx.stroke();
        }
      }
    });
    requestAnimationFrame(animate);
  }
  animate();
}

// Открытие профиля активного собеседника
function viewActiveChatProfile() {
  if (!activeChat) return;
  
  document.getElementById('view-avatar').src = activeChat.avatar || 'https://ui-avatars.com/api/?name=U';
  document.getElementById('view-nickname').textContent = activeChat.nickname;
  document.getElementById('view-username').textContent = activeChat.username ? `@${activeChat.username}` : '@не указан';
  document.getElementById('view-phone').textContent = activeChat.phone || 'не указан';
  document.getElementById('view-bio').textContent = activeChat.bio || 'нет описания';
  document.getElementById('view-birthday').textContent = activeChat.birthday || 'не указан';
  
  // Применение цвета имени, если он сохранен
  if(activeChat.name_color) {
     document.getElementById('view-nickname').style.color = activeChat.name_color;
  } else {
     document.getElementById('view-nickname').style.color = 'var(--text-main)';
  }

  document.getElementById('view-profile-modal').classList.remove('hidden');
}

// Открытие списка устройств
async function openDevicesModal() {
  document.getElementById('devices-modal').classList.remove('hidden');
  const res = await fetch(`${SERVER_URL}/api/devices/${currentUser.id}`);
  const devices = await res.json();
  
  const container = document.getElementById('devices-list');
  container.innerHTML = '';
  
  if(devices.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary);">No active devices.</p>';
    return;
  }

  devices.forEach(d => {
    const isCurrent = d.session_id === currentSessionId;
    const div = document.createElement('div');
    div.className = 'device-item';
    div.innerHTML = `
      <div class="device-info-text">
        <strong>${d.device_name} ${isCurrent ? '<span style="color: green;">(Текущее)</span>' : ''}</strong>
        <small>IP: ${d.ip} | Вошел: ${new Date(d.login_time).toLocaleString()}</small>
      </div>
      ${!isCurrent ? `<button class="btn-terminate" onclick="terminateSession('${d.session_id}')">Log out</button>` : ''}
    `;
    container.appendChild(div);
  });
}

// Удаленное завершение сессии
async function terminateSession(sessionId) {
  if (!confirm('Are you sure?')) return;
  
  const res = await fetch(`${SERVER_URL}/api/devices/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, sessionId })
  });
  
  if (res.ok) {
    openDevicesModal(); // Обновляем список окон
  }
}