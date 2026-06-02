// netlify/functions/game.js
import { getStore } from "@netlify/blobs";

const BLOB_KEY = "wc2026-game";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

// Verify the Netlify Identity JWT and return user info
function getUser(req, context) {
  console.log("[auth] clientContext keys:", Object.keys(context?.clientContext || {}));
  console.log("[auth] identity url:", context?.clientContext?.identity?.url);
  console.log("[auth] user present:", !!context?.clientContext?.user);
  
  const user = context?.clientContext?.user;
  if (user) {
    console.log("[auth] user email:", user.email, "sub:", user.sub);
    return user;
  }

  // If no user in context, check the Authorization header directly
  // This can happen with certain Netlify plan tiers
  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  console.log("[auth] Authorization header present:", !!authHeader);
  
  return null;
}

export default async function handler(req, context) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const store = getStore("game");

  // ── GET ───────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const data = await store.get(BLOB_KEY, { type: "json" }).catch(() => null);
      return new Response(JSON.stringify(data || null), { status: 200, headers: cors });
    } catch(e) {
      return new Response(JSON.stringify(null), { status: 200, headers: cors });
    }
  }

  // ── POST ──────────────────────────────────────────────
  if (req.method === "POST") {
    const user = getUser(req, context);
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized — Bearer token required" }),
        { status: 401, headers: cors }
      );
    }

    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

    const { action, payload } = body;
    let game = await store.get(BLOB_KEY, { type: "json" }).catch(() => null);

    switch (action) {

      case "CREATE_GAME": {
        if (game) return new Response(JSON.stringify({ error: "Game already exists" }), { status: 409, headers: cors });
        const newGame = {
          ...payload,
          adminEmail: user.email,
          adminSub: user.sub,
          createdAt: new Date().toISOString(),
        };
        await store.setJSON(BLOB_KEY, newGame);
        return new Response(JSON.stringify(newGame), { status: 200, headers: cors });
      }

      case "CLAIM_SLOT": {
        if (!game) return new Response(JSON.stringify({ error: "No game found" }), { status: 404, headers: cors });
        const slot = game.players.find(p => p.name === payload.playerName);
        if (!slot) return new Response(JSON.stringify({ error: "Player not found" }), { status: 404, headers: cors });
        if (slot.sub && slot.sub !== user.sub) return new Response(JSON.stringify({ error: "Slot already taken" }), { status: 409, headers: cors });
        slot.sub   = user.sub;
        slot.email = user.email;
        slot.avatar = user.user_metadata?.avatar_url || null;
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers: cors });
      }

      case "CONFIRM_PICK": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers: cors });
        const currentDrawer = game.drawOrder[game.drawPlayerIdx];
        const mySlot = game.players.find(p => p.sub === user.sub);
        if (!mySlot || mySlot.name !== currentDrawer) {
          return new Response(JSON.stringify({ error: "Not your turn" }), { status: 403, headers: cors });
        }
        const { team, phaseIdx, poolKey } = payload;
        mySlot.teams[phaseIdx] = team;
        game.pools[poolKey] = (game.pools[poolKey] || []).filter(t => t.name !== team.name);
        const nextPhase = game.drawPhase + 1;
        if (nextPhase >= 4) {
          game.drawPhase = 0;
          game.drawPlayerIdx++;
          mySlot.drawDone = true;
        } else {
          game.drawPhase = nextPhase;
        }
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers: cors });
      }

      case "TOGGLE_ELIM": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers: cors });
        if (user.sub !== game.adminSub) return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: cors });
        const { teamName } = payload;
        game.eliminated = game.eliminated || [];
        const idx = game.eliminated.indexOf(teamName);
        if (idx >= 0) game.eliminated.splice(idx, 1);
        else game.eliminated.push(teamName);
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers: cors });
      }

      case "UPDATE_BRACKET": {
        if (!game) return new Response(JSON.stringify({ error: "No game" }), { status: 404, headers: cors });
        game.bracketData  = payload.bracketData;
        game.eliminated   = payload.eliminated || game.eliminated;
        game.lastUpdated  = new Date().toISOString();
        await store.setJSON(BLOB_KEY, game);
        return new Response(JSON.stringify(game), { status: 200, headers: cors });
      }

      case "RESET_GAME": {
        if (!game || user.sub !== game.adminSub) return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: cors });
        await store.delete(BLOB_KEY);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
      }

      default:
        return new Response(JSON.stringify({ error: "Unknown action: " + action }), { status: 400, headers: cors });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
}

export const config = { path: "/api/game" };
