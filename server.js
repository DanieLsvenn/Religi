const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket"], // force WS — polling breaks on Render.com reverse proxy
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "game.html")));

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_LOBBY_PLAYERS = 10;
const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const LOBBY_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes

// World bounds matching the client exactly:
// ARENA_WIDTH=6792, ARENA_HEIGHT=3704, WORLD_SCALE=38
// WORLD_BOUNDS_X = 6792/2/38 ≈ 89,  WORLD_BOUNDS_Y = 3704/2/38 ≈ 48
const WORLD_BOUNDS_X = 89;
const WORLD_BOUNDS_Y = 48;

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
    maxPlayers: l.maxPlayers,
    started: l.started,
    expiresIn: Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000)),
  }));
  io.emit("lobbyList", list);
}

function broadcastMatchTimers() {
  const now = Date.now();

  for (const id in lobbies) {
    const lobby = lobbies[id];

    if (
      !lobby.started ||
      !lobby.matchEndAt
    )
      continue;

    const remaining = Math.max(
      0,
      Math.ceil(
        (lobby.matchEndAt - now) / 1000
      )
    );

    io.to(id).emit(
      "matchTimer",
      remaining
    );

    if (remaining <= 0) {
      lobby.started = false;

      io.to(id).emit("matchEnded");

      broadcastLobbyList();
    }
  }
}

setInterval(broadcastMatchTimers, 500);

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
      maxPlayers: l.maxPlayers,
      started: l.started,
      expiresIn: Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000)),
    }));
    socket.emit("lobbyList", list);
  });

  socket.on("createLobby", ({
    name,
    cls,
    playerName,
    maxPlayers,
    gameTime
  }) => {
    // Clean up any existing lobby this socket is in
    leavePreviousLobby(socket);

    const id = makeLobbyId();
    const lobby = {
      id,
      maxPlayers: maxPlayers || 10,
      gameTime: gameTime || 900,
      name: name || (playerName ? `${playerName}'s Lobby` : "Sacred Arena"),
      hostId: socket.id,
      hostName: playerName || "Host",
      members: {},
      scores: {},
      started: false,
      matchEndAt: null,
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
    socket.emit("lobbyState",
      {
        players: Object.values(lobby.members),
        maxPlayers: lobby.maxPlayers,
        hostId: lobby.hostId
      }
    );
    broadcastLobbyList();
    console.log("Lobby created:", id, "by", p.name);
  });

  socket.on("joinLobby", ({ lobbyId, name, cls, playerName }) => {
    const lobby = lobbies[lobbyId];

    if (!lobby) {
      socket.emit("joinFailed", "Lobby not found.");
      return;
    }

    if (lobby.started) {
      socket.emit(
        "joinFailed",
        "Game already in progress."
      );
      return;
    }

    if (Object.keys(lobby.members).length >= lobby.maxPlayers) {
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
    io.to(lobbyId).emit("lobbyState",
      {
        players: Object.values(lobby.members),
        maxPlayers: lobby.maxPlayers,
        hostId: lobby.hostId
      }
    );
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

  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
  // FIX REJOIN LATER!!!!!
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
    socket.emit("lobbyState",
      {
        players: Object.values(lobby.members),
        maxPlayers: lobby.maxPlayers,
        hostId: lobby.hostId
      }
    );
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
      io.to(lobby.id).emit("lobbyState",
        {
          players: Object.values(lobby.members),
          maxPlayers: lobby.maxPlayers,
          hostId: lobby.hostId
        }
      );
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

    lobby.matchEndAt =
      Date.now() + lobby.gameTime * 1000;

    io.to(lobby.id).emit("startMatch", {
      playerStates: Object.values(lobby.members),
      gameTime: lobby.gameTime,
    });
    broadcastLobbyList();
  });

  socket.on("leaveLobby", () => {
    leavePreviousLobby(socket);

    if (players[socket.id]) {
      delete players[socket.id].lobbyId;
    }

    broadcastLobbyList();
  });

  socket.on("disconnect", () => {
    leavePreviousLobby(socket);

    delete players[socket.id];

    broadcastLobbyList();

    console.log(
      "disconnect",
      socket.id,
      Object.keys(players).length
    );
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

    const remaining = Object.keys(lobby.members);

    if (remaining.length === 0) {
      delete lobbies[meta.lobbyId];
    }
    else if (lobby.hostId === socket.id) {
      lobby.hostId = remaining[0];
      lobby.hostName =
        lobby.members[remaining[0]]?.name || "Host";
    }
    if (lobbies[meta.lobbyId]) {
      io.to(meta.lobbyId).emit("lobbyState",
        {
          players: Object.values(lobby.members),
          maxPlayers: lobby.maxPlayers,
          hostId: lobby.hostId
        }
      );
      broadcastLobbyList();
    }
  }
  socket.leave(meta.lobbyId);
}

// ─── Physics tick ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const lobbyId in lobbies) {
    const lobby = lobbies[lobbyId];
    const allMembers = Object.values(lobby.members);

    for (const p of allMembers) {
      if (p.dead) continue; // dead players don't move, but are still broadcast
      const dx = p.input?.dx || 0;
      const dy = p.input?.dy || 0;
      const speed = p.input?.speed || 2.4;
      // Use world bounds matching the client (was ±13, caused players to freeze)
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

    // Broadcast all members (alive + dead) so renderRemotePlayers always has data.
    // Each entry includes all fields the client needs: id, x, y, cls, name, dead, hp, level.
    if (allMembers.length > 0) {
      const snapshot = allMembers.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        cls: p.cls,
        name: p.name,
        dead: p.dead,
        hp: p.hp,
        level: p.level,
      }));
      io.to(lobbyId).emit("state", snapshot);
    }
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Multiplayer server listening on http://localhost:" + PORT),
);
