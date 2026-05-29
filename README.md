# Sacred Survivors — Developer Documentation

## Overview
Sacred Survivors is a web-based pixel-art multiplayer roguelike survival game inspired by Vampire Survivors. Built with **Three.js**, it uses `InstancedMesh` (a Three.js implementation on top of `InstancedBufferGeometry`) for rendering hundreds of enemies and particles at 60fps.

---

## Architecture

```
index.html (single-file prototype)
├── DATA layer          — JSON-like JS objects (CLASSES, ABILITIES, TRIVIA, ENEMY_TYPES)
├── THREE.JS layer      — Scene, camera, renderer, instanced meshes
├── Game State (GS)     — Central mutable state object
├── Player/Bot system   — Player object + bot AI
├── Ability system      — Passive/active effects per-class
├── Wave system         — Timed enemy spawner
├── Trivia system       — Per-tradition question banks
└── UI layer            — Vanilla HTML/CSS screens, HUD, modals
```

---

## Adding New Content

### New Character Class

Add to the `CLASSES` array:
```js
{
  id: 'taoist',
  name: 'Daoshi',
  religion: 'Taoism',
  icon: '☯',
  color: '#aaffaa',
  desc: 'Flows like water. Harmony and balance.',
  hp: 100,
  speed: 2.5,
  startAbility: 'wu_wei',
  abilityPool: ['wu_wei', 'water_flow', ...],
  colorHex: 0xaaffaa
}
```

Then add trivia questions to `TRIVIA.taoism = [...]` and abilities to `ABILITIES`.

---

### New Ability

Add to the `ABILITIES` object:
```js
wu_wei: {
  name: 'Wu Wei',
  icon: '☯',
  desc: 'Effortless action — dodge attacks passively',
  color: '#aaffaa',
  type: 'buff',         // aura | heal | shield | orbit | slow | buff | beam | proj | wave | spin | totem | companion
  passive: true,
  dodgeChance: 0.15
}
```
Then handle the effect in `updateAbilityEffects()`.

---

### New Enemy Type

Add to `ENEMY_TYPES`:
```js
{
  id: 'lich',
  name: 'Lich',
  hp: 500,
  spd: 0.8,
  dmg: 40,
  xp: 60,
  color: 0x8800aa,
  size: 1.0
}
```

---

### New Trivia Questions

Add to the corresponding tradition array in `TRIVIA`:
```js
{
  q: 'Your question here?',
  a: ['Correct answer', 'Wrong A', 'Wrong B', 'Wrong C'],
  correct: 0   // index of correct answer
}
```

---

## Performance — Instanced Rendering

Three.js `InstancedMesh` wraps `InstancedBufferGeometry` and allows rendering thousands of objects in a single draw call.

| Mesh | Max Count | Usage |
|------|-----------|-------|
| `enemyInstancedMesh` | 500 | All living enemies |
| `particleInstancedMesh` | 1000 | Explosion/death particles |
| `botInstancedMesh` | ~20 | Other players |

Positions and colors are updated each frame via `setMatrixAt()` / `setColorAt()`.

---

## Multiplayer Architecture (Production Roadmap)

Current prototype simulates bots client-side. For real multiplayer:

1. **Server**: Node.js + Socket.IO or Colyseus  
2. **State sync**: Server authoritative — broadcast positions at 20Hz  
3. **Rooms**: Colyseus rooms handle lobby (max 20 players)  
4. **Schema** (Colyseus example):
```ts
class GameRoom extends Room {
  maxClients = 20;
  onCreate() { this.setSimulationInterval((dt) => this.update(dt), 50); }
}
```

---

## Folder Structure (for full build)

```
/
├── index.html
├── src/
│   ├── game/
│   │   ├── Player.js
│   │   ├── Enemy.js
│   │   ├── Ability.js
│   │   └── WaveManager.js
│   ├── data/
│   │   ├── classes.json
│   │   ├── abilities.json
│   │   ├── enemies.json
│   │   └── trivia/
│   │       ├── christianity.json
│   │       ├── buddhism.json
│   │       ├── islam.json
│   │       ├── hinduism.json
│   │       └── shinto.json
│   ├── ui/
│   │   ├── HUD.js
│   │   ├── LevelUpModal.js
│   │   └── LobbyScreen.js
│   └── net/
│       ├── LobbyClient.js
│       └── GameClient.js
├── assets/
│   ├── sprites/     — 16x16 pixel art spritesheets
│   ├── audio/       — .ogg sound effects and music
│   └── maps/        — Tiled .json arena layouts
└── server/
    ├── GameRoom.ts  — Colyseus room
    └── index.ts
```

---

## Controls

| Key | Action |
|-----|--------|
| WASD / Arrow Keys | Move |
| (Abilities fire automatically) | — |

---

## Educational Philosophy

All trivia questions focus on:
- **Historical facts** (events, figures, dates)
- **Cultural practices** (festivals, rituals, customs)
- **Textual traditions** (scriptures, concepts)
- **Ethics & values** (core teachings)

No question promotes one religion over another or makes theological truth claims. The system is designed to be **curiosity-first** and **respectful across all traditions**.
