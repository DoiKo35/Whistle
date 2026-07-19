const SERVER_URL = 'https://corned-halt-untapped.ngrok-free.dev';
const socket = io(SERVER_URL, {
  transports: ['websocket'], // Сразу используем веб-сокеты (они игнорируют текстовые заглушки Ngrok)
  extraHeaders: {
    "ngrok-skip-browser-warning": "true" // На случай, если сокет сначала сделает HTTP-запрос
  }
});

// Wrapper around fetch() that always sends the ngrok-skip-browser-warning header.
// Without this, ngrok's free-tier interstitial HTML page gets returned instead of
// JSON for any request that isn't the initial socket.io handshake, and res.json()
// throws silently - this was the root cause of logins/chats/profile saves failing.
function apiFetch(url, options = {}) {
  const headers = {
    'ngrok-skip-browser-warning': 'true',
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

let currentUser = null;
let currentSessionId = null;
let activeChat = null;
let allUsers = [];
let onlineUsersList = [];
let avatarFileToUpload = null;

// Avatar cropper state
let cropImage = new Image();
let cropState = { scale: 1, offsetX: 0, offsetY: 0, isDragging: false, startX: 0, startY: 0 };

// ================= SESSION CHECK =================
window.addEventListener('DOMContentLoaded', async () => {
  initGeometryCanvas();
  
  const savedTheme = localStorage.getItem('whistle_theme') || 'light-theme';
  document.body.className = savedTheme;
  const themeCheckbox = document.querySelector('.night-mode-li input[type="checkbox"]');
  if (themeCheckbox) {
    themeCheckbox.checked = (savedTheme === 'dark-theme');
  }

  const savedId = localStorage.getItem('whistle_id');
  if (savedId) {
    try {
      const res = await apiFetch(`${SERVER_URL}/api/login`, {
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
    } catch (e) { console.log('Invalid session or offline'); }
  }
  showScreen('welcome-screen');
});

function startApplication() {
  showScreen('app-screen');
  updateMenuUI();
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

// ================= AUTHENTICATION =================
async function registerAccount() {
  const nickname = document.getElementById('reg-nickname').value.trim();
  if (!nickname) return alert('Please enter your name.');

  const res = await apiFetch(`${SERVER_URL}/api/register`, {
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname })
  });
  const data = await res.json();
  if (data.user) {
    currentUser = data.user;
    currentSessionId = data.sessionId;
    localStorage.setItem('whistle_id', currentUser.id);
    startApplication();
  }
}

async function loginAccount() {
  const id = document.getElementById('login-id').value.trim();
  const code = document.getElementById('login-code').value.trim();
  if (!id) return alert('Please enter your 7-digit Whistle ID.');

  const res = await apiFetch(`${SERVER_URL}/api/login`, {
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, code, deviceName: navigator.userAgent.split(') ')[0] + ')' })
  });
  const data = await res.json();

  if (data.requireCode) {
    document.getElementById('code-group').classList.remove('hidden');
    alert('This account is active on another device! A verification code has been sent to your Whistle system chat.');
    return;
  }

  if (data.error) return alert(data.error);

  if (data.user) {
    currentUser = data.user;
    currentSessionId = data.sessionId;
    localStorage.setItem('whistle_id', currentUser.id);
    startApplication();
  }
}

function logout() {
  localStorage.removeItem('whistle_id');
  localStorage.removeItem('whistle_session_id');
  location.reload();
}

// ================= USERS & CHAT LIST =================
async function loadRealUsers() {
  const res = await apiFetch(`${SERVER_URL}/api/users/${currentUser.id}`);
  allUsers = await res.json();
  renderChatsList(allUsers);
}

function formatChatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }
}

