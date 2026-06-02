// netlify/functions/game.js
// Handles all game state via Netlify Blobs
// GET  /api/game        → read game state
// POST /api/game        → update game state (body: {action, payload})
// Requires Netlify Identity JWT for write operations

import { getStore } from "@netlify/blobs";

const BLOB_KEY = "wc2026-game";

export default async function handler(req, context) {
  const store = getStore("game");
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  // ── GET: read current game state ─────────────────────
  if (req.method === "GET") {
    try {
      const data = await store.get(BLOB_KEY, { type: "json" });
      return new Response(JSON.stringify(data || null), { status: 200, headers });
    } catch {
      return new Response(JSON.stringify(null), { status: 200, headers });
    }
  }

  // ── POST: mutate game state ───────────────────────────
  if (req.method === "POST") {
    // Verify Netlify Identity JWT
    const user = context.clientContext?.user;
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const body = await req.json();
    const { action, payload } = body;

    let game;
    try {
      game = await store.get(BLOB_KEY, { type: "json" });
    } catch {
      game = null;
    }

    switch (action) {

      // Admin creates the game
      case "CREATE_GAME": {
        if (game) return new Response(JSON.stringify({ error: "Game already exists" }), { status: 409, headers });
        const newGame = {
          ...payload,
          adminEmail: user.email,
          adminSub: user.sub,
          createdAt: new Date().toISOString(),
        };
        await store.setJSON(BLOB_KEY, newGame);
        return new Response(JSON.stringify(newGame), { status: 200, headers });
      }

      // Player claims their slot
      case "CLAIM_SLOT": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers });
        const { playerName } = payload;
        const slot = game.players.find(p => p.name === playerName);
        if (!slot) return new Response(JSON.stringify({ error: "Player not found" }), { status: 404, headers });
        if (slot.email && slot.email !== user.email) return new Response(JSON.stringify({ error: "Slot taken" }), { status: 409, headers });
        slot.email = user.email;
        slot.sub   = user.sub;
        slot.avatar = user.user_metadata?.avatar_url || null;
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers });
      }

      // Player confirms a spin pick
      case "CONFIRM_PICK": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers });
        const { team, phaseIdx, poolKey } = payload;
        // Verify it's this player's turn
        const currentDrawer = game.drawOrder[game.drawPlayerIdx];
        const mySlot = game.players.find(p => p.sub === user.sub);
        if (!mySlot || mySlot.name !== currentDrawer) {
          return new Response(JSON.stringify({ error: "Not your turn" }), { status: 403, headers });
        }
        // Apply pick
        mySlot.teams[phaseIdx] = team;
        game.pools[poolKey] = game.pools[poolKey].filter(t => t.name !== team.name);
        let nextPhase = game.drawPhase + 1;
        let nextIdx   = game.drawPlayerIdx;
        if (nextPhase >= 4) { nextPhase = 0; nextIdx++; mySlot.drawDone = true; }
        game.drawPhase      = nextPhase;
        game.drawPlayerIdx  = nextIdx;
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers });
      }

      // Admin toggles a team's elimination
      case "TOGGLE_ELIM": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers });
        if (user.sub !== game.adminSub) return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers });
        const { teamName } = payload;
        const idx = (game.eliminated || []).indexOf(teamName);
        if (idx >= 0) game.eliminated.splice(idx, 1);
        else { game.eliminated = game.eliminated || []; game.eliminated.push(teamName); }
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers });
      }

      // Store live bracket data (any logged-in user can refresh)
      case "UPDATE_BRACKET": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers });
        game.bracketData  = payload.bracketData;
        game.eliminated   = payload.eliminated || game.eliminated;
        game.lastUpdated  = new Date().toISOString();
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers });
      }

      // Admin resets the game
      case "RESET_GAME": {
        if (user.sub !== game?.adminSub) return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers });
        await store.delete(BLOB_KEY);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
}

export const config = { path: "/api/game" };
