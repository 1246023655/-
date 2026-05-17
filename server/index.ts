import express from "express";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  createEmptyBoard,
  findWinningLine,
  isBoardFull,
  isInsideBoard,
  nextTurn
} from "../src/shared/gameRules.js";
import {
  type Ack,
  type Board,
  type CreateRoomPayload,
  type GameStatus,
  type JoinPayload,
  type Move,
  type MovePayload,
  type PlayerInfo,
  type RoomState,
  type Stone,
  type UndoRequest
} from "../src/shared/types.js";

type InternalPlayer = PlayerInfo & {
  socketId: string | null;
};

type SpectatorInfo = {
  clientId: string;
  name: string;
  socketId: string | null;
  online: boolean;
};

type Room = {
  roomId: string;
  board: Board;
  players: InternalPlayer[];
  spectators: Map<string, SpectatorInfo>;
  turn: Stone;
  winner: Stone | null;
  winningLine: RoomState["winningLine"];
  moveHistory: Move[];
  status: GameStatus;
  undoRequest: UndoRequest | null;
};

type SocketData = {
  clientId?: string;
  roomId?: string;
};

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "0.0.0.0";
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map<string, Room>();
const __dirname = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";

app.get("/health", (_, response) => {
  response.status(200).json({
    ok: true,
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

io.on("connection", (socket) => {
  socket.on("room:create", (payload: CreateRoomPayload, reply?: (ack: Ack<{ roomId: string; state: RoomState }>) => void) => {
    const checked = normalizeIdentity(payload);

    if (!checked.ok) {
      reply?.(checked);
      return;
    }

    const room = createRoom();
    rooms.set(room.roomId, room);
    joinSocketRoom(socket, room.roomId, checked.clientId);
    addOrReconnectParticipant(room, socket, checked.clientId, checked.name);
    broadcastRoom(room);
    reply?.({ ok: true, roomId: room.roomId, state: serializeRoom(room) });
  });

  socket.on("room:join", (payload: JoinPayload, reply?: (ack: Ack<{ state: RoomState }>) => void) => {
    const checked = normalizeIdentity(payload);

    if (!checked.ok) {
      reply?.(checked);
      return;
    }

    const room = rooms.get(payload.roomId.trim().toUpperCase());

    if (!room) {
      reply?.({ ok: false, error: "没有找到这个房间。" });
      return;
    }

    joinSocketRoom(socket, room.roomId, checked.clientId);
    addOrReconnectParticipant(room, socket, checked.clientId, checked.name);
    refreshRoomStatus(room);
    broadcastRoom(room);
    reply?.({ ok: true, state: serializeRoom(room) });
  });

  socket.on("game:move", (payload: MovePayload, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId) {
      reply?.({ ok: false, error: "请先加入房间。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "观战者不能落子。" });
      return;
    }

    if (room.status !== "playing") {
      reply?.({ ok: false, error: "当前还不能落子。" });
      return;
    }

    if (player.color !== room.turn) {
      reply?.({ ok: false, error: "还没轮到你。" });
      return;
    }

    const { row, col } = payload;

    if (!Number.isInteger(row) || !Number.isInteger(col) || !isInsideBoard(row, col)) {
      reply?.({ ok: false, error: "落点不在棋盘内。" });
      return;
    }

    if (room.board[row][col]) {
      reply?.({ ok: false, error: "这里已经有棋子了。" });
      return;
    }

    room.board[row][col] = player.color;
    const move: Move = {
      row,
      col,
      color: player.color,
      clientId,
      moveNumber: room.moveHistory.length + 1,
      playedAt: Date.now()
    };

    room.moveHistory.push(move);
    room.undoRequest = null;

    const winningLine = findWinningLine(room.board, { row, col }, player.color);

    if (winningLine.length) {
      room.winner = player.color;
      room.winningLine = winningLine;
      room.status = "won";
    } else if (isBoardFull(room.board)) {
      room.status = "draw";
    } else {
      room.turn = nextTurn(room.turn);
    }

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:restart", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);

    if (!room || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "只有玩家可以重开。" });
      return;
    }

    resetRoom(room);
    refreshRoomStatus(room);
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:undo:request", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "只有玩家可以请求悔棋。" });
      return;
    }

    const lastMove = room.moveHistory.at(-1);

    if (!lastMove || room.status !== "playing") {
      reply?.({ ok: false, error: "现在不能悔棋。" });
      return;
    }

    room.undoRequest = {
      byClientId: clientId,
      byColor: room.players.find((player) => player.clientId === clientId)?.color ?? "black",
      moveNumber: lastMove.moveNumber
    };

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:undo:respond", (accepted: boolean, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !room.undoRequest || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "没有可处理的悔棋请求。" });
      return;
    }

    if (room.undoRequest.byClientId === clientId) {
      reply?.({ ok: false, error: "需要对手同意悔棋。" });
      return;
    }

    if (accepted) {
      undoLastMove(room);
    } else {
      room.undoRequest = null;
    }

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = getSocketRoom(socket);

    if (!room || !socket.data.clientId) {
      return;
    }

    const player = room.players.find((item) => item.clientId === socket.data.clientId);

    if (player) {
      player.online = false;
      player.socketId = null;
    } else {
      const spectator = room.spectators.get(socket.data.clientId);

      if (spectator) {
        spectator.online = false;
        spectator.socketId = null;
      }
    }

    refreshRoomStatus(room);
    broadcastRoom(room);
  });
});

if (isProduction) {
  const distPath = join(__dirname, "..", "..", "dist");
  app.use(express.static(distPath));
  app.use((_, response) => {
    response.sendFile(join(distPath, "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    appType: "spa",
    server: {
      middlewareMode: true,
      host: HOST
    }
  });

  app.use(vite.middlewares);
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Gomoku LAN server running at http://localhost:${PORT}`);
  console.log(`Share on your LAN with http://<your-lan-ip>:${PORT}`);
});

function createRoom(): Room {
  return {
    roomId: createRoomId(),
    board: createEmptyBoard(),
    players: [],
    spectators: new Map(),
    turn: "black",
    winner: null,
    winningLine: [],
    moveHistory: [],
    status: "waiting",
    undoRequest: null
  };
}

function createRoomId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";

  do {
    id = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(id));

  return id;
}

function normalizeIdentity<T extends { clientId?: string; name?: string }>(
  payload: T | undefined
): (T & { ok: true; clientId: string; name: string }) | { ok: false; error: string } {
  const clientId = payload?.clientId?.trim();

  if (!clientId) {
    return { ok: false, error: "缺少玩家身份。" };
  }

  return {
    ...payload,
    ok: true,
    clientId,
    name: payload?.name?.trim().slice(0, 16) || "棋手"
  } as T & { ok: true; clientId: string; name: string };
}

function joinSocketRoom(socket: Socket, roomId: string, clientId: string): void {
  if (socket.data.roomId && socket.data.roomId !== roomId) {
    socket.leave(socket.data.roomId);
  }

  socket.data.clientId = clientId;
  socket.data.roomId = roomId;
  socket.join(roomId);
}

function addOrReconnectParticipant(
  room: Room,
  socket: Socket,
  clientId: string,
  name: string
): void {
  const existingPlayer = room.players.find((player) => player.clientId === clientId);

  if (existingPlayer) {
    existingPlayer.name = name;
    existingPlayer.online = true;
    existingPlayer.socketId = socket.id;
    return;
  }

  const existingSpectator = room.spectators.get(clientId);

  if (existingSpectator) {
    existingSpectator.name = name;
    existingSpectator.online = true;
    existingSpectator.socketId = socket.id;
    return;
  }

  if (room.players.length < 2) {
    room.players.push({
      clientId,
      name,
      color: room.players.some((player) => player.color === "black") ? "white" : "black",
      online: true,
      socketId: socket.id
    });
    return;
  }

  room.spectators.set(clientId, {
    clientId,
    name,
    socketId: socket.id,
    online: true
  });
}

function getSocketRoom(socket: Socket): Room | undefined {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : undefined;
}

function isSocketPlayer(room: Room, socket: Socket): boolean {
  return room.players.some((player) => player.clientId === socket.data.clientId);
}

function resetRoom(room: Room): void {
  room.board = createEmptyBoard();
  room.turn = "black";
  room.winner = null;
  room.winningLine = [];
  room.moveHistory = [];
  room.status = "waiting";
  room.undoRequest = null;
}

function undoLastMove(room: Room): void {
  const move = room.moveHistory.pop();

  if (!move) {
    room.undoRequest = null;
    return;
  }

  room.board[move.row][move.col] = null;
  room.turn = move.color;
  room.winner = null;
  room.winningLine = [];
  room.status = "playing";
  room.undoRequest = null;
}

function refreshRoomStatus(room: Room): void {
  if (room.status === "won" || room.status === "draw") {
    return;
  }

  if (room.players.length < 2) {
    room.status = "waiting";
    return;
  }

  if (room.players.some((player) => !player.online)) {
    room.status = "paused";
    return;
  }

  room.status = "playing";
}

function serializeRoom(room: Room): RoomState {
  return {
    roomId: room.roomId,
    board: room.board,
    players: room.players.map(({ socketId: _socketId, ...player }) => player),
    spectators: Array.from(room.spectators.values()).filter((spectator) => spectator.online).length,
    turn: room.turn,
    winner: room.winner,
    winningLine: room.winningLine,
    moveHistory: room.moveHistory,
    status: room.status,
    undoRequest: room.undoRequest,
    message: getRoomMessage(room)
  };
}

function getRoomMessage(room: Room): string {
  if (room.status === "waiting") {
    return "等待第二位玩家加入。";
  }

  if (room.status === "paused") {
    return "有玩家离线，对局已暂停。";
  }

  if (room.status === "won") {
    return `${room.winner === "black" ? "黑棋" : "白棋"}获胜。`;
  }

  if (room.status === "draw") {
    return "棋盘已满，平局。";
  }

  return `轮到${room.turn === "black" ? "黑棋" : "白棋"}。`;
}

function broadcastRoom(room: Room): void {
  io.to(room.roomId).emit("game:state", serializeRoom(room));
}
