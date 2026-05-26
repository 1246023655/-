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
  type ColorSwapRequest,
  type CreateRoomPayload,
  type GameStatus,
  type JoinPayload,
  type Move,
  type MovePayload,
  type PlayerInfo,
  type RematchRequest,
  type RestartRequest,
  type RoomEvent,
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
  colorSwapRequest: ColorSwapRequest | null;
  rematchRequest: RematchRequest | null;
  restartRequest: RestartRequest | null;
  lastEvent: RoomEvent | null;
  eventCounter: number;
};

type ParticipantChange = {
  action: "joined-player" | "joined-spectator" | "reconnected-player" | "reconnected-spectator";
  color?: Stone;
  name: string;
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
    setRoomEvent(room, `${checked.name} 创建了房间，等待好友加入。`, "info");
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
    const beforeStatus = room.status;
    const change = addOrReconnectParticipant(room, socket, checked.clientId, checked.name);
    refreshRoomStatus(room);
    announceParticipantChange(room, change, beforeStatus);
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
    room.restartRequest = null;

    const winningLine = findWinningLine(room.board, { row, col }, player.color);

    if (winningLine.length) {
      room.winner = player.color;
      room.winningLine = winningLine;
      room.status = "won";
      room.rematchRequest = null;
      room.restartRequest = null;
      setAllPlayersUnready(room);
      setRoomEvent(room, `${player.name} 连成五子，${player.color === "black" ? "黑棋" : "白棋"}获胜。`, "success");
    } else if (isBoardFull(room.board)) {
      room.status = "draw";
      room.rematchRequest = null;
      room.restartRequest = null;
      setAllPlayersUnready(room);
      setRoomEvent(room, "棋盘已满，本局平局。", "info");
    } else {
      room.turn = nextTurn(room.turn);
    }

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("player:choose-color", (color: Stone, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId) {
      reply?.({ ok: false, error: "请先加入房间。" });
      return;
    }

    if (room.status !== "waiting" || room.moveHistory.length > 0) {
      reply?.({ ok: false, error: "开局后不能换颜色。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);
    const targetPlayer = room.players.find((item) => item.color === color);

    if (!player) {
      reply?.({ ok: false, error: "观战者不能选择颜色。" });
      return;
    }

    if (player.color === color) {
      reply?.({ ok: true });
      return;
    }

    if (targetPlayer) {
      reply?.({ ok: false, error: `${color === "black" ? "黑棋" : "白棋"}已经有人选择，可以发起换棋申请。` });
      return;
    }

    player.color = color;
    player.ready = false;
    room.colorSwapRequest = null;
    setRoomEvent(room, `${player.name} 选择了${color === "black" ? "黑棋" : "白棋"}，请双方准备。`, "info");
    refreshRoomStatus(room);
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("player:ready", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId) {
      reply?.({ ok: false, error: "请先加入房间。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "观战者不能准备。" });
      return;
    }

    if (room.status === "playing") {
      reply?.({ ok: false, error: "对局已经开始。" });
      return;
    }

    player.ready = !player.ready;
    const shouldStart =
      player.ready &&
      room.players.length === 2 &&
      room.players.every((item) => item.online && item.ready);
    refreshRoomStatus(room);

    if (shouldStart) {
      setRoomEvent(room, "游戏开始", "success", "game-start");
    } else {
      setRoomEvent(room, `${player.name} ${player.ready ? "已准备" : "取消准备"}。`, "info");
    }

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("color-swap:request", (requestedColor: Stone, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId) {
      reply?.({ ok: false, error: "请先加入房间。" });
      return;
    }

    if (room.status !== "waiting" || room.moveHistory.length > 0) {
      reply?.({ ok: false, error: "开局后不能申请换棋。" });
      return;
    }

    const requester = room.players.find((item) => item.clientId === clientId);
    const target = room.players.find((item) => item.color === requestedColor);

    if (!requester || !target || target.clientId === requester.clientId) {
      reply?.({ ok: false, error: "当前不能申请这个颜色。" });
      return;
    }

    room.colorSwapRequest = {
      id: room.eventCounter + 1,
      fromClientId: requester.clientId,
      toClientId: target.clientId,
      requestedColor,
      fromName: requester.name
    };
    setAllPlayersUnready(room);
    setRoomEvent(
      room,
      `${requester.name} 申请换成${requestedColor === "black" ? "黑棋" : "白棋"}。`,
      "warning",
      "swap-request"
    );
    refreshRoomStatus(room);
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("color-swap:respond", (accepted: boolean, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !room.colorSwapRequest) {
      reply?.({ ok: false, error: "没有可处理的换棋申请。" });
      return;
    }

    const request = room.colorSwapRequest;

    if (request.toClientId !== clientId) {
      reply?.({ ok: false, error: "只有被申请的玩家可以处理。" });
      return;
    }

    const requester = room.players.find((item) => item.clientId === request.fromClientId);
    const target = room.players.find((item) => item.clientId === request.toClientId);

    if (!requester || !target) {
      room.colorSwapRequest = null;
      reply?.({ ok: false, error: "申请已失效。" });
      return;
    }

    if (accepted) {
      const oldColor = requester.color;
      requester.color = request.requestedColor;
      target.color = oldColor;
      setAllPlayersUnready(room);
      setRoomEvent(
        room,
        `${target.name} 同意换棋，${requester.name} 现在执${request.requestedColor === "black" ? "黑棋" : "白棋"}。`,
        "success"
      );
    } else {
      setRoomEvent(room, `${target.name} 拒绝了换棋申请。`, "warning");
    }

    room.colorSwapRequest = null;
    refreshRoomStatus(room);
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:rematch:request", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "只有玩家可以邀请再来一局。" });
      return;
    }

    if (!canHandleRematch(room)) {
      reply?.({ ok: false, error: "当前还不能邀请再来一局。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "没有找到玩家。" });
      return;
    }

    if (room.rematchRequest) {
      if (room.rematchRequest.byClientId === clientId) {
        reply?.({ ok: true });
        return;
      }

      startRematch(room);
      broadcastRoom(room);
      reply?.({ ok: true });
      return;
    }

    player.ready = true;
    room.rematchRequest = {
      byClientId: player.clientId,
      byName: player.name
    };
    setRoomEvent(room, `${player.name} 邀请再来一局。`, "warning", "rematch-request");
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:rematch:respond", (accepted: boolean, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket) || !room.rematchRequest) {
      reply?.({ ok: false, error: "没有可处理的再来一局邀请。" });
      return;
    }

    if (!canHandleRematch(room)) {
      reply?.({ ok: false, error: "当前还不能处理再来一局。" });
      return;
    }

    if (room.rematchRequest.byClientId === clientId) {
      reply?.({ ok: false, error: "需要对手同意再来一局。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "没有找到玩家。" });
      return;
    }

    if (accepted) {
      startRematch(room);
    } else {
      setAllPlayersUnready(room);
      room.rematchRequest = null;
      setRoomEvent(room, `${player.name} 拒绝了再来一局。`, "warning");
    }

    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:rematch:cancel", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "只有玩家可以取消再来一局。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "没有找到玩家。" });
      return;
    }

    player.ready = false;

    if (room.rematchRequest?.byClientId === clientId) {
      room.rematchRequest = null;
      setRoomEvent(room, `${player.name} 取消了再来一局。`, "info");
      broadcastRoom(room);
    }

    reply?.({ ok: true });
  });

  socket.on("game:restart", (reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket)) {
      reply?.({ ok: false, error: "只有玩家可以重开。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "没有找到玩家。" });
      return;
    }

    if (canRequestRestart(room)) {
      if (room.restartRequest) {
        if (room.restartRequest.byClientId === clientId) {
          reply?.({ ok: true });
          return;
        }

        resetRoom(room);
        refreshRoomStatus(room);
        setRoomEvent(room, `${player.name} 同意重开，对局已重开，请双方重新准备。`, "info");
        broadcastRoom(room);
        reply?.({ ok: true });
        return;
      }

      room.restartRequest = {
        byClientId: player.clientId,
        byName: player.name
      };
      setRoomEvent(room, `${player.name} 申请重开。`, "warning", "restart-request");
      broadcastRoom(room);
      reply?.({ ok: true });
      return;
    }

    resetRoom(room);
    refreshRoomStatus(room);
    setRoomEvent(room, "对局已重开，请双方重新准备。", "info");
    broadcastRoom(room);
    reply?.({ ok: true });
  });

  socket.on("game:restart:respond", (accepted: boolean, reply?: (ack: Ack) => void) => {
    const room = getSocketRoom(socket);
    const clientId = socket.data.clientId;

    if (!room || !clientId || !isSocketPlayer(room, socket) || !room.restartRequest) {
      reply?.({ ok: false, error: "没有可处理的重开申请。" });
      return;
    }

    if (room.restartRequest.byClientId === clientId) {
      reply?.({ ok: false, error: "需要对手同意重开。" });
      return;
    }

    const player = room.players.find((item) => item.clientId === clientId);

    if (!player) {
      reply?.({ ok: false, error: "没有找到玩家。" });
      return;
    }

    if (accepted) {
      resetRoom(room);
      refreshRoomStatus(room);
      setRoomEvent(room, `${player.name} 同意重开，对局已重开，请双方重新准备。`, "info");
    } else {
      room.restartRequest = null;
      setRoomEvent(room, `${player.name} 拒绝重开，继续游戏。`, "warning");
    }

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
    room.restartRequest = null;

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
      setRoomEvent(room, "对手同意悔棋，已回退上一步。", "info");
    } else {
      room.undoRequest = null;
      setRoomEvent(room, "对手拒绝了悔棋请求。", "warning");
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
      player.ready = false;
      player.socketId = null;
      room.colorSwapRequest = null;
      room.rematchRequest = null;
      room.restartRequest = null;
      setRoomEvent(room, `${player.name} 已离线，对局暂停。`, "warning");
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
    undoRequest: null,
    colorSwapRequest: null,
    rematchRequest: null,
    restartRequest: null,
    lastEvent: null,
    eventCounter: 0
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
): ParticipantChange {
  const existingPlayer = room.players.find((player) => player.clientId === clientId);

  if (existingPlayer) {
    existingPlayer.name = name;
    existingPlayer.online = true;
    existingPlayer.socketId = socket.id;
    return { action: "reconnected-player", color: existingPlayer.color, name };
  }

  const existingSpectator = room.spectators.get(clientId);

  if (existingSpectator) {
    existingSpectator.name = name;
    existingSpectator.online = true;
    existingSpectator.socketId = socket.id;
    return { action: "reconnected-spectator", name };
  }

  if (room.players.length < 2) {
    const color = room.players.some((player) => player.color === "black") ? "white" : "black";
    room.players.push({
      clientId,
      name,
      color,
      online: true,
      ready: false,
      socketId: socket.id
    });
    return { action: "joined-player", color, name };
  }

  room.spectators.set(clientId, {
    clientId,
    name,
    socketId: socket.id,
    online: true
  });
  return { action: "joined-spectator", name };
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
  room.colorSwapRequest = null;
  room.rematchRequest = null;
  room.restartRequest = null;
  setAllPlayersUnready(room);
}

function startRematch(room: Room): void {
  room.board = createEmptyBoard();
  room.turn = "black";
  room.winner = null;
  room.winningLine = [];
  room.moveHistory = [];
  room.status = "playing";
  room.undoRequest = null;
  room.colorSwapRequest = null;
  room.rematchRequest = null;
  room.restartRequest = null;
  room.players.forEach((player) => {
    player.ready = true;
  });
  setRoomEvent(room, "游戏开始", "success", "game-start");
}

function canHandleRematch(room: Room): boolean {
  return (
    (room.status === "won" || room.status === "draw") &&
    room.players.length === 2 &&
    room.players.every((player) => player.online)
  );
}

function canRequestRestart(room: Room): boolean {
  return (
    room.status === "playing" &&
    room.players.length === 2 &&
    room.players.every((player) => player.online)
  );
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
  room.restartRequest = null;
}

function setAllPlayersUnready(room: Room): void {
  room.players.forEach((player) => {
    player.ready = false;
  });
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

  room.status = room.players.every((player) => player.ready) ? "playing" : "waiting";
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
    colorSwapRequest: room.colorSwapRequest,
    rematchRequest: room.rematchRequest,
    restartRequest: room.restartRequest,
    lastEvent: room.lastEvent,
    message: getRoomMessage(room)
  };
}

function getRoomMessage(room: Room): string {
  if (room.status === "waiting") {
    if (room.players.length === 2) {
      const readyCount = room.players.filter((player) => player.ready).length;
      return `等待双方准备：${readyCount}/2。`;
    }

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

function announceParticipantChange(
  room: Room,
  change: ParticipantChange,
  beforeStatus: GameStatus
): void {
  if (change.action === "joined-player") {
    const colorLabel = change.color === "black" ? "黑棋" : "白棋";

    if (room.status === "playing" && beforeStatus !== "playing") {
      setRoomEvent(room, `${change.name} 已加入成为${colorLabel}，对局开始，黑棋先手。`, "success");
      return;
    }

    setRoomEvent(room, `${change.name} 已加入成为${colorLabel}。`, "info");
    return;
  }

  if (change.action === "joined-spectator") {
    setRoomEvent(room, `${change.name} 进入房间观战。`, "info");
    return;
  }

  if (change.action === "reconnected-player") {
    setRoomEvent(room, `${change.name} 已重新连接。`, room.status === "playing" ? "success" : "info");
    return;
  }

  setRoomEvent(room, `${change.name} 已重新进入观战。`, "info");
}

function setRoomEvent(
  room: Room,
  message: string,
  type: RoomEvent["type"],
  code?: RoomEvent["code"]
): void {
  room.eventCounter += 1;
  room.lastEvent = {
    id: room.eventCounter,
    message,
    type,
    code
  };
}
