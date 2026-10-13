const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

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

// ==========================
// MongoDB - Connection String مستقیم
// ==========================
const MONGODB_URI = 'mongodb+srv://wargame:msb52vgPw2DGC5A0@war-game-cluster.sk142uv.mongodb.net/?appName=war-game-cluster';

let playersCollection = null;
let chatCollection = null;

async function connectMongoDB() {
  console.log('🔌 اتصال به MongoDB...');
  try {
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });
    await client.connect();
    const db = client.db('war_game');
    playersCollection = db.collection('players');
    chatCollection = db.collection('chat');
    console.log('✅ MongoDB وصل شد');
    await playersCollection.createIndex({ name: 1 }, { unique: true });
    console.log('✅ ایندکس ساخته شد');
  } catch (err) {
    console.error('❌ خطا در اتصال MongoDB:', err.message);
  }
}

// ==========================
// State
// ==========================
const gameState = { players: {}, chat: [] };

async function loadPlayersFromDB() {
  if (!playersCollection) return;
  try {
    const players = await playersCollection.find({}).toArray();
    players.forEach(p => {
      p.online = false;
      gameState.players[p.name] = p;
    });
    console.log(`✅ ${players.length} بازیکن از دیتابیس لود شد`);
  } catch (err) {
    console.error('❌ خطا در لود بازیکنان:', err.message);
  }
}

async function loadChatFromDB() {
  if (!chatCollection) return;
  try {
    const msgs = await chatCollection.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    gameState.chat = msgs.reverse();
    console.log(`✅ ${gameState.chat.length} پیام از دیتابیس لود شد`);
  } catch (err) {
    console.error('❌ خطا در لود چت:', err.message);
  }
}

async function savePlayerToDB(player) {
  if (!playersCollection) return;
  try {
    const { _id, ...data } = player;
    await playersCollection.updateOne(
      { name: player.name },
      { $set: data },
      { upsert: true }
    );
  } catch (err) {
    console.error('خطا در ذخیره بازیکن:', err.message);
  }
}

async function saveChatToDB(msg) {
  if (!chatCollection) return;
  try {
    await chatCollection.insertOne(msg);
  } catch (err) {
    console.error('خطا در ذخیره چت:', err.message);
  }
}

// ==========================
// API
// ==========================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'سرور بازی جنگ جهانی روشنه',
    players: Object.keys(gameState.players).length,
    mongodb: playersCollection ? 'connected' : 'disconnected',
    time: new Date().toISOString()
  });
});

// ==========================
// Socket.io
// ==========================
io.on('connection', (socket) => {
  console.log('بازیکن وصل شد:', socket.id);

  socket.on('login', async ({ name, password }) => {
    if (!name || !password) {
      socket.emit('login_result', { ok: false, error: 'اسم و پسورد لازمه' });
      return;
    }
    let existing = gameState.players[name];

    if (!existing && playersCollection) {
      try {
        existing = await playersCollection.findOne({ name: name });
        if (existing) gameState.players[name] = existing;
      } catch (err) {
        console.error('خطا در پیدا کردن بازیکن:', err.message);
      }
    }

    if (!existing) {
      const newPlayer = {
        name, password,
        money: 16000, countries: [], inventory: {},
        allies: [], notifications: [],
        online: true, lastIncomeTime: Date.now()
      };
      gameState.players[name] = newPlayer;
      socket.playerName = name;
      await savePlayerToDB(newPlayer);
      socket.emit('login_result', { ok: true, isNew: true });
      io.emit('players', gameState.players);
      socket.emit('chat_history', gameState.chat);
      console.log('✅ بازیکن جدید:', name);
      return;
    }

    if (existing.password !== password) {
      socket.emit('login_result', { ok: false, error: 'پسورد اشتباهه!' });
      return;
    }

    existing.online = true;
    socket.playerName = name;
    await savePlayerToDB(existing);
    socket.emit('login_result', { ok: true, isNew: false });
    io.emit('players', gameState.players);
    socket.emit('chat_history', gameState.chat);
    console.log('✅ وارد شد:', name);
  });

  socket.on('buy', async (data) => {
    const { name, itemId, qty, price } = data;
    const p = gameState.players[name];
    if (!p) return;
    const cost = price * qty;
    if (p.money < cost) { socket.emit('error_msg', 'موجودی کافی نیست'); return; }
    p.money -= cost;
    p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
    await savePlayerToDB(p);
    io.emit('players', gameState.players);
  });

  socket.on('select_country', async (data) => {
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
    await savePlayerToDB(p);
    io.emit('players', gameState.players);
    addChat(`${name} کشور را انتخاب کرد`, 'ally');
  });

  socket.on('chat', async (data) => {
    const { name, text } = data;
    addChat(`${name}: ${text}`, 'normal');
  });

  socket.on('attack', async (data) => {
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
      type: 'attack', from, selected, power, status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
    await savePlayerToDB(attacker);
    await savePlayerToDB(defender);
    io.emit('players', gameState.players);
    addChat(`${from} به ${to} حمله کرد! قدرت: ${power}\nسناریو: ${scenario}`, 'attack');
  });

  socket.on('alliance_request', async (data) => {
    const { from, to } = data;
    const target = gameState.players[to];
    if (!target) return;
    target.notifications.push({
      id: Date.now() + Math.random(),
      type: 'alliance', from, status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
    await savePlayerToDB(target);
    io.emit('players', gameState.players);
    addChat(`${from} به ${to} درخواست اتحاد داد`, 'ally');
  });

  socket.on('alliance_response', async (data) => {
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
      if (other) await savePlayerToDB(other);
      addChat(`اتحاد بین ${user} و ${n.from} برقرار شد`, 'ally');
    }
    await savePlayerToDB(u);
    io.emit('players', gameState.players);
  });

  socket.on('defense', async (data) => {
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
        await savePlayerToDB(attacker);
      }
      resultMsg = `💥 حمله موفق! ${n.from} کشور ${u.name} را تصرف کرد.`;
    } else {
      resultMsg = `🛡️ دفاع موفق! حمله ${n.from} دفع شد.`;
    }
    await savePlayerToDB(u);
    io.emit('players', gameState.players);
    addChat(`📢 نتیجه: حمله ${n.from} (قدرت ${atkPower}) vs دفاع ${defensePower}\n${resultMsg}`, 'result');
  });

  socket.on('disconnect', async () => {
    if (socket.playerName && gameState.players[socket.playerName]) {
      gameState.players[socket.playerName].online = false;
      await savePlayerToDB(gameState.players[socket.playerName]);
      io.emit('players', gameState.players);
      console.log(socket.playerName, 'خارج شد');
    }
  });
});

function addChat(text, type = 'normal') {
  const msg = {
    text, type,
    time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
    createdAt: new Date()
  };
  gameState.chat.push(msg);
  if (gameState.chat.length > 200) gameState.chat = gameState.chat.slice(-200);
  saveChatToDB(msg);
  io.emit('chat', gameState.chat);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('🚀 سرور روی پورت ' + PORT + ' روشن شد');
  await connectMongoDB();
  await loadPlayersFromDB();
  await loadChatFromDB();
});
// deploy
