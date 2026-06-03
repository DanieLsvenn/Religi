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

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE        = 20;
const DT               = 1 / TICK_RATE;
const LOBBY_LIFETIME   = 15 * 60 * 1000; // ms

// ─── In-memory state ──────────────────────────────────────────────────────────
// players : socketId → { id, name, cls, x, y, hp, level, dead, input,
//                        lastActive, _idleCounter, lobbyId }
// lobbies : lobbyId  → { id, name, hostId, hostName, maxPlayers, gameTime,
//                        members, scores, started, matchEndAt, expiresAt }
const players = {};
const lobbies = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLobbyId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Build a sorted leaderboard array from a lobby's scores map. */
function buildLeaderboard(lobby) {
  return Object.values(lobby.scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

/** Emit the current leaderboard to every socket in a lobby. */
function broadcastLeaderboard(lobby) {
  io.to(lobby.id).emit("leaderboard", buildLeaderboard(lobby));
}

/** Build and emit the public lobby list to ALL connected sockets. */
function broadcastLobbyList() {
  const now  = Date.now();
  const list = Object.values(lobbies).map((l) => ({
    id:        l.id,
    name:      l.name,
    host:      l.hostName,
    players:   Object.keys(l.members).length,
    maxPlayers: l.maxPlayers,
    started:   l.started,
    expiresIn: Math.max(0, Math.ceil((l.expiresAt - now) / 1000)),
  }));
  io.emit("lobbyList", list);
}

/** Create a fresh player object for a socket joining a lobby. */
function makePlayer(socketId, name, cls, spawnX = 0, spawnY = 0) {
  return {
    id:           socketId,
    name:         name || "Player" + Math.floor(Math.random() * 1000),
    cls:          cls  || "priest",
    x:            spawnX,
    y:            spawnY,
    hp:           100,
    level:        1,
    dead:         false,
    input:        { dx: 0, dy: 0, speed: 2.4 },
    lastActive:   Date.now(),
    _idleCounter: 0,
  };
}

/** Create a fresh score-board entry for a player. */
function makeScoreEntry(p) {
  return { id: p.id, name: p.name, cls: p.cls, score: 0, wave: 1, dead: false };
}

/**
 * Remove a socket from whatever lobby it currently occupies.
 * Reassigns host if the host left and the lobby still has members.
 * Deletes the lobby if it becomes empty.
 */
function leaveLobby(socket) {
  const meta = players[socket.id];
  if (!meta?.lobbyId) return;

  const lobby = lobbies[meta.lobbyId];
  if (!lobby) return;

  delete lobby.members[socket.id];
  delete lobby.scores[socket.id];
  socket.leave(meta.lobbyId);

  const remaining = Object.keys(lobby.members);

  if (remaining.length === 0) {
    // Empty lobby — clean it up
    delete lobbies[meta.lobbyId];
    broadcastLobbyList();
    return;
  }

  // Reassign host if the host just left
  if (lobby.hostId === socket.id) {
    lobby.hostId   = remaining[0];
    lobby.hostName = lobby.members[remaining[0]]?.name ?? "Host";
  }

  io.to(meta.lobbyId).emit("lobbyState", {
    players:    Object.values(lobby.members),
    maxPlayers: lobby.maxPlayers,
    hostId:     lobby.hostId,
  });
  broadcastLobbyList();
}

// ─── Periodic tasks ───────────────────────────────────────────────────────────

/** Every second: push remaining match time and end finished matches. */
setInterval(() => {
  const now = Date.now();
  for (const id in lobbies) {
    const lobby = lobbies[id];
    if (!lobby.started || !lobby.matchEndAt) continue;

    const remaining = Math.max(0, Math.ceil((lobby.matchEndAt - now) / 1000));
    io.to(id).emit("matchTimer", remaining);

    if (remaining <= 0) {
      io.to(id).emit("matchEnded");
      delete lobbies[id];
      broadcastLobbyList();
      console.log("Match finished — lobby removed:", id);
    }
  }
}, 1000);

/** Every second: push per-lobby expiry countdowns to the lobby-browser UI. */
setInterval(() => {
  const now  = Date.now();
  const list = Object.values(lobbies).map((l) => ({
    id:        l.id,
    expiresIn: Math.max(0, Math.ceil((l.expiresAt - now) / 1000)),
  }));
  io.emit("lobbyTimers", list);
}, 1000);

/** Every minute: remove lobbies whose lifetime has elapsed. */
setInterval(() => {
  const now = Date.now();
  for (const id in lobbies) {
    if (lobbies[id].expiresAt <= now) {
      io.to(id).emit("lobbyExpired");
      delete lobbies[id];
      console.log("Lobby expired:", id);
    }
  }
  broadcastLobbyList();
}, 60_000);

// ─── Physics / snapshot tick ──────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  for (const lobbyId in lobbies) {
    const lobby   = lobbies[lobbyId];
    const members = Object.values(lobby.members);
    if (members.length === 0) continue;

    // Idle auto-fire for players who haven't sent input recently
    for (const p of members) {
      if (p.dead) continue;
      const idleMs = now - (p.lastActive ?? 0);
      if (idleMs > 1200) {
        p._idleCounter = (p._idleCounter ?? 0) + DT;
        if (p._idleCounter >= 0.8) {
          p._idleCounter = 0;
          const angle = Math.random() * Math.PI * 2;
          io.to(lobbyId).emit("projectile", {
            x:             p.x,
            y:             p.y,
            dx:            Math.cos(angle) * 8,
            dz:            Math.sin(angle) * 8,
            damage:        12,
            color:         "#ffd866",
            type:          "proj",
            sourceAbility: "autofire",
            ownerId:       p.id,
            sentAt:        now,
          });
        }
      } else {
        p._idleCounter = 0;
      }
    }

    // Broadcast world snapshot so every client can render remote players
    const snapshot = members.map((p) => ({
      id:    p.id,
      x:     p.x,
      y:     p.y,
      cls:   p.cls,
      name:  p.name,
      dead:  p.dead,
      hp:    p.hp,
      level: p.level,
    }));
    io.to(lobbyId).emit("state", snapshot);
  }
}, 1000 / TICK_RATE);