function renderChatsList(users) {
  const list = document.getElementById('chats-list');
  list.innerHTML = '';

  users.forEach(u => {
    const div = document.createElement('div');
    div.className = `chat-item ${activeChat && activeChat.id === u.id ? 'active' : ''}`;
    
    // Determine preview text
    let previewText = u.bio || 'No description';
    if (u.last_msg_text) {
      previewText = u.last_msg_type === 'image' ? '📷 Photo' : u.last_msg_text;
    }

    const timeStr = formatChatTime(u.last_msg_time);
    const unreadBadge = u.unread_count > 0 ? `<span class="chat-badge">${u.unread_count}</span>` : '';

    div.innerHTML = `
      <img class="chat-avatar" src="${u.avatar}" alt="avatar">
      <div class="chat-info">
        <div class="chat-top-line">
          <span class="chat-name">${u.nickname} ${u.id === '7777777' ? '<i class="fa-solid fa-circle-check" style="color: #3390ec;"></i>' : ''}</span>
          <span class="chat-time">${timeStr}</span>
        </div>
        <div class="chat-bottom-line">
          <span class="chat-preview">${previewText}</span>
          ${unreadBadge}
        </div>
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

// ================= MESSAGING AREA =================
async function selectChat(contact, element) {
  activeChat = contact;
  document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
  element.classList.add('active');

  document.getElementById('chat-header').classList.remove('hidden');
  document.getElementById('chat-input-area').classList.remove('hidden');
  document.getElementById('chat-contact-name').innerHTML = `${contact.nickname}`;
  
  updateContactStatusUI();

  // Mark unread messages as read
  if (contact.unread_count > 0) {
    socket.emit('mark_as_read', { sender_id: contact.id, receiver_id: currentUser.id });
    contact.unread_count = 0;
    renderChatsList(allUsers);
  }

  const res = await apiFetch(`${SERVER_URL}/api/messages/${currentUser.id}/${contact.id}`);
  const messages = await res.json();
  
  const container = document.getElementById('messages-container');
  container.innerHTML = '';
  
  let lastDateStr = null;
  messages.forEach(msg => {
    const msgDate = new Date(msg.timestamp).toDateString();
    if (msgDate !== lastDateStr) {
      appendDateHeader(msg.timestamp);
      lastDateStr = msgDate;
    }
    appendMessageUI(msg);
  });
  container.scrollTop = container.scrollHeight;
}

function updateContactStatusUI() {
  if (!activeChat) return;
  const statusEl = document.getElementById('chat-contact-status');
  
  if (activeChat.id === '7777777') {
    statusEl.textContent = 'system notifications';
    statusEl.style.color = '#e53935';
  } else {
    const isOnline = onlineUsersList.includes(activeChat.id);
    statusEl.textContent = isOnline ? 'online' : 'offline';
    statusEl.style.color = isOnline ? '#3390ec' : 'var(--text-secondary)';
  }
}

function appendDateHeader(timestamp) {
  const container = document.getElementById('messages-container');
  const date = new Date(timestamp);
  const now = new Date();
  let dateText = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  
  if (date.toDateString() === now.toDateString()) {
    dateText = 'Today';
  } else {
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      dateText = 'Yesterday';
    }
  }

  const div = document.createElement('div');
  div.className = 'date-header';
  div.innerHTML = `<span>${dateText}</span>`;
  container.appendChild(div);
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

  const res = await apiFetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: formData });
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
  div.dataset.id = msg.id;
  
  let contentHtml = '';
  if (msg.type === 'image' && msg.media_url) {
    contentHtml += `<img src="${msg.media_url}" alt="image">`;
  } else {
    contentHtml += `<div class="msg-text">${msg.text}</div>`;
  }

  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  let checkmarkHtml = '';
  if (isOut) {
    const checkIcon = msg.is_read ? 'fa-check-double' : 'fa-check';
    checkmarkHtml = `<i class="fa-solid ${checkIcon} msg-check"></i>`;
  }

  contentHtml += `<div class="msg-meta"><span class="msg-time">${timeStr}</span>${checkmarkHtml}</div>`;

  div.innerHTML = contentHtml;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ================= SOCKET EVENTS =================
socket.on('receive_message', (msg) => {
  try { document.getElementById('sound-out').play(); } catch(e){}
  
  if (activeChat && activeChat.id === msg.sender_id) {
    appendMessageUI(msg);
    socket.emit('mark_as_read', { sender_id: msg.sender_id, receiver_id: currentUser.id });
  } else {
    // Increment unread count in sidebar
    const sender = allUsers.find(u => u.id === msg.sender_id);
    if (sender) {
      sender.unread_count = (sender.unread_count || 0) + 1;
      sender.last_msg_text = msg.type === 'image' ? '📷 Photo' : msg.text;
      sender.last_msg_time = msg.timestamp;
      renderChatsList(allUsers);
    }
  }
});

socket.on('message_sent', (msg) => {
  try { document.getElementById('sound-out').play(); } catch(e){}
  appendMessageUI(msg);
  
  // Update last message in sidebar
  if (activeChat) {
    activeChat.last_msg_text = msg.type === 'image' ? '📷 Photo' : msg.text;
    activeChat.last_msg_time = msg.timestamp;
    renderChatsList(allUsers);
  }
});

socket.on('messages_read', ({ by_user }) => {
  if (activeChat && activeChat.id === by_user) {
    document.querySelectorAll('.msg.out .msg-check').forEach(icon => {
      icon.classList.remove('fa-check');
      icon.classList.add('fa-check-double');
    });
  }
});

socket.on('online_status', (onlineIds) => {
  onlineUsersList = onlineIds;
  updateContactStatusUI();
});

// ================= PROFILE EDITING & AVATAR CROPPER =================
function updateMenuUI() {
  document.getElementById('menu-nickname').textContent = currentUser.nickname;
  document.getElementById('menu-id-display').textContent = `ID: ${currentUser.id}`;
  document.getElementById('menu-avatar').src = currentUser.avatar;
}

function openProfileModal() {
  document.getElementById('profile-modal').classList.remove('hidden');
  document.getElementById('edit-nickname').value = currentUser.nickname || '';
  document.getElementById('edit-username').value = currentUser.username || '';
  document.getElementById('edit-phone').value = currentUser.phone || '';
  document.getElementById('edit-bio').value = currentUser.bio || '';
  document.getElementById('edit-birthday').value = currentUser.birthday || '';
  document.getElementById('edit-avatar-preview').src = currentUser.avatar;
  avatarFileToUpload = null;
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.add('hidden');
}

// Avatar Cropper Logic
function openAvatarCropper(input) {
  if (!input.files[0]) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    cropImage.src = e.target.result;
    cropImage.onload = () => {
      document.getElementById('avatar-crop-modal').classList.remove('hidden');
      cropState = { scale: 1, offsetX: 0, offsetY: 0, isDragging: false, startX: 0, startY: 0 };
      document.getElementById('crop-zoom').value = 1;
      drawCropCanvas();
    };
  };
  reader.readAsDataURL(input.files[0]);
}

function closeAvatarCropper() {
  document.getElementById('avatar-crop-modal').classList.add('hidden');
  document.getElementById('avatar-input').value = '';
}

function drawCropCanvas() {
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const minDim = Math.min(cropImage.width, cropImage.height);
  const baseScale = canvas.width / minDim;
  const totalScale = baseScale * cropState.scale;
  
  const drawW = cropImage.width * totalScale;
  const drawH = cropImage.height * totalScale;
  
  const x = (canvas.width - drawW) / 2 + cropState.offsetX;
  const y = (canvas.height - drawH) / 2 + cropState.offsetY;
  
  ctx.drawImage(cropImage, x, y, drawW, drawH);
}

// Canvas Mouse Drag & Zoom events
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('crop-canvas');
  const zoomSlider = document.getElementById('crop-zoom');

  if (canvas) {
    canvas.addEventListener('mousedown', (e) => {
      cropState.isDragging = true;
      cropState.startX = e.clientX - cropState.offsetX;
      cropState.startY = e.clientY - cropState.offsetY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!cropState.isDragging) return;
      cropState.offsetX = e.clientX - cropState.startX;
      cropState.offsetY = e.clientY - cropState.startY;
      drawCropCanvas();
    });
    window.addEventListener('mouseup', () => cropState.isDragging = false);
  }

  if (zoomSlider) {
    zoomSlider.addEventListener('input', (e) => {
      cropState.scale = parseFloat(e.target.value);
      drawCropCanvas();
    });
  }
});

function applyAvatarCrop() {
  const canvas = document.getElementById('crop-canvas');
  canvas.toBlob((blob) => {
    avatarFileToUpload = new File([blob], "custom_avatar.png", { type: "image/png" });
    document.getElementById('edit-avatar-preview').src = URL.createObjectURL(avatarFileToUpload);
    closeAvatarCropper();
  }, 'image/png');
}

async function saveProfile() {
  const usernameVal = document.getElementById('edit-username').value.trim();
  if (usernameVal && (usernameVal.length < 3 || usernameVal.length > 32)) {
    return alert('Username must be between 3 and 32 characters long.');
  }

  const formData = new FormData();
  formData.append('id', currentUser.id);
  formData.append('nickname', document.getElementById('edit-nickname').value.trim());
  formData.append('username', usernameVal);
  formData.append('phone', document.getElementById('edit-phone').value.trim());
  formData.append('bio', document.getElementById('edit-bio').value.trim());
  formData.append('birthday', document.getElementById('edit-birthday').value.trim());
  formData.append('existing_avatar', currentUser.avatar);
  if (avatarFileToUpload) formData.append('avatar', avatarFileToUpload);

  const res = await apiFetch(`${SERVER_URL}/api/profile/update`, { method: 'POST', body: formData });
  const data = await res.json();
  
  if (data.user) {
    currentUser = data.user;
    updateMenuUI();
    closeProfileModal();
    loadRealUsers();
  } else {
    alert(data.error || 'Error updating profile.');
  }
}

// ================= MODALS & UTILS =================
function toggleMenu() {
  document.getElementById('side-menu').classList.toggle('hidden');
  document.getElementById('side-menu-overlay').classList.toggle('hidden');
}

function toggleNightMode(checkbox) {
  const theme = checkbox.checked ? 'dark-theme' : 'light-theme';
  document.body.className = theme;
  localStorage.setItem('whistle_theme', theme);
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

function viewActiveChatProfile() {
  if (!activeChat) return;
  
  document.getElementById('view-avatar').src = activeChat.avatar || 'https://ui-avatars.com/api/?name=U';
  document.getElementById('view-nickname').textContent = activeChat.nickname;
  document.getElementById('view-username').textContent = activeChat.username ? `@${activeChat.username}` : '@not set';
  document.getElementById('view-phone').textContent = activeChat.phone || 'Unknown';
  document.getElementById('view-bio').textContent = activeChat.bio || 'No bio.';
  document.getElementById('view-birthday').textContent = activeChat.birthday || 'Unknown';

  document.getElementById('view-profile-modal').classList.remove('hidden');
}

async function openDevicesModal() {
  document.getElementById('devices-modal').classList.remove('hidden');
  const res = await apiFetch(`${SERVER_URL}/api/devices/${currentUser.id}`);
  const devices = await res.json();
  
  const container = document.getElementById('devices-list');
  container.innerHTML = '';
  
  if (devices.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary);">No active devices.</p>';
    return;
  }

  devices.forEach(d => {
    const isCurrent = d.session_id === currentSessionId;
    const div = document.createElement('div');
    div.className = 'device-item';
    div.innerHTML = `
      <div class="device-info-text">
        <strong>${d.device_name} ${isCurrent ? '<span style="color: green;">(Current)</span>' : ''}</strong>
        <small>IP: ${d.ip} | Logged in: ${new Date(d.login_time).toLocaleString('en-GB')}</small>
      </div>
      ${!isCurrent ? `<button class="btn-terminate" onclick="terminateSession('${d.session_id}')">Log out</button>` : ''}
    `;
    container.appendChild(div);
  });
}

async function terminateSession(sessionId) {
  if (!confirm('Are you sure you want to terminate this session?')) return;
  
  const res = await apiFetch(`${SERVER_URL}/api/devices/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, sessionId })
  });
  
  if (res.ok) {
    openDevicesModal();
  }
}