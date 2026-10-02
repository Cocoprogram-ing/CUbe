const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const WorldGen = require("./public/worldgen.js");

const PORT = process.env.PORT || 3000;

// ---------- World config ----------
// Set the SEED environment variable to get the same world every time.
// Without it, a new random world is created each time the server starts.
const SEED = (process.env.SEED || "").trim() || String(Math.floor(Math.random() * 1e9));
const gen = WorldGen.createWorld(SEED);
const { CHUNK, HEIGHT, B } = WorldGen;

const MAX_EDITS = 100000; // cap on player-made changes kept in memory
const MAX_COORD = 30000;  // world limit on x and z
const REACH = 12;         // generous; the client only reaches ~6 blocks
const PLACEABLE = new Set([
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.WOOD, B.PLANKS, B.LEAVES, B.SAND, B.SNOW,
]);

// The terrain itself is never stored: it is generated from the seed on demand.
// Only differences made by players are kept: "x,y,z" -> block id (0 = removed).
const edits = new Map();
const key = (x, y, z) => `${x},${y},${z}`;

// Small cache of generated terrain chunks, used to check edits against the real world.
const terrainCache = new Map();
function terrainBlock(x, y, z) {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  const ck = `${cx},${cz}`;
  let data = terrainCache.get(ck);
  if (!data) {
    data = gen.generateChunk(cx, cz);
    terrainCache.set(ck, data);
    if (terrainCache.size > 300) terrainCache.delete(terrainCache.keys().next().value);
  }
  return data[(y * CHUNK + (z - cz * CHUNK)) * CHUNK + (x - cx * CHUNK)];
}
function blockAt(x, y, z) {
  const e = edits.get(key(x, y, z));
  return e !== undefined ? e : terrainBlock(x, y, z);
}
function setBlock(x, y, z, b) {
  if (b === terrainBlock(x, y, z)) edits.delete(key(x, y, z)); // back to original: nothing to remember
  else edits.set(key(x, y, z), b);
}

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Players ----------
const players = new Map(); // id -> { id, x, y, z, ry, color }
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
const broadcast = (obj, except) => {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === 1) client.send(data);
  }
};

const isInt = (n) => Number.isInteger(n);
const validBlockPos = (x, y, z) =>
  isInt(x) && isInt(y) && isInt(z) &&
  Math.abs(x) <= MAX_COORD && Math.abs(z) <= MAX_COORD &&
  y >= 1 && y < HEIGHT; // y = 0 is unbreakable bedrock

const inReach = (p, x, y, z) => {
  const dx = x + 0.5 - p.x, dy = y + 0.5 - (p.y + 1.6), dz = z + 0.5 - p.z;
  return dx * dx + dy * dy + dz * dz <= REACH * REACH;
};

wss.on("connection", (ws) => {
  const id = nextId++;
  const player = { id, x: 0, y: 40, z: 0, ry: 0, color: randomColor() };
  players.set(id, player);
  ws.playerId = id;
  ws.isAlive = true;
  ws.msgCount = 0;

  // The new player only needs the seed and the list of changes made since the start.
  const editList = [];
  for (const [k, b] of edits) {
    const [x, y, z] = k.split(",").map(Number);
    editList.push([x, y, z, b]);
  }
  send(ws, {
    type: "init",
    id,
    color: player.color,
    seed: SEED,
    edits: editList,
    players: [...players.values()].filter((p) => p.id !== id),
  });
  broadcast({ type: "join", player }, ws);

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

    switch (msg.type) {
      case "move": {
        const { x, y, z, ry } = msg;
        if (![x, y, z, ry].every(Number.isFinite)) return;
        Object.assign(player, { x, y, z, ry });
        broadcast({ type: "move", id, x, y, z, ry }, ws);
        break;
      }
      case "place": {
        const { x, y, z, b } = msg;
        if (!validBlockPos(x, y, z) || !PLACEABLE.has(b)) return;
        if (!inReach(player, x, y, z)) return;
        const cur = blockAt(x, y, z);
        if (cur !== B.AIR && cur !== B.WATER) return;
        if (edits.size >= MAX_EDITS) return;
        setBlock(x, y, z, b);
        broadcast({ type: "set", x, y, z, b });
        break;
      }
      case "break": {
        const { x, y, z } = msg;
        if (!validBlockPos(x, y, z)) return;
        if (!inReach(player, x, y, z)) return;
        const cur = blockAt(x, y, z);
        if (cur === B.AIR || cur === B.WATER || cur === B.BEDROCK) return;
        if (edits.size >= MAX_EDITS) return;
        setBlock(x, y, z, B.AIR);
        broadcast({ type: "set", x, y, z, b: B.AIR });
        break;
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id });
  });
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

server.listen(PORT, () => console.log(`Block Platform running on port ${PORT} (seed: ${SEED})`));
