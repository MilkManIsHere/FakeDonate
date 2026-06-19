const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

const PUBLIC_COUNT = 50;
const MAX_PRIVATE = 50;
const SERVER_CAP = 20;
const BOOTH_COUNT = 20;

app.use(express.json());

function rid(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function money(cents) {
  const n = Math.max(0, cents | 0);
  return `$${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}
function hashPassword(pw) {
  return crypto.createHash("sha256").update(String(pw)).digest("hex");
}
function passwordOk(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 24;
}
function nameOk(name) {
  return typeof name === "string" && name.length >= 3 && name.length <= 20;
}
function boothTextOk(text) {
  return typeof text === "string" && text.length <= 200;
}
function makeBooths() {
  return Array.from({ length: BOOTH_COUNT }, (_, i) => ({
    id: `booth-${i + 1}`,
    text: `Booth ${i + 1}\nClaim me`,
    owner: null,
    claimed: false,
    receivedCents: 0,
    donatedCents: 0,
  }));
}
function makePublicServers() {
  return Array.from({ length: PUBLIC_COUNT }, (_, i) => ({
    id: `pub-${i + 1}`,
    name: `Official Server ${i + 1}`,
    players: 0,
    unlocked: true,
    owner: "System",
    private: false,
    booths: makeBooths(),
    closed: false,
  }));
}
function defaultData() {
  return {
    accounts: {},
    sessions: {},
    publicServers: makePublicServers(),
    privateServers: [],
    sentBoard: {},
    receivedBoard: {},
    globalFeed: [],
    chats: {},
  };
}
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      ...defaultData(),
      ...parsed,
      publicServers: Array.isArray(parsed.publicServers) && parsed.publicServers.length ? parsed.publicServers : makePublicServers(),
      privateServers: Array.isArray(parsed.privateServers) ? parsed.privateServers : [],
      accounts: parsed.accounts || {},
      sessions: parsed.sessions || {},
      sentBoard: parsed.sentBoard || {},
      receivedBoard: parsed.receivedBoard || {},
      globalFeed: Array.isArray(parsed.globalFeed) ? parsed.globalFeed : [],
      chats: parsed.chats || {},
    };
  } catch {
    return defaultData();
  }
}
const data = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function tickBalances() {
  const now = Date.now();
  Object.values(data.accounts).forEach((a) => {
    if (!a.lastBalanceTick) a.lastBalanceTick = now;
    const gain = Math.floor((now - a.lastBalanceTick) / 500);
    if (gain > 0) {
      a.balanceCents += gain;
      a.lastBalanceTick += gain * 500;
    }
  });
}
function getAccountBySession(token) {
  const session = data.sessions[token];
  if (!session) return null;
  const account = data.accounts[session.username];
  if (!account) return null;
  tickBalances();
  return { session, account };
}
function getServer(serverId) {
  return data.publicServers.find((s) => s.id === serverId) || data.privateServers.find((s) => s.id === serverId) || null;
}
function getCurrentServer(session) {
  if (!session.currentServerId) return null;
  return getServer(session.currentServerId);
}
function recordChat(serverId, text) {
  if (!data.chats[serverId]) data.chats[serverId] = [];
  data.chats[serverId].unshift({ id: rid("msg"), time: new Date().toLocaleTimeString(), text });
  data.chats[serverId] = data.chats[serverId].slice(0, 200);
}
function addGlobalFeed(text) {
  data.globalFeed.unshift({ id: rid("g"), time: new Date().toLocaleTimeString(), text });
  data.globalFeed = data.globalFeed.slice(0, 200);
}
function normalizeBoards() {
  const sentArr = Object.entries(data.sentBoard).map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents);
  const receivedArr = Object.entries(data.receivedBoard).map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents);
  return { sentArr, receivedArr };
}
function buildState(token) {
  tickBalances();
  const me = token ? getAccountBySession(token) : null;
  const { sentArr, receivedArr } = normalizeBoards();
  return {
    me: me
      ? {
          username: me.account.username,
          balanceCents: me.account.balanceCents,
          currentServerId: me.session.currentServerId || null,
        }
      : null,
    publicServers: data.publicServers,
    privateServers: data.privateServers.map((s) => ({ ...s, passwordHash: undefined })),
    globalFeed: data.globalFeed,
    sentBoard: sentArr,
    receivedBoard: receivedArr,
    chat: me && me.session.currentServerId ? data.chats[me.session.currentServerId] || [] : [],
  };
}
function closePrivateServer(serverId) {
  const idx = data.privateServers.findIndex((s) => s.id === serverId);
  if (idx >= 0) data.privateServers.splice(idx, 1);
  Object.values(data.sessions).forEach((session) => {
    if (session.currentServerId === serverId) session.currentServerId = null;
  });
  delete data.chats[serverId];
}
function maybeCloseAwayPrivateServers() {
  const t = Date.now();
  data.privateServers.forEach((server) => {
    if (!server.ownerAwaySince) return;
    if (t - server.ownerAwaySince >= 10000) closePrivateServer(server.id);
  });
}

setInterval(() => {
  tickBalances();
  maybeCloseAwayPrivateServers();
  saveData();
}, 2000);

app.get("/", (req, res) => res.send("Shared donation backend is running."));
app.get("/api/state", (req, res) => {
  const token = req.get("x-session-token") || req.query.token;
  res.json(buildState(token));
});

app.post("/api/signup", (req, res) => {
  const { username, password, confirmPassword } = req.body || {};
  if (!nameOk(username)) return res.status(400).json({ error: "Username must be 3 to 20 characters." });
  if (!passwordOk(password)) return res.status(400).json({ error: "Password must be 8 to 24 characters." });
  if (password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match." });
  if (data.accounts[username]) return res.status(400).json({ error: "Username already exists." });

  data.accounts[username] = { username, passwordHash: hashPassword(password), balanceCents: 0, lastBalanceTick: Date.now() };
  const token = rid("sess");
  data.sessions[token] = { username, currentServerId: null };
  saveData();
  res.json({ token, username });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const account = data.accounts[username];
  if (!account || account.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = rid("sess");
  data.sessions[token] = { username, currentServerId: null };
  saveData();
  res.json({ token, username });
});

app.post("/api/logout", (req, res) => {
  const token = req.body?.token;
  if (token) delete data.sessions[token];
  saveData();
  res.json({ ok: true });
});

app.post("/api/create-server", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });

  const { name, unlocked, password } = req.body || {};
  if (!nameOk(name)) return res.status(400).json({ error: "Lobby name must be 3 to 20 characters." });
  if (!unlocked && !passwordOk(password)) return res.status(400).json({ error: "Password must be 8 to 24 characters." });
  if (data.privateServers.length >= MAX_PRIVATE) return res.status(400).json({ error: "Private server limit reached." });

  const server = {
    id: rid("srv"),
    name,
    owner: auth.account.username,
    unlocked: !!unlocked,
    passwordHash: unlocked ? "" : hashPassword(password),
    players: 1,
    private: true,
    booths: makeBooths(),
    closed: false,
    ownerAwaySince: null,
  };

  data.privateServers.unshift(server);
  auth.session.currentServerId = server.id;
  saveData();
  res.json({ ok: true, serverId: server.id });
});

app.post("/api/join-server", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });

  const { serverId, password } = req.body || {};
  const server = getServer(serverId);
  if (!server) return res.status(404).json({ error: "Server not found." });
  if (server.players >= SERVER_CAP) return res.status(400).json({ error: "That server is full." });

  if (!server.unlocked) {
    if (!passwordOk(password)) return res.status(400).json({ error: "Password must be 8 to 24 characters." });
    if (hashPassword(password) !== server.passwordHash) return res.status(401).json({ error: "Wrong password." });
  }

  if (auth.session.currentServerId && auth.session.currentServerId !== server.id) {
    const old = getServer(auth.session.currentServerId);
    if (old) old.players = clamp(old.players - 1, 0, SERVER_CAP);
  }

  auth.session.currentServerId = server.id;
  server.players = clamp(server.players + 1, 0, SERVER_CAP);
  if (server.private && server.owner === auth.account.username) server.ownerAwaySince = null;

  saveData();
  res.json({ ok: true });
});

app.post("/api/leave-server", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });

  const server = getCurrentServer(auth.session);
  if (server) {
    server.players = clamp(server.players - 1, 0, SERVER_CAP);
    if (server.private && server.owner === auth.account.username) server.ownerAwaySince = Date.now();
  }
  auth.session.currentServerId = null;
  saveData();
  res.json({ ok: true });
});

app.post("/api/server-heartbeat", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });
  const server = getCurrentServer(auth.session);
  if (server && server.private && server.owner === auth.account.username) server.ownerAwaySince = null;
  saveData();
  res.json({ ok: true });
});

app.post("/api/claim-booth", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });
  const server = getCurrentServer(auth.session);
  if (!server) return res.status(400).json({ error: "Join a server first." });

  const booth = server.booths.find((b) => b.id === req.body?.boothId);
  if (!booth) return res.status(404).json({ error: "Booth not found." });
  if (booth.claimed && booth.owner !== auth.account.username) {
    return res.status(400).json({ error: "That booth belongs to someone else." });
  }

  if (!booth.claimed) {
    server.booths.forEach((b) => {
      if (b.owner === auth.account.username) {
        b.claimed = false;
        b.owner = null;
      }
    });
    booth.claimed = true;
    booth.owner = auth.account.username;
    if (booth.text.includes("Claim me")) booth.text = `${auth.account.username}'s booth`;
  } else {
    booth.claimed = false;
    booth.owner = null;
  }

  saveData();
  res.json({ ok: true });
});

