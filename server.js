const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "game.html")));

// ─── Constants ─────────────────────────────────────────────────────────────────
const MAX_LOBBY_PLAYERS = 10;
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const LOBBY_LIFETIME_MS = 15 * 60 * 1000;
const POST_GAME_GRACE_MS = 5 * 60 * 1000;
const LOBBY_IDLE_MS = 30 * 60 * 1000;

// World bounds: ARENA_WIDTH=6792, ARENA_HEIGHT=3704, WORLD_SCALE=38
const WORLD_BOUNDS_X = 6792 / 2 / 38; // ≈ 89.37
const WORLD_BOUNDS_Y = 3704 / 2 / 38; // ≈ 48.74

// ─── Enemy type definitions (mirror of client ENEMY_TYPES) ────────────────────
const ENEMY_TYPES = [
  { id: "shadow", hp: 30, spd: 1.6, dmg: 8, xp: 5, points: 10, size: 18 },
  { id: "wraith", hp: 60, spd: 1.2, dmg: 15, xp: 10, points: 20, size: 22 },
  { id: "golem", hp: 200, spd: 0.6, dmg: 25, xp: 20, points: 60, size: 28 },
  { id: "specter", hp: 40, spd: 2.4, dmg: 10, xp: 8, points: 12, size: 16 },
  { id: "demon", hp: 150, spd: 1.0, dmg: 30, xp: 25, points: 80, size: 26 },
  { id: "revenant", hp: 80, spd: 1.4, dmg: 20, xp: 15, points: 30, size: 20 },
];

// ─── State ─────────────────────────────────────────────────────────────────────
const players = {}; // socketId → player meta
const lobbies = {}; // lobbyId → lobby object

let _enemyIdCounter = 0;
function makeEnemyId() {
  return ++_enemyIdCounter;
}
function makeLobbyId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─── Enemy helpers ─────────────────────────────────────────────────────────────
function spawnEnemy(lobby, wave) {
  const members = Object.values(lobby.members).filter((m) => !m.dead);
  if (members.length === 0) return null;

  const target = members[Math.floor(Math.random() * members.length)];
  const bx = target.x,
    by = target.y;

  const minDist = 6,
    maxDist = 10;
  let ex = 0,
    ey = 0,
    tries = 0;
  while (tries < 20) {
    const angle = Math.random() * Math.PI * 2;
    const dist = minDist + Math.random() * (maxDist - minDist);
    ex = bx + Math.cos(angle) * dist;
    ey = by + Math.sin(angle) * dist;
    let tooClose = false;
    for (const m of members) {
      if ((ex - m.x) ** 2 + (ey - m.y) ** 2 < 25) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) break;
    tries++;
  }
  ex = Math.max(-WORLD_BOUNDS_X, Math.min(WORLD_BOUNDS_X, ex));
  ey = Math.max(-WORLD_BOUNDS_Y, Math.min(WORLD_BOUNDS_Y, ey));

  const typeIdx = Math.floor(
    Math.random() * Math.min(2 + Math.floor(wave / 2), ENEMY_TYPES.length),
  );
  const type = ENEMY_TYPES[typeIdx];
  const hp = type.hp * (1 + (wave - 1) * 0.3);
  return {
    id: makeEnemyId(),
    typeId: type.id,
    hp,
    maxHp: hp,
    x: ex,
    y: ey,
    speed: type.spd * (1 + (wave - 1) * 0.08),
    dmg: type.dmg * (1 + (wave - 1) * 0.15),
    xp: type.xp,
    points: type.points,
    alive: true,
    size: type.size,
  };
}

function spawnWave(lobby, wave) {
  const activePlayers = Math.max(
    1,
    Object.values(lobby.members).filter((m) => !m.dead).length,
  );
  const base = Math.ceil((8 + wave * 4) * Math.sqrt(activePlayers));
  for (let i = 0; i < base; i++) {
    if (lobby.enemies.filter((e) => e.alive).length < 500) {
      const e = spawnEnemy(lobby, wave);
      if (e) lobby.enemies.push(e);
    }
  }
}

