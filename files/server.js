const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// The game files normally live in ./public. If they were uploaded next to server.js instead
// (a flat GitHub upload), use them from there so the server still starts.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "worldgen.js"))
  ? path.join(__dirname, "public")
  : __dirname;
const WorldGen = require(path.join(PUBLIC_DIR, "worldgen.js"));

const PORT = process.env.PORT || 3000;
const { CHUNK, HEIGHT, B, MAX_HP, MAX_STACK, BREAK_TIME } = WorldGen;

// ---------- Limits ----------
const MAX_ROOMS = 20;       // worlds alive at the same time (keeps the free tier happy)
const MAX_PLAYERS = 12;     // per world
const MAX_EDITS = 40000;    // player-made block changes kept per world
const MAX_COORD = 30000;    // world limit on x and z
const HIT_DAMAGE = 2;       // half-hearts per punch (1 heart)
const HIT_COOLDOWN = 450;   // ms between punches
const HIT_REACH = 7;        // blocks
const MINE_TOLERANCE = 0.7; // accept a break after 70% of the mining time (network jitter)
const DEAD_BLOCKED = new Set(["place", "break", "mine", "hit", "fall", "drown"]);
const REACH = 12;           // generous; the client only reaches ~6 blocks
const PLACEABLE = new Set([
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.WOOD, B.PLANKS, B.LEAVES, B.SAND, B.SNOW,
]);

// Join codes: 6 characters, no look-alikes (0/O, 1/I).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

const key = (x, y, z) => `${x},${y},${z}`;

// ---------- Worlds ----------
// Every world is generated from its own seed. Only the changes made by players are stored.
const rooms = new Set();
const openCodes = new Map(); // code -> room (only worlds that are currently opened to friends)

class Room {
  constructor(seed, mode) {
    this.seed = seed;
    this.mode = mode;            // "creative" or "survival"
    this.gen = WorldGen.createWorld(seed);
    this.edits = new Map();      // "x,y,z" -> block id (0 = removed)
    this.terrain = new Map();    // small cache of generated chunks, used to check edits
    this.clients = new Set();
    this.hostId = null;
    this.code = null;            // set while the world is open
  }

  terrainBlock(x, y, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const ck = `${cx},${cz}`;
    let data = this.terrain.get(ck);
    if (!data) {
      data = this.gen.generateChunk(cx, cz);
      this.terrain.set(ck, data);
      if (this.terrain.size > 150) this.terrain.delete(this.terrain.keys().next().value);
    }
    return data[(y * CHUNK + (z - cz * CHUNK)) * CHUNK + (x - cx * CHUNK)];
  }
  blockAt(x, y, z) {
    const e = this.edits.get(key(x, y, z));
    return e !== undefined ? e : this.terrainBlock(x, y, z);
  }
  setBlock(x, y, z, b) {
    if (b === this.terrainBlock(x, y, z)) this.edits.delete(key(x, y, z)); // back to original
    else this.edits.set(key(x, y, z), b);
  }

  players() { return [...this.clients].map((c) => c.player); }
  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const c of this.clients) if (c !== except && c.readyState === 1) c.send(data);
  }
  info() { return { type: "room", open: !!this.code, code: this.code, hostId: this.hostId }; }
}

function newCode() {
  for (;;) {
    let c = "";
    for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!openCodes.has(c)) return c;
  }
}
const normCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- Input cleaning ----------
const cleanName = (raw, id) => {
  const s = String(raw || "").replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s || `Player${id}`;
};
const cleanSeed = (raw) => {
  const s = String(raw || "").trim().slice(0, 32);
  return s || String(Math.floor(Math.random() * 1e9));
};
const cleanMode = (raw) => (raw === "survival" ? "survival" : "creative");
const cleanChat = (raw) => String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);

// ---------- HTTP ----------
const app = express();
if (PUBLIC_DIR !== __dirname) {
  app.use(express.static(PUBLIC_DIR));
} else { // flat layout: share only the two game files, never server.js
  const file = (name) => (_req, res) => res.sendFile(path.join(__dirname, name));
  app.get("/", file("index.html"));
  app.get("/index.html", file("index.html"));
  app.get("/worldgen.js", file("worldgen.js"));
}
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Players ----------
let nextId = 1;

const randomColor = () => {
  const hue = Math.floor(Math.random() * 360);
  // HSL -> hex int (saturation 65%, lightness 55%)
  const s = 0.65, l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to255 = (v) => Math.round(v * 255);
  return (to255(f(0)) << 16) | (to255(f(8)) << 8) | to255(f(4));
};

const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};
const fail = (ws, message) => send(ws, { type: "error", message });

