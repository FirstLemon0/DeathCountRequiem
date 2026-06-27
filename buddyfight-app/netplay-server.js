const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = __dirname;
const portArgIndex = process.argv.findIndex((arg) => arg === "--port" || arg === "-p");
const hostArgIndex = process.argv.findIndex((arg) => arg === "--host" || arg === "-h");
const port =
  Number(process.env.PORT) ||
  (portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 4173);
const host = process.env.HOST || (hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : "127.0.0.1");

const rooms = new Map();
const roomTtlMs = 6 * 60 * 60 * 1000;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function randomId(size = 4) {
  return crypto.randomBytes(size).toString("hex").toUpperCase();
}

function createRoom(deckValues = []) {
  let roomId = randomId(3);
  while (rooms.has(roomId)) {
    roomId = randomId(3);
  }
  const room = {
    id: roomId,
    players: [randomId(12), null],
    deckValues,
    snapshot: null,
    pendingChoices: new Map(),
    seq: 0,
    clients: new Set(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(roomId, room);
  return room;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

function roomResponse(room, token) {
  return {
    roomId: room.id,
    token,
    playerIndex: room.players.indexOf(token),
    deckValues: room.deckValues,
    hasSnapshot: Boolean(room.snapshot),
  };
}

function findRoomAndToken(req, parts) {
  const room = rooms.get(parts[2]);
  if (!room) {
    return { error: "room not found" };
  }
  return { room };
}

function playerIndex(room, token) {
  return room.players.indexOf(token);
}

function writeSse(res, message) {
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

function broadcast(room, message) {
  room.updatedAt = Date.now();
  room.seq += 1;
  const envelope = { seq: room.seq, ...message };
  for (const client of room.clients) {
    writeSse(client, envelope);
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, rooms: rooms.size });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readJson(req);
    const room = createRoom(body.deckValues || []);
    sendJson(res, 201, roomResponse(room, room.players[0]));
    return true;
  }

  if (parts[0] !== "api" || parts[1] !== "rooms" || !parts[2]) {
    return false;
  }

  const { room, error } = findRoomAndToken(req, parts);
  if (error) {
    sendJson(res, 404, { error });
    return true;
  }

  if (req.method === "POST" && parts[3] === "join") {
    if (room.players[1]) {
      sendJson(res, 409, { error: "room is full" });
      return true;
    }
    const body = await readJson(req);
    room.players[1] = randomId(12);
    room.updatedAt = Date.now();
    if (Array.isArray(body.deckValues) && body.deckValues[1]) {
      room.deckValues[1] = body.deckValues[1];
    }
    broadcast(room, {
      type: "deck",
      sender: room.players[1],
      deckValues: room.deckValues,
    });
    sendJson(res, 200, roomResponse(room, room.players[1]));
    return true;
  }

  if (req.method === "GET" && parts[3] === "events") {
    const token = url.searchParams.get("token");
    if (playerIndex(room, token) < 0) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    room.clients.add(res);
    room.updatedAt = Date.now();
    writeSse(res, {
      type: "hello",
      seq: room.seq,
      roomId: room.id,
      playerIndex: playerIndex(room, token),
      deckValues: room.deckValues,
      snapshot: room.snapshot,
    });
    req.on("close", () => room.clients.delete(res));
    return true;
  }

  if (req.method === "POST" && parts[3] === "messages") {
    const body = await readJson(req);
    const sender = body.token;
    const seat = playerIndex(room, sender);
    if (seat < 0) {
      sendJson(res, 403, { error: "invalid token" });
      return true;
    }
    if (body.type === "deck") {
      const deckValues = body.payload?.deckValues;
      const player = Number(body.payload?.playerIndex);
      if (player !== seat || !Array.isArray(deckValues)) {
        sendJson(res, 400, { error: "invalid deck update" });
        return true;
      }
      room.deckValues[player] = deckValues[player];
      broadcast(room, {
        type: "deck",
        sender,
        deckValues: room.deckValues,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (body.type === "snapshot") {
      room.snapshot = body.payload?.snapshot || null;
      if (Array.isArray(body.payload?.deckValues)) {
        room.deckValues = body.payload.deckValues;
      }
      broadcast(room, {
        type: "snapshot",
        sender,
        label: body.payload?.label,
        deckValues: room.deckValues,
        snapshot: room.snapshot,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (body.type === "hidden_choice_request") {
      const requestId = String(body.payload?.requestId || "");
      const targetSeat = Number(body.payload?.targetSeat);
      const choices = body.payload?.choices;
      if (
        !requestId ||
        requestId.length > 120 ||
        ![0, 1].includes(targetSeat) ||
        targetSeat === seat ||
        !Array.isArray(choices) ||
        choices.length === 0 ||
        choices.length > 20
      ) {
        sendJson(res, 400, { error: "invalid hidden choice request" });
        return true;
      }
      const choiceKeys = choices.map((choice) => String(choice?.key || ""));
      if (choiceKeys.some((key) => !key || key.length > 120)) {
        sendJson(res, 400, { error: "invalid hidden choice keys" });
        return true;
      }
      room.pendingChoices.set(requestId, { requesterSeat: seat, targetSeat, choiceKeys });
      broadcast(room, {
        type: "hidden_choice_request",
        sender,
        requestId,
        targetSeat,
        title: String(body.payload?.title || "選択"),
        lead: String(body.payload?.lead || ""),
        choices,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (body.type === "hidden_choice_response") {
      const requestId = String(body.payload?.requestId || "");
      const pending = room.pendingChoices.get(requestId);
      if (!pending || pending.targetSeat !== seat) {
        sendJson(res, 400, { error: "invalid hidden choice response" });
        return true;
      }
      const choice = String(body.payload?.choice || "");
      if (!pending.choiceKeys.includes(choice)) {
        sendJson(res, 400, { error: "invalid hidden choice value" });
        return true;
      }
      room.pendingChoices.delete(requestId);
      broadcast(room, {
        type: "hidden_choice_response",
        sender,
        requestId,
        choice,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 400, { error: "unknown message type" });
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  const requestPath = url.pathname === "/" ? "/netplay.html" : decodeURIComponent(url.pathname);
  const filePath = path.resolve(rootDir, `.${requestPath}`);
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await handleApi(req, res, url)) {
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.clients.size === 0 && now - room.updatedAt > roomTtlMs) {
      rooms.delete(roomId);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(port, host, () => {
  console.log(`Buddyfight netplay server: http://${host}:${port}/netplay.html`);
});