// ─── Lobby helpers ─────────────────────────────────────────────────────────────
function buildLeaderboard(lobby) {
  return Object.values(lobby.scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}
function broadcastLeaderboard(lobby) {
  io.to(lobby.id).emit("leaderboard", buildLeaderboard(lobby));
}
function broadcastLobbyList() {
  const list = Object.values(lobbies).map((l) => ({
    id: l.id,
    name: l.name,
    host: l.hostName,
    players: Object.keys(l.members).length,
    maxPlayers: MAX_LOBBY_PLAYERS,
    started: l.started,
    expiresIn: Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000)),
  }));
  io.emit("lobbyList", list);
}
function cleanupLobbies() {
  const now = Date.now();
  for (const id in lobbies) {
    if (lobbies[id].expiresAt <= now) {
      io.to(id).emit("lobbyExpired");
      delete lobbies[id];
      console.log("Lobby expired:", id);
    }
  }
  broadcastLobbyList();
}
setInterval(cleanupLobbies, 10000);

// ─── Socket handling ───────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connect", socket.id);

  socket.on("listLobbies", () => {
    const list = Object.values(lobbies).map((l) => ({
      id: l.id,
      name: l.name,
      host: l.hostName,
      players: Object.keys(l.members).length,
      maxPlayers: MAX_LOBBY_PLAYERS,
      started: l.started,
      expiresIn: Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000)),
    }));
    socket.emit("lobbyList", list);
  });

  socket.on("createLobby", ({ name, cls, playerName }) => {
    leavePreviousLobby(socket);
    const id = makeLobbyId();
    const lobby = {
      id,
      name: playerName ? `${playerName}'s Lobby` : "Sacred Arena",
      hostId: socket.id,
      hostName: playerName || "Host",
      members: {},
      scores: {},
      started: false,
      locked: false, // true once match starts — no new joins allowed
      enemies: [],
      wave: 1,
      elapsed: 0,
      lastSpawnTime: 0,
      expiresAt: Date.now() + LOBBY_IDLE_MS,
    };
    const p = makePlayer(socket.id, playerName, cls);
    lobby.members[socket.id] = p;
    lobby.scores[socket.id] = makeScore(socket.id, p.name, cls);
    players[socket.id] = { ...p, lobbyId: id };
    lobbies[id] = lobby;

    socket.join(id);
    socket.emit("lobbyCreated", { lobbyId: id });
    socket.emit("lobbyState", Object.values(lobby.members));
    broadcastLobbyList();
    console.log("Lobby created:", id, "by", p.name);
  });

  socket.on("joinLobby", ({ lobbyId, name, cls, playerName }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) {
      socket.emit("joinFailed", "Lobby not found.");
      return;
    }
    // Block joins once match has started (locked)
    if (lobby.locked) {
      socket.emit("joinFailed", "Match already in progress.");
      return;
    }
    if (Object.keys(lobby.members).length >= MAX_LOBBY_PLAYERS) {
      socket.emit(
        "joinFailed",
        "Lobby is full (max " + MAX_LOBBY_PLAYERS + ").",
      );
      return;
    }

    leavePreviousLobby(socket);
    const p = makePlayer(socket.id, playerName || name, cls);
    lobby.members[socket.id] = p;
    if (!lobby.scores[socket.id]) {
      lobby.scores[socket.id] = makeScore(socket.id, p.name, cls);
    } else {
      lobby.scores[socket.id].dead = false;
    }
    players[socket.id] = { ...p, lobbyId };

    socket.join(lobbyId);
    io.to(lobbyId).emit("lobbyState", Object.values(lobby.members));
    broadcastLobbyList();
    broadcastLeaderboard(lobby);
    console.log(
      "Player joined:",
      lobbyId,
      p.name,
      Object.keys(lobby.members).length,
    );
  });

  socket.on("rejoin", ({ cls, playerName } = {}) => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;
    if (cls) {
      meta.cls = cls;
      if (lobby.members[socket.id]) lobby.members[socket.id].cls = cls;
    }
    if (playerName) {
      meta.name = playerName;
      if (lobby.members[socket.id]) lobby.members[socket.id].name = playerName;
    }
    socket.join(meta.lobbyId);
    socket.emit("lobbyState", Object.values(lobby.members));
  });

  socket.on("changeClass", ({ cls }) => {
    const meta = players[socket.id];
    if (!meta || !cls) return;
    meta.cls = cls;
    const lobby = meta.lobbyId ? lobbies[meta.lobbyId] : null;
    if (lobby && lobby.members[socket.id]) {
      lobby.members[socket.id].cls = cls;
      io.to(lobby.id).emit("lobbyState", Object.values(lobby.members));
      socket.to(lobby.id).emit("playerClassChanged", { id: socket.id, cls });
    }
  });

  socket.on("input", (data) => {
    const meta = players[socket.id];
    if (!meta) return;
    meta.input = {
      dx: Number(data.dx) || 0,
      dy: Number(data.dy) || 0,
      speed: Number(data.speed) || 2.4,
    };
    meta.lastActive = Date.now();
    const lobby = meta.lobbyId ? lobbies[meta.lobbyId] : null;
    if (lobby && lobby.members[socket.id]) {
      lobby.members[socket.id].input = meta.input;
      lobby.members[socket.id].lastActive = meta.lastActive;
    }
  });

  socket.on("fireProjectile", (proj) => {
    if (!proj) return;
    const meta = players[socket.id];
    const lobbyId = meta?.lobbyId;
    const payload = Object.assign({}, proj, {
      ownerId: socket.id,
      sentAt: Date.now(),
    });
    if (lobbyId) socket.to(lobbyId).emit("projectile", payload);
    else socket.broadcast.emit("projectile", payload);
  });

  socket.on("ability", (data) => {
    if (!data) return;
    const meta = players[socket.id];
    const lobbyId = meta?.lobbyId;
    const payload = Object.assign({}, data, { ownerId: socket.id });
    if (lobbyId) socket.to(lobbyId).emit("ability", payload);
    else socket.broadcast.emit("ability", payload);
  });

  // Client reports a hit on a server enemy
  socket.on("hitEnemy", ({ enemyId, damage, wave }) => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;
    const enemy = lobby.enemies.find((e) => e.id === enemyId && e.alive);
    if (!enemy) return;

    enemy.hp -= damage || 0;
    if (enemy.hp <= 0) {
      enemy.alive = false;
      // Award points/XP to the killing player
      const score = lobby.scores[socket.id];
      if (score) {
        score.score = (score.score || 0) + (enemy.points || 0);
        score.wave = wave || score.wave;
      }
      // Notify all clients: enemy died, award XP to killer
      io.to(lobby.id).emit("enemyDied", {
        enemyId: enemy.id,
        xp: enemy.xp,
        points: enemy.points,
        killerId: socket.id,
        x: enemy.x,
        y: enemy.y,
      });
      if (!lobby._lbThrottle) {
        lobby._lbThrottle = setTimeout(() => {
          broadcastLeaderboard(lobby);
          lobby._lbThrottle = null;
        }, 1000);
      }
    } else {
      // Broadcast updated HP to all for health bar sync
      io.to(lobby.id).emit("enemyHurt", {
        enemyId: enemy.id,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
      });
    }
  });

  socket.on("enemyKilled", ({ points, enemyId, wave }) => {
    // Legacy path for solo mode scoring (no shared pool)
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;
    const entry = lobby.scores[socket.id];
    if (entry) {
      entry.score = (entry.score || 0) + (points || 0);
      entry.wave = wave || entry.wave;
    }
    if (!lobby._lbThrottle) {
      lobby._lbThrottle = setTimeout(() => {
        broadcastLeaderboard(lobby);
        lobby._lbThrottle = null;
      }, 1000);
    }
  });

  socket.on("playerDead", ({ x, y, name, wave, score }) => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    handlePlayerDead(socket, meta.lobbyId, { x, y, name, wave, score });
  });

  socket.on("startNow", () => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return;
    startLobbyMatch(lobby);
  });

  socket.on("disconnect", () => {
    const meta = players[socket.id];
    if (meta && meta.lobbyId) {
      const lobby = lobbies[meta.lobbyId];
      if (lobby) {
        if (lobby.started) {
          // Match in progress: treat disconnect as death
          handlePlayerDead(socket, meta.lobbyId, {
            x: lobby.members[socket.id]?.x || 0,
            y: lobby.members[socket.id]?.y || 0,
            name: meta.name,
            wave: lobby.wave,
            score: lobby.scores[socket.id]?.score || 0,
          });
        } else {
          // Pre-match lobby: just remove them
          delete lobby.members[socket.id];
          delete lobby.scores[socket.id];
          if (lobby.hostId === socket.id) {
            const remaining = Object.keys(lobby.members);
            if (remaining.length > 0) {
              lobby.hostId = remaining[0];
              lobby.hostName = lobby.members[remaining[0]]?.name || "Host";
            } else {
              delete lobbies[meta.lobbyId];
            }
          }
          if (lobbies[meta.lobbyId]) {
            io.to(meta.lobbyId).emit(
              "lobbyState",
              Object.values(lobby.members),
            );
          }
        }
      }
    }
    delete players[socket.id];
    broadcastLobbyList();
    console.log("disconnect", socket.id, Object.keys(players).length);
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function makePlayer(id, playerName, cls) {
  return {
    id,
    cls: cls || "priest",
    name: playerName || "Player" + Math.floor(Math.random() * 1000),
    x: (Math.random() - 0.5) * 2,
    y: (Math.random() - 0.5) * 2,
    hp: 100,
    level: 1,
    dead: false,
    input: { dx: 0, dy: 0, speed: 2.4 },
    lastActive: Date.now(),
    _idleCounter: 0,
  };
}
function makeScore(id, name, cls) {
  return { id, name, cls: cls || "priest", score: 0, wave: 1, dead: false };
}

function startLobbyMatch(lobby) {
  lobby.started = true;
  lobby.locked = true; // no new joins once match starts
  lobby.wave = 1;
  lobby.elapsed = 0;
  lobby.lastSpawnTime = 0;
  lobby.enemies = [];
  lobby.expiresAt = Date.now() + LOBBY_LIFETIME_MS + POST_GAME_GRACE_MS;
  spawnWave(lobby, 1);
  io.to(lobby.id).emit("startMatch", {
    playerStates: Object.values(lobby.members),
  });
  broadcastLobbyList();
  console.log(
    "Match started:",
    lobby.id,
    "players:",
    Object.keys(lobby.members).length,
  );
}

function handlePlayerDead(socket, lobbyId, { x, y, name, wave, score }) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  const meta = players[socket.id];
  const entry = lobby.scores[socket.id];
  if (entry) {
    entry.dead = true;
    entry.score = Math.max(entry.score || 0, score || 0);
    entry.wave = wave || entry.wave;
  }
  delete lobby.members[socket.id];
  if (lobby.hostId === socket.id) {
    const remaining = Object.keys(lobby.members);
    if (remaining.length > 0) {
      lobby.hostId = remaining[0];
      lobby.hostName = lobby.members[remaining[0]]?.name || "Host";
    }
  }
  const lb = buildLeaderboard(lobby);
  io.to(lobbyId).emit("playerDied", {
    id: socket.id,
    x: x || 0,
    y: y || 0,
    name: name || meta?.name || "Unknown",
    wave: wave || 1,
    score: score || 0,
    leaderboard: lb,
  });
  io.to(lobbyId).emit("lobbyState", Object.values(lobby.members));
  broadcastLeaderboard(lobby);
  broadcastLobbyList();
  console.log("Player dead (freed slot):", meta?.name, "in lobby", lobbyId);
}

function leavePreviousLobby(socket) {
  const meta = players[socket.id];
  if (!meta || !meta.lobbyId) return;
  const lobby = lobbies[meta.lobbyId];
  if (lobby) {
    delete lobby.members[socket.id];
    delete lobby.scores[socket.id];
    if (lobby.hostId === socket.id) {
      const remaining = Object.keys(lobby.members);
      if (remaining.length > 0) {
        lobby.hostId = remaining[0];
        lobby.hostName = lobby.members[remaining[0]]?.name || "Host";
      } else {
        delete lobbies[meta.lobbyId];
      }
    }
    if (lobbies[meta.lobbyId]) {
      io.to(meta.lobbyId).emit("lobbyState", Object.values(lobby.members));
    }
  }
  socket.leave(meta.lobbyId);
}

// ─── Physics & enemy tick ──────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const lobbyId in lobbies) {
    const lobby = lobbies[lobbyId];
    const allMembers = Object.values(lobby.members);

    // ── Player movement ────────────────────────────────────────────────────────
    for (const p of allMembers) {
      if (p.dead) continue;
      const dx = p.input?.dx || 0,
        dy = p.input?.dy || 0;
      const speed = p.input?.speed || 2.4;
      p.x = Math.max(
        -WORLD_BOUNDS_X,
        Math.min(WORLD_BOUNDS_X, p.x + dx * speed * DT),
      );
      p.y = Math.max(
        -WORLD_BOUNDS_Y,
        Math.min(WORLD_BOUNDS_Y, p.y + dy * speed * DT),
      );

      // Idle auto-fire
      const idleMs = now - (p.lastActive || 0);
      if (idleMs > 1200) {
        p._idleCounter = (p._idleCounter || 0) + DT;
        if (p._idleCounter >= 0.8) {
          p._idleCounter = 0;
          const angle = Math.random() * Math.PI * 2;
          io.to(lobbyId).emit("projectile", {
            x: p.x,
            y: p.y,
            dx: Math.cos(angle) * 8,
            dz: Math.sin(angle) * 8,
            damage: 12,
            color: "#ffd866",
            type: "proj",
            sourceAbility: "autofire",
            ownerId: p.id,
            sentAt: now,
          });
        }
      } else {
        p._idleCounter = 0;
      }
    }

    // ── Enemy simulation (only for started lobbies) ────────────────────────────
    if (!lobby.started) continue;

    lobby.elapsed += DT;
    const newWave = Math.floor(lobby.elapsed / 60) + 1;
    if (newWave !== lobby.wave) {
      lobby.wave = newWave;
      spawnWave(lobby, newWave);
    }

    // Spawn system
    lobby.lastSpawnTime += DT;
    const activePlayers = Math.max(1, allMembers.filter((m) => !m.dead).length);
    const playerScale = Math.sqrt(activePlayers);
    const spawnInterval = Math.max(0.4, (3 - lobby.wave * 0.2) / playerScale);
    if (lobby.lastSpawnTime >= spawnInterval) {
      lobby.lastSpawnTime = 0;
      const count = Math.min(Math.ceil((3 + lobby.wave) * playerScale), 20);
      const aliveCount = lobby.enemies.filter((e) => e.alive).length;
      const maxEnemies = Math.min(500, 150 * activePlayers);
      for (let i = 0; i < count; i++) {
        if (aliveCount + i < maxEnemies) {
          const e = spawnEnemy(lobby, lobby.wave);
          if (e) lobby.enemies.push(e);
        }
      }
    }

    // Move enemies toward nearest player
    const alivePlayers = allMembers.filter((m) => !m.dead);
    const movedEnemyIds = [];
    for (const e of lobby.enemies) {
      if (!e.alive) continue;
      let tx = 0,
        ty = 0,
        bestDist = Infinity;
      for (const p of alivePlayers) {
        const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d2 < bestDist) {
          bestDist = d2;
          tx = p.x;
          ty = p.y;
        }
      }
      if (alivePlayers.length > 0) {
        const dx = tx - e.x,
          dy = ty - e.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        e.x += (dx / d) * e.speed * DT;
        e.y += (dy / d) * e.speed * DT;
        movedEnemyIds.push(e.id);
      }
    }

    // Cull dead enemies periodically
    if (lobby.enemies.length > 1000) {
      lobby.enemies = lobby.enemies.filter((e) => e.alive);
    }

    // Broadcast full enemy snapshot (pos + hp + wave) to all clients in lobby
    const aliveEnemies = lobby.enemies.filter((e) => e.alive);
    if (aliveEnemies.length > 0 || lobby._prevEnemyCount > 0) {
      io.to(lobbyId).emit("enemyState", {
        wave: lobby.wave,
        enemies: aliveEnemies.map((e) => ({
          id: e.id,
          typeId: e.typeId,
          x: e.x,
          y: e.y,
          hp: e.hp,
          maxHp: e.maxHp,
          size: e.size,
        })),
      });
    }
    lobby._prevEnemyCount = aliveEnemies.length;

    // Broadcast player state
    if (allMembers.length > 0) {
      io.to(lobbyId).emit(
        "state",
        allMembers.map((p) => ({
          id: p.id,
          x: p.x,
          y: p.y,
          cls: p.cls,
          name: p.name,
          dead: p.dead,
          hp: p.hp,
          level: p.level,
        })),
      );
    }
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Server listening on http://localhost:" + PORT),
);