const isInt = (n) => Number.isInteger(n);
const validBlockPos = (x, y, z) =>
  isInt(x) && isInt(y) && isInt(z) &&
  Math.abs(x) <= MAX_COORD && Math.abs(z) <= MAX_COORD &&
  y >= 1 && y < HEIGHT; // y = 0 is unbreakable bedrock

const inReach = (p, x, y, z) => {
  const dx = x + 0.5 - p.x, dy = y + 0.5 - (p.y + 1.6), dz = z + 0.5 - p.z;
  return dx * dx + dy * dy + dz * dz <= REACH * REACH;
};

function sendInv(ws) { send(ws, { type: "inv", inv: ws.st.inv }); }

// Survival damage. The server keeps the health; clients only report falls and drowning.
function damage(ws, amount, cause) {
  const st = ws.st, room = ws.room, name = ws.player.name;
  if (!st || st.dead || room.mode !== "survival") return;
  st.hp = Math.max(0, st.hp - amount);
  send(ws, { type: "hp", hp: st.hp });
  if (st.hp > 0) return;
  st.dead = true;
  st.mining = null;
  ws.player.dead = true;
  send(ws, { type: "dead", kind: cause.kind, by: cause.by });
  room.broadcast({ type: "state", id: ws.player.id, dead: true }, ws);
  const how = cause.kind === "fall" ? "fell from a high place"
    : cause.kind === "drown" ? "drowned" : `was slain by ${cause.by}`;
  room.broadcast({ type: "system", text: `${name} ${how}` });
}

function enterRoom(ws, room, rawName) {
  const id = nextId++;
  const player = { id, name: cleanName(rawName, id), color: randomColor(), x: 0, y: 40, z: 0, ry: 0, dead: false };
  const host = [...room.clients].find((c) => c.player.id === room.hostId);

  ws.room = room;
  ws.player = player;
  ws.st = { hp: MAX_HP, inv: {}, mining: null, dead: false, lastHit: 0, lastDrown: 0 }; // private survival state
  room.clients.add(ws);
  if (room.hostId === null) room.hostId = id;

  const editList = [];
  for (const [k, b] of room.edits) {
    const [x, y, z] = k.split(",").map(Number);
    editList.push([x, y, z, b]);
  }
  send(ws, {
    type: "init",
    id,
    name: player.name,
    color: player.color,
    seed: room.seed,
    mode: room.mode,
    hp: ws.st.hp,
    inv: ws.st.inv,
    edits: editList,
    players: room.players().filter((p) => p.id !== id),
    room: room.info(),
    spawn: host ? { x: host.player.x, z: host.player.z } : null, // friends appear near the host
  });
  room.broadcast({ type: "join", player }, ws);
  room.broadcast({ type: "system", text: `${player.name} joined the world` }, ws);
}

function leaveRoom(ws) {
  const room = ws.room, player = ws.player;
  if (!room) return;
  ws.room = null;
  ws.player = null;
  ws.st = null;
  room.clients.delete(ws);

  if (room.clients.size === 0) { // last one out: the world is discarded
    rooms.delete(room);
    if (room.code) openCodes.delete(room.code);
    return;
  }
  room.broadcast({ type: "leave", id: player.id });
  room.broadcast({ type: "system", text: `${player.name} left the world` });
  if (room.hostId === player.id) { // pass hosting on to whoever has been here longest
    const next = room.clients.values().next().value.player;
    room.hostId = next.id;
    room.broadcast(room.info());
    room.broadcast({ type: "system", text: `${next.name} is now the host` });
  }
}