app.post("/api/edit-booth", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });
  const server = getCurrentServer(auth.session);
  if (!server) return res.status(400).json({ error: "Join a server first." });

  const booth = server.booths.find((b) => b.id === req.body?.boothId);
  if (!booth) return res.status(404).json({ error: "Booth not found." });
  if (!(booth.claimed && booth.owner === auth.account.username)) {
    return res.status(403).json({ error: "You can only edit your own claimed booth." });
  }

  const text = String(req.body?.text || "").slice(0, 200);
  if (!boothTextOk(text)) return res.status(400).json({ error: "Booth text must be 200 characters or less." });
  booth.text = text;
  saveData();
  res.json({ ok: true });
});

app.post("/api/donate", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });
  const server = getCurrentServer(auth.session);
  if (!server) return res.status(400).json({ error: "Join a server first." });

  const booth = server.booths.find((b) => b.id === req.body?.boothId);
  if (!booth) return res.status(404).json({ error: "Booth not found." });
  if (!booth.claimed) return res.status(400).json({ error: "Cannot donate to an empty booth." });
  if (booth.owner === auth.account.username) return res.status(400).json({ error: "You cannot donate to yourself." });

  const amount = clamp((parseInt(req.body?.dollars || 0, 10) * 100) + parseInt(req.body?.cents || 0, 10), 0, 1e9);
  if (!amount) return res.status(400).json({ error: "Enter a donation amount." });
  if (amount > auth.account.balanceCents) return res.status(400).json({ error: "Not enough balance." });

  auth.account.balanceCents -= amount;
  booth.donatedCents += amount;
  booth.receivedCents += amount;
  data.sentBoard[auth.account.username] = (data.sentBoard[auth.account.username] || 0) + amount;
  data.receivedBoard[booth.owner] = (data.receivedBoard[booth.owner] || 0) + amount;

  const line = `${auth.account.username} donated ${money(amount)} to ${booth.owner}`;
  recordChat(server.id, `Alert to ${booth.owner}: ${auth.account.username} sent you ${money(amount)}.`);
  recordChat(server.id, `Alert to ${auth.account.username}: you donated ${money(amount)} to ${booth.owner}.`);
  if (amount >= 1000) {
    addGlobalFeed(`[GLOBAL] ${line}`);
    recordChat(server.id, `[GLOBAL] ${line}`);
  } else {
    addGlobalFeed(line);
  }

  saveData();
  res.json({ ok: true, amount });
});

app.post("/api/message", (req, res) => {
  const auth = getAccountBySession(req.body?.token);
  if (!auth) return res.status(401).json({ error: "Sign in first." });
  const server = getCurrentServer(auth.session);
  if (!server) return res.status(400).json({ error: "Join a server first." });

  const text = String(req.body?.text || "").slice(0, 200).trim();
  if (!text) return res.status(400).json({ error: "Message cannot be empty." });

  recordChat(server.id, `${auth.account.username}: ${text}`);
  saveData();
  res.json({ ok: true });
});

app.get("/api/cleanup", (req, res) => {
  maybeCloseAwayPrivateServers();
  saveData();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  saveData();
});
