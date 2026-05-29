const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Serve static files from this folder (game files)
app.use(express.static(__dirname));

// Serve the main game at root for convenience
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});

const MAX_PLAYERS = 20;
const TICK_RATE = 20; // Hz
const DT = 1 / TICK_RATE;

const players = {}; // socketId -> player

io.on("connection", (socket) => {
  console.log("connect", socket.id);

  socket.on("join", ({ name, cls }) => {
    const count = Object.keys(players).length;
    if (count >= MAX_PLAYERS) {
      socket.emit(
        "joinFailed",
        "Lobby is full (max " + MAX_PLAYERS + " players).",
      );
      return;
    }
    const p = {
      id: socket.id,
      name: name || "Player" + Math.floor(Math.random() * 1000),
      cls: cls || "priest",
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      hp: 100,
      level: 1,
      input: { dx: 0, dy: 0, speed: 2.4 },
      lastActive: Date.now(),
      _idleCounter: 0,
    };
    players[socket.id] = p;
    io.emit("lobbyState", Object.values(players));
    console.log("player joined:", p.name, Object.keys(players).length);
  });

  socket.on("input", (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.input = {
      dx: Number(data.dx) || 0,
      dy: Number(data.dy) || 0,
      speed: Number(data.speed) || p.input.speed || 2.4,
    };
    p.lastActive = Date.now();
  });

  // Relay projectile events from one client to all others
  socket.on("fireProjectile", (proj) => {
    if (!proj) return;
    const payload = Object.assign({}, proj, { ownerId: socket.id });
    socket.broadcast.emit("projectile", payload);
  });

  // Relay generic ability events (visuals/effects) to other clients
  socket.on("ability", (data) => {
    if (!data) return;
    const payload = Object.assign({}, data, { ownerId: socket.id });
    socket.broadcast.emit("ability", payload);
  });

  socket.on("startNow", () => {
    // Broadcast a start match event with current player list
    io.emit("startMatch", { playerStates: Object.values(players) });
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("lobbyState", Object.values(players));
    console.log("disconnect", socket.id, Object.keys(players).length);
  });
});

// Server physics loop: update player positions and broadcast snapshots
setInterval(() => {
  const list = Object.values(players);
  for (const p of list) {
    const dx = p.input.dx || 0;
    const dy = p.input.dy || 0;
    const speed = p.input.speed || 2.4;
    p.x += dx * speed * DT;
    p.y += dy * speed * DT;
    // clamp to arena bounds roughly matching client
    p.x = Math.max(-13, Math.min(13, p.x));
    p.y = Math.max(-13, Math.min(13, p.y));
  }

  // Simple server-side fallback: if a client is idle (backgrounded), simulate occasional auto-fire so other players still see attacks
  const now = Date.now();
  for (const p of list) {
    const idleMs = now - (p.lastActive || 0);
    if (idleMs > 1200) {
      p._idleCounter = (p._idleCounter || 0) + DT;
      if (p._idleCounter >= 0.8) {
        p._idleCounter = 0;
        // spawn a simple projectile in a random direction
        const angle = Math.random() * Math.PI * 2;
        const vx = Math.cos(angle) * 8;
        const vy = Math.sin(angle) * 8;
        const payload = {
          x: p.x,
          y: p.y,
          dx: vx,
          dz: vy,
          damage: 12,
          color: "#ffd866",
          type: "proj",
          sourceAbility: "autofire",
          ownerId: p.id,
        };
        io.emit("projectile", payload);
      }
    } else {
      p._idleCounter = 0;
    }
  }
  if (list.length) io.emit("state", list);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log("Multiplayer server listening on http://localhost:" + PORT),
);
