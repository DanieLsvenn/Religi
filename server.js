const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "game.html")));

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_LOBBY_PLAYERS = 10;
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const LOBBY_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes

// ─── State ────────────────────────────────────────────────────────────────────
const players = {}; // socketId → player meta
const lobbies = {}; // lobbyId → lobby object

// ─── Lobby helpers ────────────────────────────────────────────────────────────
function makeLobbyId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function buildLeaderboard(lobby) {
  return Object.values(lobby.scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

function broadcastLeaderboard(lobby) {
  const lb = buildLeaderboard(lobby);
  io.to(lobby.id).emit("leaderboard", lb);
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

// Expire lobbies after 15 minutes
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

// ─── Socket handling ──────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // ── Lobby management ────────────────────────────────────────────────────────

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
    // Clean up any existing lobby this socket is in
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
      expiresAt: Date.now() + LOBBY_LIFETIME_MS,
    };

    const p = {
      id: socket.id,
      name: playerName || "Player" + Math.floor(Math.random() * 1000),
      cls: cls || "priest",
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      hp: 100,
      level: 1,
      input: { dx: 0, dy: 0, speed: 2.4 },
      lastActive: Date.now(),
      _idleCounter: 0,
      dead: false,
    };
    lobby.members[socket.id] = p;
    lobby.scores[socket.id] = {
      id: socket.id,
      name: p.name,
      cls: p.cls,
      score: 0,
      wave: 1,
      dead: false,
    };
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
    if (Object.keys(lobby.members).length >= MAX_LOBBY_PLAYERS) {
      socket.emit(
        "joinFailed",
        "Lobby is full (max " + MAX_LOBBY_PLAYERS + ").",
      );
      return;
    }

    leavePreviousLobby(socket);

    const p = {
      id: socket.id,
      name: playerName || name || "Player" + Math.floor(Math.random() * 1000),
      cls: cls || "priest",
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      hp: 100,
      level: 1,
      input: { dx: 0, dy: 0, speed: 2.4 },
      lastActive: Date.now(),
      _idleCounter: 0,
      dead: false,
    };
    lobby.members[socket.id] = p;
    lobby.scores[socket.id] = {
      id: socket.id,
      name: p.name,
      cls: p.cls,
      score: 0,
      wave: 1,
      dead: false,
    };
    players[socket.id] = { ...p, lobbyId };

    socket.join(lobbyId);
    io.to(lobbyId).emit("lobbyState", Object.values(lobby.members));
    broadcastLobbyList();
    broadcastLeaderboard(lobby);

    // If match already started, send startMatch immediately so late/returning player can rejoin
    if (lobby.started) {
      socket.emit("startMatch", { playerStates: Object.values(lobby.members) });
    }
    console.log(
      "Player joined lobby:",
      lobbyId,
      p.name,
      Object.keys(lobby.members).length,
    );
  });

  // Legacy join for backwards compatibility
  socket.on("join", ({ name, cls }) => {
    // If they're already in a lobby, just update their info
    const existing = players[socket.id];
    if (existing && existing.lobbyId) {
      const lobby = lobbies[existing.lobbyId];
      if (lobby && lobby.members[socket.id]) {
        lobby.members[socket.id].cls = cls || lobby.members[socket.id].cls;
        lobby.members[socket.id].name = name || lobby.members[socket.id].name;
        io.to(existing.lobbyId).emit(
          "lobbyState",
          Object.values(lobby.members),
        );
        return;
      }
    }
    // Otherwise, auto-create a lobby
    socket.emit("needLobby");
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
    // Re-join the socket room (in case they reconnected)
    socket.join(meta.lobbyId);
    socket.emit("lobbyState", Object.values(lobby.members));
    if (lobby.started) {
      socket.emit("startMatch", { playerStates: Object.values(lobby.members) });
    }
  });

  socket.on("changeClass", ({ cls }) => {
    const meta = players[socket.id];
    if (!meta || !cls) return;
    meta.cls = cls;
    const lobby = meta.lobbyId ? lobbies[meta.lobbyId] : null;
    if (lobby && lobby.members[socket.id]) {
      lobby.members[socket.id].cls = cls;
      io.to(lobby.id).emit("lobbyState", Object.values(lobby.members));
      // Notify other players to update this player's sprite
      socket.to(lobby.id).emit("playerClassChanged", { id: socket.id, cls });
    }
  });

  socket.on("input", (data) => {
    const meta = players[socket.id];
    if (!meta) return;
    meta.input = {
      dx: Number(data.dx) || 0,
      dy: Number(data.dy) || 0,
      speed: Number(data.speed) || meta.input?.speed || 2.4,
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
      sentAt: Date.now(), // for client-side desync correction
    });
    if (lobbyId) {
      socket.to(lobbyId).emit("projectile", payload);
    } else {
      socket.broadcast.emit("projectile", payload);
    }
  });

  socket.on("ability", (data) => {
    if (!data) return;
    const meta = players[socket.id];
    const lobbyId = meta?.lobbyId;
    const payload = Object.assign({}, data, { ownerId: socket.id });
    if (lobbyId) socket.to(lobbyId).emit("ability", payload);
    else socket.broadcast.emit("ability", payload);
  });

  socket.on("enemyKilled", ({ points, enemyId, wave }) => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;
    const entry = lobby.scores[socket.id];
    if (entry) {
      entry.score = (entry.score || 0) + (points || 0);
      entry.wave = wave || entry.wave;
    }
    // Throttle: broadcast leaderboard at most once per second per lobby
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
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;

    // Mark dead in members and scores
    if (lobby.members[socket.id]) lobby.members[socket.id].dead = true;
    const entry = lobby.scores[socket.id];
    if (entry) {
      entry.dead = true;
      entry.score = Math.max(entry.score, score || 0);
      entry.wave = wave || entry.wave;
    }

    const lb = buildLeaderboard(lobby);
    // Tell entire lobby: a player died (for grave + leaderboard update)
    io.to(lobby.id).emit("playerDied", {
      id: socket.id,
      x: x || 0,
      y: y || 0,
      name: name || meta.name || "Unknown",
      wave: wave || 1,
      score: score || 0,
      leaderboard: lb,
    });
    broadcastLeaderboard(lobby);
  });

  socket.on("startNow", () => {
    const meta = players[socket.id];
    if (!meta || !meta.lobbyId) return;
    const lobby = lobbies[meta.lobbyId];
    if (!lobby) return;
    // Only the host can force-start
    if (lobby.hostId !== socket.id) return;
    lobby.started = true;
    io.to(lobby.id).emit("startMatch", {
      playerStates: Object.values(lobby.members),
    });
    broadcastLobbyList();
  });

  socket.on("disconnect", () => {
    const meta = players[socket.id];
    if (meta && meta.lobbyId) {
      const lobby = lobbies[meta.lobbyId];
      if (lobby) {
        delete lobby.members[socket.id];
        // If host left and lobby has members, assign a new host
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
    }
    delete players[socket.id];
    broadcastLobbyList();
    console.log("disconnect", socket.id, Object.keys(players).length);
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────
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

// ─── Physics tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const lobbyId in lobbies) {
    const lobby = lobbies[lobbyId];
    const list = Object.values(lobby.members).filter((p) => !p.dead);
    for (const p of list) {
      const dx = p.input?.dx || 0;
      const dy = p.input?.dy || 0;
      const speed = p.input?.speed || 2.4;
      p.x = Math.max(-13, Math.min(13, p.x + dx * speed * DT));
      p.y = Math.max(-13, Math.min(13, p.y + dy * speed * DT));

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
    if (list.length > 0) io.to(lobbyId).emit("state", list);
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Multiplayer server listening on http://localhost:" + PORT),
);
