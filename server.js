const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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
  transports: ['websocket', 'polling'], allowEIO3: true
});

const MONGODB_URI = 'mongodb+srv://wargame:62636362f@war-game-cluster.sk142uv.mongodb.net/?appName=war-game-cluster';

let playersCollection = null;
let chatCollection = null;
const playerSockets = {};
const lastPing = {};
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTACK_COOLDOWN_MS = 10 * 60 * 1000;
const PING_TIMEOUT_MS = 2 * 60 * 1000;

// درآمد روزانه هر منبع واقعی
const INCOME_ITEMS = {
  south_pars: 2500, ghawar: 2800, silicon_valley: 3200, wall_street: 3800,
  dubai_tourism: 4200, aramco: 6000, tokyo_exchange: 8000, london_financial: 3500,
  south_africa_gold: 3000, amazon_resources: 2800, australia_iron: 2600, canada_oil: 3200,
  panama_canal: 4500, suez_canal: 4800, swiss_banks: 5000, russia_gas: 4000,
  china_manufacturing: 5500, india_it: 3500, german_auto: 4000, french_luxury: 3800
};

async function connectMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
    await client.connect();
    const db = client.db('war_game');
    playersCollection = db.collection('players');
    chatCollection = db.collection('chat');
    console.log('✅ MongoDB وصل شد');
    await playersCollection.createIndex({ name: 1 }, { unique: true });
  } catch (err) { console.error('❌ خطا:', err.message); }
}

const gameState = { players: {}, chat: [] };

function getPublicPlayers() {
  const out = {};
  for (const name in gameState.players) {
    const p = gameState.players[name];
    out[name] = {
      name: p.name, money: p.money, countries: p.countries || [],
      inventory: p.inventory || {}, allies: p.allies || [],
      online: p.online, lastIncomeTime: p.lastIncomeTime,
      attackCooldowns: p.attackCooldowns || {}
    };
  }
  return out;
}

function sendMyNotifications(name) {
  const p = gameState.players[name];
  const sock = playerSockets[name];
  if (p && sock) sock.emit('my_notifications', p.notifications || []);
}

async function loadPlayersFromDB() {
  if (!playersCollection) return;
  try {
    const players = await playersCollection.find({}).toArray();
    players.forEach(p => {
      p.online = false;
      p.attackCooldowns = p.attackCooldowns || {};
      p.privateMessages = p.privateMessages || [];
      gameState.players[p.name] = p;
    });
    console.log(`✅ ${players.length} بازیکن لود شد`);
  } catch (err) { console.error(err.message); }
}

async function loadChatFromDB() {
  if (!chatCollection) return;
  try {
    const msgs = await chatCollection.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    gameState.chat = msgs.reverse();
  } catch (err) { console.error(err.message); }
}

async function savePlayerToDB(player) {
  if (!playersCollection) return;
  try {
    const { _id, ...data } = player;
    await playersCollection.updateOne({ name: player.name }, { $set: data }, { upsert: true });
  } catch (err) { console.error(err.message); }
}

