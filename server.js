const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// دیتای بازی (در حافظه - با هر ری استارت پاک می‌شه)
const gameState = {
  players: {},
  chat: []
};

// ==========================
// API ساده برای تست
// ==========================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'سرور بازی جنگ جهانی روشنه',
    players: Object.keys(gameState.players).length,
    time: new Date().toISOString()
  });
});

// ==========================
// Socket.io - ارتباط زنده
// ==========================
io.on('connection', (socket) => {
  console.log('یک بازیکن وصل شد:', socket.id);

  // وقتی بازیکن اسمش رو می‌فرسته
  socket.on('join', (name) => {
    if (!name) return;
    if (!gameState.players[name]) {
      gameState.players[name] = {
        name: name,
        money: 16000,
        countries: [],
        inventory: {},
        allies: [],
        notifications: [],
        online: true,
        lastIncomeTime: Date.now()
      };
    } else {
      gameState.players[name].online = true;
    }
    socket.playerName = name;

    // به همه خبر بده
    io.emit('players', gameState.players);
    io.emit('chat_history', gameState.chat);
    console.log(name, 'وارد بازی شد');
  });

  // خرید از بازار
  socket.on('buy', ({ name, itemId, qty, price }) => {
    const p = gameState.players[name];
    if (!p) return;
    const cost = price * qty;
    if (p.money < cost) {
      socket.emit('error_msg', 'موجودی کافی نیست');
      return;
    }
    p.money -= cost;
    p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
    io.emit('players', gameState.players);
  });

  // انتخاب کشور
  socket.on('select_country', ({ name, countryId }) => {
    const p = gameState.players[name];
    if (!p) return;
    // چک کن کسی نگرفته باشه
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

  // چت
  socket.on('chat', ({ name, text }) => {
    addChat(name + ': ' + text, 'normal');
  });

  // حمله
  socket.on('attack', ({ from, to, selected, power, scenario }) => {
    const attacker = gameState.players[from];
    const defender = gameState.players[to];
    if (!attacker || !defender) return;

    // کم کردن وسایل مهاجم
    for (const id in selected) {
      attacker.inventory[id] = (attacker.inventory[id] || 0) - selected[id];
      if (attacker.inventory[id] <= 0) delete attacker.inventory[id];
    }

    // اعلان به مدافع
    defender.notifications.push({
      id: Date.now() + Math.random(),
      type: 'attack',
      from: from,
      selected: selected,
      power: power,
      status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });

    io.emit('players', gameState.players);
    addChat(`${from} به ${to} حمله کرد! قدرت: ${power}\nسناریو: ${scenario}`, 'attack');
  });

  // درخواست اتحاد
  socket.on('alliance_request', ({ from, to }) => {
    const target = gameState.players[to];
    if (!target) return;
    target.notifications.push({
      id: Date.now() + Math.random(),
      type: 'alliance',
      from: from,
      status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
    io.emit('players', gameState.players);
    addChat(`${from} به ${to} درخواست اتحاد داد`, 'ally');
  });

  // پاسخ به اتحاد
  socket.on('alliance_response', ({ user, notifId, accepted }) => {
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

  // دفاع
  socket.on('defense', ({ user, notifId, selected, defensePower }) => {
    const u = gameState.players[user];
    if (!u) return;
    const n = u.notifications.find(x => x.id === notifId);
    if (!n) return;

    // کم کردن وسایل دفاعی
    for (const id in selected) {
      u.inventory[id] = (u.inventory[id] || 0) - selected[id];
      if (u.inventory[id] <= 0) delete u.inventory[id];
    }

    n.status = 'resolved';
    n.read = true;

    const atkPower = n.power;
    let resultMsg = '';

    if (atkPower > defensePower) {
      // مهاجم برنده
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
    addChat(`📢 نتیجه: حمله ${n.from} با قدرت ${atkPower} علیه دفاع ${defensePower}\n${resultMsg}`, 'result');
  });

  // قطع اتصال
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
    text: text,
    type: type,
    time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })
  });
  if (gameState.chat.length > 200) gameState.chat = gameState.chat.slice(-200);
  io.emit('chat', gameState.chat);
}

// ==========================
// شروع سرور
// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🚀 سرور روی پورت ' + PORT + ' روشن شد');
});