wss.on("connection", (ws) => {
  ws.room = null;
  ws.player = null;
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.failedJoins = 0;
  ws.chatTimes = [];

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    // Very small flood protection.
    if (++ws.msgCount > 400) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const room = ws.room, player = ws.player;

    // Not in a world yet: the only things allowed are creating or joining one.
    if (!room) {
      if (msg.type === "create") {
        if (rooms.size >= MAX_ROOMS) return fail(ws, "The server is full right now. Please try again in a few minutes.");
        const r = new Room(cleanSeed(msg.seed), cleanMode(msg.mode));
        rooms.add(r);
        enterRoom(ws, r, msg.name);
      } else if (msg.type === "join") {
        if (ws.failedJoins >= 10) return fail(ws, "Too many wrong codes. Wait a moment and reload the page.");
        const r = openCodes.get(normCode(msg.code));
        if (!r) {
          ws.failedJoins++;
          return fail(ws, "No open world has that code. Ask your friend to click \u201cOpen World\u201d and read you the code.");
        }
        if (r.clients.size >= MAX_PLAYERS) return fail(ws, "That world is full.");
        enterRoom(ws, r, msg.name);
      }
      return;
    }

    const st = ws.st, survival = room.mode === "survival";
    if (survival && st.dead && DEAD_BLOCKED.has(msg.type)) return; // dead players can't act until they respawn

    switch (msg.type) {
      case "move": {
        const { x, y, z, ry } = msg;
        if (![x, y, z, ry].every(Number.isFinite)) return;
        Object.assign(player, { x, y, z, ry });
        room.broadcast({ type: "move", id: player.id, x, y, z, ry }, ws);
        break;
      }
      case "place": {
        const { x, y, z, b } = msg;
        if (!validBlockPos(x, y, z) || !PLACEABLE.has(b)) return;
        if (!inReach(player, x, y, z)) return;
        const cur = room.blockAt(x, y, z);
        if (cur !== B.AIR && cur !== B.WATER) return;
        if (room.edits.size >= MAX_EDITS) return;
        if (survival) { // placing uses up an item
          if (!(st.inv[b] > 0)) return;
          st.inv[b]--;
          sendInv(ws);
        }
        room.setBlock(x, y, z, b);
        room.broadcast({ type: "set", x, y, z, b });
        break;
      }
      case "break": {
        const { x, y, z } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!inReach(player, x, y, z)) return;
        const cur = room.blockAt(x, y, z);
        if (cur === B.AIR || cur === B.WATER || cur === B.BEDROCK) return;
        if (room.edits.size >= MAX_EDITS) return;
        if (survival) { // digging takes time: the client must have started mining this block long enough ago
          const m = st.mining;
          if (!m || m.key !== key(x, y, z) || Date.now() - m.t < BREAK_TIME[cur] * 1000 * MINE_TOLERANCE) return;
          st.mining = null;
        }
        room.setBlock(x, y, z, B.AIR);
        room.broadcast({ type: "set", x, y, z, b: B.AIR });
        if (survival) { // the block goes into the inventory (max one stack per block type)
          st.inv[cur] = Math.min(MAX_STACK, (st.inv[cur] || 0) + 1);
          sendInv(ws);
        }
        break;
      }
      case "mine": { // survival: the player started digging this block
        const { x, y, z } = msg;
        if (!survival || !validBlockPos(x, y, z) || !inReach(player, x, y, z)) return;
        st.mining = { key: key(x, y, z), t: Date.now() };
        break;
      }
      case "hit": { // survival: punch another player
        if (!survival) return;
        const now = Date.now();
        if (now - st.lastHit < HIT_COOLDOWN) return;
        const target = [...room.clients].find((c) => c !== ws && c.player.id === msg.id);
        if (!target || target.st.dead) return;
        const t = target.player;
        if (Math.hypot(t.x - player.x, t.y + 0.9 - (player.y + 1.6), t.z - player.z) > HIT_REACH) return;
        st.lastHit = now;
        damage(target, HIT_DAMAGE, { kind: "player", by: player.name });
        break;
      }
      case "fall": {
        if (!survival || !Number.isFinite(msg.amount)) return;
        damage(ws, Math.max(1, Math.min(MAX_HP, Math.floor(msg.amount))), { kind: "fall" });
        break;
      }
      case "drown": {
        const now = Date.now();
        if (!survival || now - st.lastDrown < 800) return;
        st.lastDrown = now;
        damage(ws, 2, { kind: "drown" });
        break;
      }
      case "respawn": {
        if (!survival || !st.dead) return;
        st.hp = MAX_HP; st.dead = false; st.mining = null; player.dead = false;
        send(ws, { type: "hp", hp: st.hp });
        room.broadcast({ type: "state", id: player.id, dead: false }, ws);
        break;
      }
      case "chat": {
        const text = cleanChat(msg.text);
        if (!text) return;
        const now = Date.now();
        ws.chatTimes = ws.chatTimes.filter((t) => now - t < 6000);
        if (ws.chatTimes.length >= 5) return send(ws, { type: "system", text: "You're sending messages too fast." });
        ws.chatTimes.push(now);
        room.broadcast({ type: "chat", id: player.id, name: player.name, text });
        break;
      }
      case "open": { // host only: give the world a code friends can type in
        if (room.hostId !== player.id || room.code) return;
        room.code = newCode();
        openCodes.set(room.code, room);
        room.broadcast(room.info());
        room.broadcast({ type: "system", text: `World opened! Friends can join with the code ${room.code}` });
        break;
      }
      case "close": { // host only: stop new players from joining
        if (room.hostId !== player.id || !room.code) return;
        openCodes.delete(room.code);
        room.code = null;
        room.broadcast(room.info());
        room.broadcast({ type: "system", text: "World closed. No new players can join." });
        break;
      }
      case "leave":
        leaveRoom(ws);
        break;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Reset flood counters every second.
setInterval(() => {
  for (const ws of wss.clients) ws.msgCount = 0;
}, 1000);

// Heartbeat: drop dead connections and keep proxies from idling the socket.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Block Platform running on port ${PORT}`));
