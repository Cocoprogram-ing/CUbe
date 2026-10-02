// Seeded world generator, shared by the server (Node) and the browser.
// It is pure and deterministic: the same seed always produces the same world,
// so only the seed (plus player edits) ever needs to be sent over the network.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WorldGen = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CHUNK = 16;        // chunk is 16 x HEIGHT x 16 blocks
  const HEIGHT = 64;       // world height
  const SEA = 20;          // water fills everything at or below this y
  const STONE_LINE = 38;   // bare rock above this height
  const SNOW_LINE = 46;    // snow above this height
  const TREE_CELL = 5;     // at most one tree per 5x5 cell (keeps trees spaced out)

  const B = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WOOD: 5,
    PLANKS: 6, LEAVES: 7, COBBLE: 8, SNOW: 9, WATER: 10, BEDROCK: 11,
  };

  // Survival rules, shared so the server can enforce them and the client can display them.
  const MAX_HP = 20;      // in half-hearts: 20 = 10 hearts
  const MAX_STACK = 64;   // items per stack
  const BREAK_TIME = [];  // seconds to mine each block in survival (harder block = longer)
  BREAK_TIME[B.LEAVES] = 0.3;  BREAK_TIME[B.SNOW] = 0.4;   BREAK_TIME[B.SAND] = 0.6;
  BREAK_TIME[B.DIRT] = 0.7;    BREAK_TIME[B.GRASS] = 0.8;  BREAK_TIME[B.PLANKS] = 1.6;
  BREAK_TIME[B.WOOD] = 2.0;    BREAK_TIME[B.COBBLE] = 3.0; BREAK_TIME[B.STONE] = 3.5;
  BREAK_TIME[B.BEDROCK] = Infinity;

  // ---------- Seeded randomness ----------
  function seedToInt(seed) { // FNV-1a hash of the seed text
    const s = String(seed);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Stateless hash of two integers + seed -> [0, 1)
  function hash2(a, b, s) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ s;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // 2D Perlin gradient noise, roughly in [-1, 1]
  function makeNoise(seed) {
    const rand = mulberry32(seed);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const dot = (h, x, y) => { const g = G[h & 7]; return g[0] * x + g[1] * y; };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const X = xi & 255, Y = yi & 255;
      const xf = x - xi, yf = y - yi;
      const u = fade(xf), v = fade(yf);
      const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
      const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
      return lerp(
        lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u),
        lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u),
        v
      );
    };
  }

  // Fractal noise: several octaves, normalised back to roughly [-1, 1]
  function fbm(noise, x, y, octaves) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq + i * 17.3, y * freq - i * 9.1) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  // ---------- World ----------
  function createWorld(seed) {
    const si = seedToInt(seed);
    const nCont = makeNoise(si ^ 0x1111);   // continents / oceans / mountains
    const nHill = makeNoise(si ^ 0x2222);   // rolling hills
    const nBiome = makeNoise(si ^ 0x3333);  // deserts
    const nTree = makeNoise(si ^ 0x4444);   // forest density
    const nDetail = makeNoise(si ^ 0x5555); // small variation for biome borders

    // Everything we need to know about one (x, z) column.
    function column(x, z) {
      const cont = fbm(nCont, x / 220, z / 220, 3);
      const hills = fbm(nHill, x / 55, z / 55, 4);
      const detail = nDetail(x / 6, z / 6);
      const m = Math.max(0, cont - 0.12) / 0.4;
      let h = SEA + 4 + cont * 34 + hills * 9 + m * m * 26;
      h = Math.max(3, Math.min(HEIGHT - 12, Math.round(h)));

      const desert = fbm(nBiome, x / 160, z / 160, 2) < -0.2;
      let top, sub, depth = 3, grass = false;
      if (h <= SEA) { top = sub = h >= SEA - 3 ? B.SAND : B.DIRT; }            // sea floor
      else if (h <= SEA + 1) { top = sub = B.SAND; }                            // beach
      else if (h >= SNOW_LINE + detail * 3) { top = B.SNOW; sub = B.STONE; }    // snowy peaks
      else if (h >= STONE_LINE + detail * 3) { top = sub = B.STONE; }           // bare rock
      else if (desert) { top = sub = B.SAND; depth = 4; }
      else { top = B.GRASS; sub = B.DIRT; grass = true; }
      return { h, top, sub, depth, grass };
    }

    // A tree (or nothing) for each TREE_CELL x TREE_CELL cell of the world.
    function treeInCell(cx, cz) {
      const px = cx * TREE_CELL + Math.floor(hash2(cx, cz, si ^ 0xa1) * TREE_CELL);
      const pz = cz * TREE_CELL + Math.floor(hash2(cx, cz, si ^ 0xa2) * TREE_CELL);
      const forest = nTree(px / 70, pz / 70);
      const chance = Math.max(0.04, Math.min(0.85, 0.22 + forest * 1.5));
      if (hash2(cx, cz, si ^ 0xa3) > chance) return null;
      const c = column(px, pz);
      if (!c.grass) return null;
      const trunk = 4 + Math.floor(hash2(cx, cz, si ^ 0xa4) * 3); // 4..6 blocks
      if (c.h + trunk + 3 >= HEIGHT) return null;
      return { x: px, z: pz, h: c.h, trunk };
    }

    function stampTree(data, x0, z0, t) {
      const put = (wx, y, wz, b, onlyAir) => {
        const lx = wx - x0, lz = wz - z0;
        if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || y < 0 || y >= HEIGHT) return;
        const i = (y * CHUNK + lz) * CHUNK + lx;
        if (!onlyAir || data[i] === B.AIR) data[i] = b;
      };
      const top = t.h + t.trunk;
      for (let y = t.h + 1; y <= top; y++) put(t.x, y, t.z, B.WOOD, false);
      for (let y = top - 2; y <= top + 1; y++) {
        const r = y >= top ? 1 : 2;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            if (corner && (y === top + 1 || hash2(t.x + dx * 131, t.z + dz * 137 + y * 7, si ^ 0xa5) < 0.5)) continue;
            put(t.x + dx, y, t.z + dz, B.LEAVES, true);
          }
        }
      }
    }

    // Index into a chunk array: x fastest, then z, then y.
    function generateChunk(cx, cz) {
      const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
      const x0 = cx * CHUNK, z0 = cz * CHUNK;

      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const c = column(x0 + lx, z0 + lz);
          for (let y = 0; y <= c.h; y++) {
            data[(y * CHUNK + lz) * CHUNK + lx] =
              y === 0 ? B.BEDROCK : y === c.h ? c.top : y >= c.h - c.depth ? c.sub : B.STONE;
          }
          for (let y = c.h + 1; y <= SEA; y++) data[(y * CHUNK + lz) * CHUNK + lx] = B.WATER;
        }
      }

      // Trees from neighbouring cells can overhang into this chunk (leaves reach 2 blocks).
      const cellX0 = Math.floor((x0 - 2) / TREE_CELL), cellX1 = Math.floor((x0 + CHUNK + 1) / TREE_CELL);
      const cellZ0 = Math.floor((z0 - 2) / TREE_CELL), cellZ1 = Math.floor((z0 + CHUNK + 1) / TREE_CELL);
      for (let tz = cellZ0; tz <= cellZ1; tz++) {
        for (let tx = cellX0; tx <= cellX1; tx++) {
          const t = treeInCell(tx, tz);
          if (t) stampTree(data, x0, z0, t);
        }
      }
      return data;
    }

    return { seed: String(seed), generateChunk, column };
  }

  return { createWorld, seedToInt, CHUNK, HEIGHT, SEA, B, MAX_HP, MAX_STACK, BREAK_TIME };
});