// ─── Socket event handlers ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // ── Lobby browser ──────────────────────────────────────────────────────────

  socket.on("listLobbies", () => {
    const now  = Date.now();
    const list = Object.values(lobbies).map((l) => ({
      id:        l.id,
      name:      l.name,
      host:      l.hostName,
      players:   Object.keys(l.members).length,
      maxPlayers: l.maxPlayers,
      started:   l.started,
      expiresIn: Math.max(0, Math.ceil((l.expiresAt - now) / 1000)),
    }));
    socket.emit("lobbyList", list);
  });

  // ── Create lobby ───────────────────────────────────────────────────────────

  socket.on("createLobby", ({ name, cls, playerName, maxPlayers, gameTime }) => {
    leaveLobby(socket);

    const id    = makeLobbyId();
    const pName = playerName || "Player" + Math.floor(Math.random() * 1000);

    const spawn = { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2 };
    const p     = makePlayer(socket.id, pName, cls, spawn.x, spawn.y);

    const lobby = {
      id,
      name:       name || `${pName}'s Lobby`,
      hostId:     socket.id,
      hostName:   pName,
      maxPlayers: maxPlayers || 10,
      gameTime:   gameTime   || 900,
      members:    { [socket.id]: p },
      scores:     { [socket.id]: makeScoreEntry(p) },
      started:    false,
      matchEndAt: null,
      expiresAt:  Date.now() + LOBBY_LIFETIME,
    };

    players[socket.id] = { ...p, lobbyId: id };
    lobbies[id]        = lobby;

    socket.join(id);
    socket.emit("lobbyCreated", { lobbyId: id });
    socket.emit("lobbyState", {
      players:    Object.values(lobby.members),
      maxPlayers: lobby.maxPlayers,
      hostId:     lobby.hostId,
    });
    broadcastLobbyList();
    console.log("Lobby created:", id, "by", pName);
  });

  // ── Join existing lobby ────────────────────────────────────────────────────

  socket.on("joinLobby", ({ lobbyId, cls, playerName }) => {
    const lobby = lobbies[lobbyId];

    if (!lobby)                                           return socket.emit("joinFailed", "Lobby not found.");
    if (lobby.started)                                    return socket.emit("joinFailed", "Game already in progress.");
    if (Object.keys(lobby.members).length >= lobby.maxPlayers) return socket.emit("joinFailed", `Lobby is full (max ${lobby.maxPlayers}).`);

    leaveLobby(socket);

    // Spread spawns evenly around the camp centre
    const memberCount = Object.keys(lobby.members).length;
    const angle       = (memberCount / lobby.maxPlayers) * Math.PI * 2;
    const p           = makePlayer(socket.id, playerName, cls,
                                   Math.cos(angle) * 6, Math.sin(angle) * 6);

    lobby.members[socket.id] = p;
    lobby.scores[socket.id]  = makeScoreEntry(p);
    players[socket.id]       = { ...p, lobbyId };

    socket.join(lobbyId);
    io.to(lobbyId).emit("lobbyState", {
      players:    Object.values(lobby.members),
      maxPlayers: lobby.maxPlayers,
      hostId:     lobby.hostId,
    });
    broadcastLobbyList();
    broadcastLeaderboard(lobby);

    console.log("Player joined:", lobbyId, p.name, Object.keys(lobby.members).length);
  });

  // ── Reconnect into existing lobby (e.g. page refresh) ─────────────────────

  socket.on("rejoin", ({ cls, playerName } = {}) => {
    const meta  = players[socket.id];
    if (!meta?.lobbyId) return;

    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;

    // Update mutable fields if the client provided them
    if (cls) {
      meta.cls = cls;
      if (lobby.members[socket.id]) lobby.members[socket.id].cls = cls;
    }
    if (playerName) {
      meta.name = playerName;
      if (lobby.members[socket.id]) lobby.members[socket.id].name = playerName;
    }

    socket.join(meta.lobbyId);
    socket.emit("lobbyState", {
      players:    Object.values(lobby.members),
      maxPlayers: lobby.maxPlayers,
      hostId:     lobby.hostId,
    });
    if (lobby.started) {
      socket.emit("startMatch", {
        playerStates: Object.values(lobby.members),
        gameTime:     lobby.gameTime,
      });
    }
  });

  // ── Class change (lobby screen) ────────────────────────────────────────────

  socket.on("changeClass", ({ cls }) => {
    if (!cls) return;
    const meta  = players[socket.id];
    if (!meta)  return;

    meta.cls = cls;
    const lobby = meta.lobbyId ? lobbies[meta.lobbyId] : null;
    if (!lobby) return;

    if (lobby.members[socket.id]) lobby.members[socket.id].cls = cls;
    io.to(lobby.id).emit("lobbyState", {
      players:    Object.values(lobby.members),
      maxPlayers: lobby.maxPlayers,
      hostId:     lobby.hostId,
    });
    socket.to(lobby.id).emit("playerClassChanged", { id: socket.id, cls });
  });

  // ── In-game input ──────────────────────────────────────────────────────────

  socket.on("input", ({ dx, dy, speed }) => {
    const meta = players[socket.id];
    if (!meta) return;

    const input = { dx: Number(dx) || 0, dy: Number(dy) || 0, speed: Number(speed) || 2.4 };
    meta.input      = input;
    meta.lastActive = Date.now();

    const lobby = meta.lobbyId ? lobbies[meta.lobbyId] : null;
    if (lobby?.members[socket.id]) {
      lobby.members[socket.id].input      = input;
      lobby.members[socket.id].lastActive = meta.lastActive;
    }
  });

  socket.on("playerTransform", ({ x, y, hp, level, dead }) => {
    const meta = players[socket.id];
    if (!meta?.lobbyId) return;

    const member = lobbies[meta.lobbyId]?.members[socket.id];
    if (!member) return;

    member.x     = x;
    member.y     = y;
    member.hp    = hp;
    member.level = level;
    member.dead  = dead;
  });

  // ── Combat events ──────────────────────────────────────────────────────────

  socket.on("fireProjectile", (proj) => {
    if (!proj) return;
    const lobbyId = players[socket.id]?.lobbyId;
    const payload = { ...proj, ownerId: socket.id, sentAt: Date.now() };
    if (lobbyId) socket.to(lobbyId).emit("projectile", payload);
    else         socket.broadcast.emit("projectile", payload);
  });

  socket.on("ability", (data) => {
    if (!data) return;
    const lobbyId = players[socket.id]?.lobbyId;
    const payload = { ...data, ownerId: socket.id };
    if (lobbyId) socket.to(lobbyId).emit("ability", payload);
    else         socket.broadcast.emit("ability", payload);
  });

  socket.on("enemyKilled", ({ points, wave }) => {
    const meta  = players[socket.id];
    if (!meta?.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;

    const entry = lobby.scores[socket.id];
    if (entry) {
      entry.score = (entry.score || 0) + (points || 0);
      if (wave) entry.wave = wave;
    }

    // Throttle leaderboard broadcasts to at most once per second
    if (!lobby._lbThrottle) {
      lobby._lbThrottle = setTimeout(() => {
        broadcastLeaderboard(lobby);
        lobby._lbThrottle = null;
      }, 1000);
    }
  });

  socket.on("playerDead", ({ x, y, name, wave, score }) => {
    const meta  = players[socket.id];
    if (!meta?.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;

    if (lobby.members[socket.id]) lobby.members[socket.id].dead = true;

    const entry = lobby.scores[socket.id];
    if (entry) {
      entry.dead  = true;
      entry.score = Math.max(entry.score || 0, score || 0);
      if (wave) entry.wave = wave;
    }

    const lb = buildLeaderboard(lobby);
    io.to(lobby.id).emit("playerDied", {
      id:          socket.id,
      x:           x    || 0,
      y:           y    || 0,
      name:        name || meta.name || "Unknown",
      wave:        wave || 1,
      score:       score || 0,
      leaderboard: lb,
    });
    broadcastLeaderboard(lobby);
  });

  // ── Match control ──────────────────────────────────────────────────────────

  socket.on("startNow", () => {
    const meta  = players[socket.id];
    if (!meta?.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby || lobby.hostId !== socket.id) return; // only host may start

    lobby.started    = true;
    lobby.matchEndAt = Date.now() + lobby.gameTime * 1000;

    io.to(lobby.id).emit("startMatch", {
      playerStates: Object.values(lobby.members),
      gameTime:     lobby.gameTime,
    });
    broadcastLobbyList();
  });

  socket.on("leaveLobby", () => {
    leaveLobby(socket);
    if (players[socket.id]) delete players[socket.id].lobbyId;
    broadcastLobbyList();
  });

  socket.on("disconnect", () => {
    leaveLobby(socket);
    delete players[socket.id];
    broadcastLobbyList();
    console.log("disconnect", socket.id, "remaining:", Object.keys(players).length);
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Multiplayer server listening on http://localhost:${PORT}`),
);