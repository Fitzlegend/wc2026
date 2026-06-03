import { getStore } from "@netlify/blobs";

const BLOB_KEY = "wc2026-game";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

async function getGame(store) {
  try { return await store.get(BLOB_KEY, { type: "json" }); }
  catch { return null; }
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const store = getStore("game");

    // ── GET: read game state ───────────────────────────
    if (req.method === "GET") {
      const game = await getGame(store);
      // Strip PINs before sending to client
      if (game) {
        const safe = {
          ...game,
          players: game.players.map(({ pin, ...rest }) => rest),
        };
        return json(safe);
      }
      return json(null);
    }

    // ── POST: all mutations ────────────────────────────
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch { return json({ error: "Invalid JSON" }, 400); }

      const { action, payload } = body || {};
      let game = await getGame(store);

      switch (action) {

        // Admin creates the game with player names + PINs
        case "CREATE_GAME": {
          if (game) return json({ error: "Game already exists" }, 409);
          const newGame = {
            players: payload.players, // [{name, pin, drawDone, teams}]
            drawOrder: payload.drawOrder,
            drawPlayerIdx: 0,
            drawPhase: 0,
            pools: payload.pools,
            eliminated: [],
            bracketData: null,
            lastUpdated: null,
            adminName: payload.adminName,
            createdAt: new Date().toISOString(),
          };
          await store.setJSON(BLOB_KEY, newGame);
          // Return without PINs
          const { players, ...rest } = newGame;
          return json({ ...rest, players: players.map(({ pin, ...p }) => p) });
        }

        // Player logs in with name + PIN
        case "LOGIN": {
          if (!game) return json({ error: "No game found" }, 404);
          const { name, pin } = payload;
          const player = game.players.find(p =>
            p.name.toLowerCase() === name.toLowerCase() && p.pin === pin
          );
          if (!player) return json({ error: "Wrong name or PIN" }, 401);
          // Return full game state (minus all PINs) + confirmation of who logged in
          return json({
            ok: true,
            playerName: player.name,
            isAdmin: player.name === game.adminName,
            game: { ...game, players: game.players.map(({ pin, ...p }) => p) },
          });
        }

        // Player confirms their spin pick
        case "CONFIRM_PICK": {
          if (!game) return json({ error: "No game" }, 404);
          const { name, pin, team, phaseIdx, poolKey } = payload;
          // Verify PIN
          const mySlot = game.players.find(p => p.name === name && p.pin === pin);
          if (!mySlot) return json({ error: "Invalid credentials" }, 401);
          // Verify it's their turn
          if (game.drawOrder[game.drawPlayerIdx] !== name) return json({ error: "Not your turn" }, 403);

          mySlot.teams[phaseIdx] = team;
          game.pools[poolKey] = (game.pools[poolKey] || []).filter(t => t.name !== team.name);
          if (game.drawPhase + 1 >= 4) {
            game.drawPhase = 0;
            game.drawPlayerIdx++;
            mySlot.drawDone = true;
          } else {
            game.drawPhase++;
          }
          await store.setJSON(BLOB_KEY, game);
          return json({ ...game, players: game.players.map(({ pin, ...p }) => p) });
        }

        // Admin toggles a team out/in
        case "TOGGLE_ELIM": {
          if (!game) return json({ error: "No game" }, 404);
          const { name, pin, teamName } = payload;
          const admin = game.players.find(p => p.name === name && p.pin === pin && p.name === game.adminName);
          if (!admin) return json({ error: "Admin only" }, 403);
          game.eliminated = game.eliminated || [];
          const idx = game.eliminated.indexOf(teamName);
          if (idx >= 0) game.eliminated.splice(idx, 1);
          else game.eliminated.push(teamName);
          await store.setJSON(BLOB_KEY, game);
          return json({ ...game, players: game.players.map(({ pin, ...p }) => p) });
        }

        // Anyone can trigger a live bracket update
        case "UPDATE_BRACKET": {
          if (!game) return json({ error: "No game" }, 404);
          game.bracketData = payload.bracketData;
          game.eliminated  = payload.eliminated || game.eliminated;
          game.lastUpdated = new Date().toISOString();
          await store.setJSON(BLOB_KEY, game);
          return json({ ...game, players: game.players.map(({ pin, ...p }) => p) });
        }

        // Admin resets game
        case "RESET_GAME": {
          if (!game) return json({ error: "No game" }, 404);
          const { name, pin } = payload;
          const admin = game.players.find(p => p.name === name && p.pin === pin && p.name === game.adminName);
          if (!admin) return json({ error: "Admin only" }, 403);
          await store.delete(BLOB_KEY);
          return json({ ok: true });
        }

        default:
          return json({ error: "Unknown action: " + action }, 400);
      }
    }

    return json({ error: "Method not allowed" }, 405);

  } catch(e) {
    console.error("[game] error:", e);
    return json({ error: "Server error: " + e.message }, 500);
  }
}