async function saveChatToDB(msg) {
  if (!chatCollection) return;
  try { await chatCollection.insertOne(msg); } catch (err) { console.error(err.message); }
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok', message: 'سرور بازی جنگ جهانی روشنه',
    players: Object.keys(gameState.players).length,
    mongodb: playersCollection ? 'connected' : 'disconnected',
    time: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  socket.on('login', async ({ name, password }) => {
    if (!name || !password) { socket.emit('login_result', { ok: false, error: 'اسم و پسورد لازمه' }); return; }
    let existing = gameState.players[name];
    if (!existing && playersCollection) {
      try {
        existing = await playersCollection.findOne({ name });
        if (existing) gameState.players[name] = existing;
      } catch (err) { console.error(err.message); }
    }
    if (!existing) {
      const newPlayer = {
        name, password, money: 16000, countries: [], inventory: {},
        allies: [], notifications: [], online: true,
        lastIncomeTime: Date.now(), attackCooldowns: {}, privateMessages: []
      };
      gameState.players[name] = newPlayer;
      if (socket.playerName) delete playerSockets[socket.playerName];
      socket.playerName = name;
      playerSockets[name] = socket;
      lastPing[name] = Date.now();
      await savePlayerToDB(newPlayer);
      socket.emit('login_result', { ok: true, isNew: true });
      socket.emit('my_notifications', newPlayer.notifications);
      socket.emit('my_private_messages', newPlayer.privateMessages);
      io.emit('players', getPublicPlayers());
      socket.emit('chat_history', gameState.chat);
      return;
    }
    if (existing.password !== password) { socket.emit('login_result', { ok: false, error: 'پسورد اشتباهه!' }); return; }
    existing.online = true;
    existing.attackCooldowns = existing.attackCooldowns || {};
    existing.privateMessages = existing.privateMessages || [];
    if (socket.playerName) delete playerSockets[socket.playerName];
    socket.playerName = name;
    playerSockets[name] = socket;
    lastPing[name] = Date.now();
    await savePlayerToDB(existing);
    socket.emit('login_result', { ok: true, isNew: false });
    socket.emit('my_notifications', existing.notifications || []);
    socket.emit('my_private_messages', existing.privateMessages);
    io.emit('players', getPublicPlayers());
    socket.emit('chat_history', gameState.chat);
  });

  socket.on('ping', () => {
    if (socket.playerName) lastPing[socket.playerName] = Date.now();
  });

  socket.on('buy', async (data) => {
    const { name, itemId, qty, price } = data;
    const p = gameState.players[name];
    if (!p) return;
    const cost = price * qty;
    if (p.money < cost) { socket.emit('error_msg', 'موجودی کافی نیست'); return; }
    p.money -= cost;
    p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
    if (INCOME_ITEMS[itemId] && !p.lastIncomeTime) p.lastIncomeTime = Date.now();
    await savePlayerToDB(p);
    io.emit('players', getPublicPlayers());
  });

  socket.on('select_country', async (data) => {
    const { name, countryId } = data;
    const p = gameState.players[name];
    if (!p) return;
    for (const other in gameState.players) {
      if (other !== name && gameState.players[other].countries.includes(countryId)) {
        socket.emit('error_msg', 'این کشور قبلاً گرفته شده'); return;
      }
    }
    p.countries = [countryId];
    await savePlayerToDB(p);
    io.emit('players', getPublicPlayers());
    addChat(`${name} کشور را انتخاب کرد`, 'ally');
  });

  socket.on('chat', async (data) => {
    const { name, text } = data;
    addChat(`${name}: ${text}`, 'normal');
  });

  socket.on('private_chat', async (data) => {
    const { from, to, text } = data;
    const sender = gameState.players[from];
    const receiver = gameState.players[to];
    if (!sender || !receiver || !text) return;
    const msg = {
      id: Date.now() + Math.random(),
      from, to, text,
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
      createdAt: new Date()
    };
    sender.privateMessages = sender.privateMessages || [];
    receiver.privateMessages = receiver.privateMessages || [];
    sender.privateMessages.push({ ...msg, mine: true });
    receiver.privateMessages.push({ ...msg, mine: false });
    if (sender.privateMessages.length > 500) sender.privateMessages = sender.privateMessages.slice(-500);
    if (receiver.privateMessages.length > 500) receiver.privateMessages = receiver.privateMessages.slice(-500);
    await savePlayerToDB(sender);
    await savePlayerToDB(receiver);
    if (playerSockets[from]) playerSockets[from].emit('my_private_messages', sender.privateMessages);
    if (playerSockets[to]) playerSockets[to].emit('my_private_messages', receiver.privateMessages);
  });

  socket.on('load_private_chat', (data) => {
    const { user, with: other } = data;
    const p = gameState.players[user];
    if (!p) return;
    const msgs = (p.privateMessages || []).filter(m => m.from === other || m.to === other);
    socket.emit('private_chat_history', { with: other, messages: msgs });
  });

  socket.on('attack', async (data) => {
    const { from, to, selected, power, scenario } = data;
    const attacker = gameState.players[from];
    const defender = gameState.players[to];
    if (!attacker || !defender) return;
    if (from === to) { socket.emit('error_msg', 'نمی‌تونی به خودت حمله کنی!'); return; }
    attacker.attackCooldowns = attacker.attackCooldowns || {};
    const lastAtk = attacker.attackCooldowns[to] || 0;
    const remain = ATTACK_COOLDOWN_MS - (Date.now() - lastAtk);
    if (remain > 0) {
      const min = Math.ceil(remain / 60000);
      socket.emit('error_msg', `به ${to} باید ${min} دقیقه دیگه صبر کنی`);
      return;
    }
    for (const id in selected) {
      attacker.inventory[id] = (attacker.inventory[id] || 0) - selected[id];
      if (attacker.inventory[id] <= 0) delete attacker.inventory[id];
    }
    attacker.attackCooldowns[to] = Date.now();
    defender.notifications.push({
      id: Date.now() + Math.random(), type: 'attack', from, selected, power, status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
    });
    await savePlayerToDB(attacker);
    await savePlayerToDB(defender);
    io.emit('players', getPublicPlayers());
    sendMyNotifications(to);
    addChat(`${from} به ${to} حمله کرد! قدرت: ${power}\nسناریو: ${scenario}`, 'attack');
  });

  socket.on('alliance_request', async (data) => {
    const { from, to } = data;
    const target = gameState.players[to];
    if (!target) return;
    if (from === to) { socket.emit('error_msg', 'نمی‌تونی به خودت درخواست بدی'); return; }
    target.notifications.push({
      id: Date.now() + Math.random(), type: 'alliance', from, status: 'pending',
      time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
    });
    await savePlayerToDB(target);
    io.emit('players', getPublicPlayers());
    sendMyNotifications(to);
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
      if (other) {
        other.notifications.push({
          id: Date.now() + Math.random(), type: 'alliance_accepted', from: user, status: 'resolved',
          time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
        });
        await savePlayerToDB(other);
        sendMyNotifications(n.from);
      }
      addChat(`اتحاد بین ${user} و ${n.from} برقرار شد`, 'ally');
    } else {
      const other = gameState.players[n.from];
      if (other) {
        other.notifications.push({
          id: Date.now() + Math.random(), type: 'alliance_rejected', from: user, status: 'resolved',
          time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
        });
        await savePlayerToDB(other);
        sendMyNotifications(n.from);
      }
    }
    await savePlayerToDB(u);
    sendMyNotifications(user);
    io.emit('players', getPublicPlayers());
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
        attacker.notifications.push({
          id: Date.now() + Math.random(), type: 'attack_success', to: user, status: 'resolved',
          time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
        });
        await savePlayerToDB(attacker);
        sendMyNotifications(n.from);
      }
      resultMsg = `💥 حمله موفق! ${n.from} کشور ${u.name} را تصرف کرد.`;
    } else {
      resultMsg = `🛡️ دفاع موفق! حمله ${n.from} دفع شد.`;
    }
    await savePlayerToDB(u);
    sendMyNotifications(user);
    io.emit('players', getPublicPlayers());
    addChat(`📢 نتیجه: حمله ${n.from} (قدرت ${atkPower}) vs دفاع ${defensePower}\n${resultMsg}`, 'result');
  });

  socket.on('spy', async (data) => {
    const { from, to } = data;
    const spy = gameState.players[from];
    const target = gameState.players[to];
    if (!spy || !target) return;
    const cost = 500;
    if (spy.money < cost) { socket.emit('error_msg', 'موجودی برای جاسوسی کافی نیست'); return; }
    spy.money -= cost;
    await savePlayerToDB(spy);
    io.emit('players', getPublicPlayers());
    socket.emit('spy_result', {
      name: to, money: target.money, countries: target.countries,
      allies: target.allies, inventory: target.inventory
    });
  });

  socket.on('disconnect', async () => {
    if (socket.playerName && gameState.players[socket.playerName]) {
      gameState.players[socket.playerName].online = false;
      delete playerSockets[socket.playerName];
      delete lastPing[socket.playerName];
      await savePlayerToDB(gameState.players[socket.playerName]);
      io.emit('players', getPublicPlayers());
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

async function processDailyIncome() {
  const now = Date.now();
  let changed = false;
  for (const name in gameState.players) {
    const p = gameState.players[name];
    if (!p.lastIncomeTime) { p.lastIncomeTime = now; continue; }
    const elapsed = now - p.lastIncomeTime;
    if (elapsed < DAY_MS) continue;
    let incomePerDay = 0;
    for (const id in p.inventory || {}) {
      if (INCOME_ITEMS[id]) incomePerDay += INCOME_ITEMS[id] * p.inventory[id];
    }
    const cycles = Math.floor(elapsed / DAY_MS);
    if (incomePerDay > 0) {
      const total = incomePerDay * cycles;
      p.money += total;
      p.lastIncomeTime += cycles * DAY_MS;
      p.notifications = p.notifications || [];
      p.notifications.push({
        id: Date.now() + Math.random(), type: 'income', amount: total,
        time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }), read: false
      });
      if (playerSockets[name]) playerSockets[name].emit('my_notifications', p.notifications);
      changed = true;
    } else {
      p.lastIncomeTime = now;
    }
    await savePlayerToDB(p);
  }
  if (changed) io.emit('players', getPublicPlayers());
}

setInterval(processDailyIncome, 30 * 1000);

setInterval(async () => {
  const now = Date.now();
  let changed = false;
  for (const name in gameState.players) {
    const p = gameState.players[name];
    if (!p.online) continue;
    const lp = lastPing[name] || 0;
    if (now - lp > PING_TIMEOUT_MS) {
      p.online = false;
      delete playerSockets[name];
      delete lastPing[name];
      await savePlayerToDB(p);
      changed = true;
      console.log(`🚪 ${name} خودکار آفلاین شد`);
    }
  }
  if (changed) io.emit('players', getPublicPlayers());
}, 30 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log('🚀 سرور روی پورت ' + PORT + ' روشن شد');
  await connectMongoDB();
  await loadPlayersFromDB();
  await loadChatFromDB();
  setTimeout(processDailyIncome, 5000);
});
