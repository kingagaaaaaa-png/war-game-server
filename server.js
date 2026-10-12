const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

const gameState = { players: {}, chat: [] };

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'سرور بازی جنگ جهانی روشنه',
    players: Object.keys(gameState.players).length,
    time: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log('بازیکن وصل شد:', socket.id);

  // ورود یا ثبت‌نام
  socket.on('login', ({ name, password }) => {
    if (!name || !password) {
      socket.emit('login_result', { ok: false, error: 'اسم و پسورد لازمه' });
      return;
    }
    const existing = gameState.players[name];
    
    if (!existing) {
      // بازیکن جدید - ثبت‌نام
      gameState.players[name] = {
        name: name,
        password: password,
        money: 16000,
        countries: [],
        inventory: {},
        allies: [],
        notifications: [],
        online: true,
        lastIncomeTime: Date.now()
      };
      socket.playerName = name;
      socket.emit('login_result', { ok: true, isNew: true });
      io.emit('players', gameState.players);
      socket.emit('chat_history', gameState.chat);
      console.log('بازیکن جدید ثبت شد:', name);
      return;
    }
    
    // بازیکن قبلی - چک پسورد
    if (existing.password !== password) {
      socket.emit('login_result', { ok: false, error: 'پسورد اشتباهه!' });
      return;
    }
    
    existing.online = true;
    socket.playerName = name;
    socket.emit('login_result', { ok: true, isNew: false });
    io.emit('players', gameState.players);
    socket.emit('chat_history', gameState.chat);
    console.log('بازیکن وارد شد:', name);
  });

  socket.on('buy', (data) => {
    const { name, itemId, qty, price } = data;
    const p = gameState.players[name];
    if (!p) return;
    const cost = price * qty;
    if (p.money < cost) { socket.emit('error_msg', 'موجودی کافی نیست'); return; }
    p.money -= cost;
    p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
    io.emit('players', gameState.players);
  });

  socket.on('select_country', (data) => {
    const { name, countryId } = data;
    const p = gameState.players[name];
    if (!p) return;
    for (const other in gameState.players) {
      if (other !== name && gameState.players[other].countries.includes(countryId)) {
        socket.emit('error_msg', 'این کشور قبلاً گرفته شده');
        return;
      }
    }
    p.countries = [countryId];
    io.emit('players', gameState.players);
    addChat(`${name} کشور را انتخاب کرد`, 'ally');
  });

  socket.on('chat', (data) => {
    const { name, text } = data;
    addChat(`${name}: ${text}`, 'normal');
  });

  socket.on('attack', (data) => {
    const { from, to, selected, power, scenario } = data;
    const attacker = gameState.players[from];
    const defender = gameState.players[to];
    if (!attacker || !defender) return;
    for (const id in selected) {
      attacker.inventory[id] = (attacker.inventory[id] || 0) - selected[id];
      if (attacker.inventory[id] <= 0) delete attacker.inventory[id];
    }
    defender.notifications.push({
      id: Date.now() + Math.random(),
      type: 'attack', from: from, selected: selected, power: power,
      status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
    io.emit('players', gameState.players);
    addChat(`${from} به ${to} حمله کرد! قدرت: ${power}\nسناریو: ${scenario}`, 'attack');
  });

  socket.on('alliance_request', (data) => {
    const { from, to } = data;
    const target = gameState.players[to];
    if (!target) return;
    target.notifications.push({
      id: Date.now() + Math.random(),
      type: 'alliance', from: from,
      status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
    io.emit('players', gameState.players);
    addChat(`${from} به ${to} درخواست اتحاد داد`, 'ally');
  });

  socket.on('alliance_response', (data) => {
    const { user, notifId, accepted } = data;
    const u = gameState.players[user];
    if (!u) return;
    const n = u.notifications.find(x => x.id === notifId);
    if (!n) return;
    n.status = accepted ? 'accepted' : 'rejected';
    n.read = true;
    if (accepted) {
      const other = gameState.players[n.from];
      if (other && !other.allies.includes(user)) other.allies.push(user);
      if (!u.allies.includes(n.from)) u.allies.push(n.from);
      addChat(`اتحاد بین ${user} و ${n.from} برقرار شد`, 'ally');
    }
    io.emit('players', gameState.players);
  });

  socket.on('defense', (data) => {
    const { user, notifId, selected, defensePower } = data;
    const u = gameState.players[user];
    if (!u) return;
    const n = u.notifications.find(x => x.id === notifId);
    if (!n) return;
    for (const id in selected) {
      u.inventory[id] = (u.inventory[id] || 0) - selected[id];
      if (u.inventory[id] <= 0) delete u.inventory[id];
    }
    n.status = 'resolved';
    n.read = true;
    const atkPower = n.power;
    let resultMsg = '';
    if (atkPower > defensePower) {
      const attacker = gameState.players[n.from];
      const targetCountry = u.countries[0];
      if (targetCountry && attacker) {
        u.countries = u.countries.filter(c => c !== targetCountry);
        if (!attacker.countries.includes(targetCountry)) attacker.countries.push(targetCountry);
      }
      resultMsg = `💥 حمله موفق! ${n.from} کشور ${u.name} را تصرف کرد.`;
    } else {
      resultMsg = `🛡️ دفاع موفق! حمله ${n.from} دفع شد.`;
    }
    io.emit('players', gameState.players);
    addChat(`📢 نتیجه: حمله ${n.from} (قدرت ${atkPower}) vs دفاع ${defensePower}\n${resultMsg}`, 'result');
  });

  socket.on('disconnect', () => {
    if (socket.playerName && gameState.players[socket.playerName]) {
      gameState.players[socket.playerName].online = false;
      io.emit('players', gameState.players);
      console.log(socket.playerName, 'خارج شد');
    }
  });
});

function addChat(text, type = 'normal') {
  gameState.chat.push({
    text: text, type: type,
    time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })
  });
  if (gameState.chat.length > 200) gameState.chat = gameState.chat.slice(-200);
  io.emit('chat', gameState.chat);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🚀 سرور روی پورت ' + PORT + ' روشن شد');
});
