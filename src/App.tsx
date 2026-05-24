import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import {
  createEmptyBoard,
  findWinningLine,
  isBoardFull,
  nextTurn
} from "./shared/gameRules";
import { BOARD_SIZE, type Ack, type Position, type RoomState, type Stone } from "./shared/types";

const socket = io();
const CLIENT_ID_KEY = "gomoku.clientId";
const PLAYER_NAME_KEY = "gomoku.playerName";
const BOARD_EDGE_PERCENT = 3.4;
const BOARD_SPAN_PERCENT = 93.2;
const COORDINATE_LABELS = "ABCDEFGHIJKLMNO".split("");
const STAR_POINTS: Position[] = [
  { row: 3, col: 3 },
  { row: 3, col: 7 },
  { row: 3, col: 11 },
  { row: 7, col: 3 },
  { row: 7, col: 7 },
  { row: 7, col: 11 },
  { row: 11, col: 3 },
  { row: 11, col: 7 },
  { row: 11, col: 11 }
];
type GameMode = "online" | "local" | "ai";

type LocalMove = Position & {
  color: Stone;
  moveNumber: number;
};

type LocalGame = {
  board: ReturnType<typeof createEmptyBoard>;
  turn: Stone;
  winner: Stone | null;
  winningLine: Position[];
  moveHistory: LocalMove[];
  status: "playing" | "won" | "draw";
  message: string;
};

function getClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function getInitialName(): string {
  return localStorage.getItem(PLAYER_NAME_KEY) || `棋手${Math.floor(Math.random() * 90 + 10)}`;
}

function createLocalGame(mode: GameMode): LocalGame {
  return {
    board: createEmptyBoard(),
    turn: "black",
    winner: null,
    winningLine: [],
    moveHistory: [],
    status: "playing",
    message: mode === "ai" ? "你执黑棋，先手。" : "轮到黑棋。"
  };
}

export default function App() {
  const [clientId] = useState(getClientId);
  const [playerName, setPlayerName] = useState(getInitialName);
  const [roomInput, setRoomInput] = useState(() => getRoomFromUrl());
  const [state, setState] = useState<RoomState | null>(null);
  const [mode, setMode] = useState<GameMode>(() => (getRoomFromUrl() ? "online" : "local"));
  const [localGame, setLocalGame] = useState<LocalGame>(() => createLocalGame(getRoomFromUrl() ? "online" : "local"));
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(socket.connected);
  const [copied, setCopied] = useState(false);

  const isOnlineMode = mode === "online";
  const myPlayer = state?.players.find((player) => player.clientId === clientId) ?? null;
  const opponent = state?.players.find((player) => player.clientId !== clientId) ?? null;
  const roleLabel = myPlayer
    ? `${stoneLabel(myPlayer.color)}玩家`
    : state && isOnlineMode
      ? "观战"
      : mode === "ai"
        ? "你执黑棋"
        : "本地双人";
  const canMove = isOnlineMode
    ? Boolean(myPlayer && state?.status === "playing" && state.turn === myPlayer.color)
    : localGame.status === "playing" && (mode === "local" || localGame.turn === "black");
  const shareUrl = state
    ? `${window.location.origin}${window.location.pathname}?room=${state.roomId}`
    : "";
  const board = isOnlineMode ? state?.board ?? createEmptyBoard() : localGame.board;
  const currentMessage = isOnlineMode
    ? state?.message ?? "创建或加入房间开始。"
    : localGame.message;
  const currentStatusLabel = isOnlineMode
    ? state?.roomId
      ? `房间 ${state.roomId}`
      : "联机房间"
    : mode === "ai"
      ? "人机模式 · 简单"
      : "个人模式";
  const winningSet = useMemo(() => {
    const winningLine = isOnlineMode ? state?.winningLine : localGame.winningLine;

    return new Set(winningLine?.map((item) => `${item.row}-${item.col}`) ?? []);
  }, [isOnlineMode, localGame.winningLine, state?.winningLine]);
  const lastMove = isOnlineMode ? state?.moveHistory.at(-1) : localGame.moveHistory.at(-1);

  useEffect(() => {
    localStorage.setItem(PLAYER_NAME_KEY, playerName);
  }, [playerName]);

  useEffect(() => {
    if (mode !== "ai" || localGame.status !== "playing" || localGame.turn !== "white") {
      return;
    }

    const timer = window.setTimeout(() => {
      const move = chooseSimpleAiMove(localGame.board);

      if (move) {
        playLocalMove(move, "white");
      }
    }, 420);

    return () => window.clearTimeout(timer);
  }, [localGame.board, localGame.status, localGame.turn, mode]);

  useEffect(() => {
    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    const handleState = (nextState: RoomState) => {
      setState(nextState);
      setRoomInput(nextState.roomId);
      setNotice("");
      window.history.replaceState(null, "", `?room=${nextState.roomId}`);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("game:state", handleState);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("game:state", handleState);
    };
  }, []);

  useEffect(() => {
    const roomId = getRoomFromUrl();

    if (!roomId) {
      return;
    }

    const joinWhenConnected = () => joinRoom(roomId);

    if (socket.connected) {
      joinWhenConnected();
    } else {
      socket.once("connect", joinWhenConnected);
    }

    return () => {
      socket.off("connect", joinWhenConnected);
    };
  }, []);

  function changeMode(nextMode: GameMode) {
    setMode(nextMode);
    setNotice("");

    if (nextMode === "online") {
      return;
    }

    setState(null);
    setLocalGame(createLocalGame(nextMode));
    window.history.replaceState(null, "", window.location.pathname);
  }

  function createRoom() {
    setMode("online");
    setNotice("");
    socket.emit(
      "room:create",
      { clientId, name: playerName },
      (ack: Ack<{ roomId: string; state: RoomState }>) => {
        if (!ack.ok) {
          setNotice(ack.error);
          return;
        }

        setState(ack.state);
        setRoomInput(ack.roomId);
        window.history.replaceState(null, "", `?room=${ack.roomId}`);
      }
    );
  }

  function joinRoom(roomId = roomInput) {
    setMode("online");
    const normalizedRoomId = roomId.trim().toUpperCase();

    if (!normalizedRoomId) {
      setNotice("请输入房间号。");
      return;
    }

    setNotice("");
    socket.emit(
      "room:join",
      { roomId: normalizedRoomId, clientId, name: playerName },
      (ack: Ack<{ state: RoomState }>) => {
        if (!ack.ok) {
          setNotice(ack.error);
          return;
        }

        setState(ack.state);
        setRoomInput(ack.state.roomId);
        window.history.replaceState(null, "", `?room=${ack.state.roomId}`);
      }
    );
  }

  function makeMove(position: Position) {
    if (!canMove) {
      return;
    }

    if (!isOnlineMode) {
      playLocalMove(position, mode === "ai" ? "black" : localGame.turn);
      return;
    }

    socket.emit("game:move", position, (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  function restartGame() {
    if (!isOnlineMode) {
      setLocalGame(createLocalGame(mode));
      setNotice("");
      return;
    }

    socket.emit("game:restart", (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  function requestUndo() {
    if (!isOnlineMode) {
      setLocalGame((current) => undoLocalMove(current, mode));
      setNotice("");
      return;
    }

    socket.emit("game:undo:request", (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  function respondUndo(accepted: boolean) {
    socket.emit("game:undo:respond", accepted, (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function playLocalMove(position: Position, color: Stone) {
    setLocalGame((current) => applyLocalMove(current, position, color, mode));
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="房间操作">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>五子棋</h1>
            <p>{isOnlineMode ? (connected ? "联机已连接" : "联机连接中") : "本地对局"}</p>
          </div>
        </div>

        <div className="room-tools">
          <div className="mode-tabs" aria-label="模式选择">
            <button
              type="button"
              className={mode === "online" ? "is-selected" : "secondary"}
              onClick={() => changeMode("online")}
            >
              联机
            </button>
            <button
              type="button"
              className={mode === "local" ? "is-selected" : "secondary"}
              onClick={() => changeMode("local")}
            >
              个人
            </button>
            <button
              type="button"
              className={mode === "ai" ? "is-selected" : "secondary"}
              onClick={() => changeMode("ai")}
            >
              人机
            </button>
          </div>
          <label>
            昵称
            <input
              value={playerName}
              maxLength={16}
              onChange={(event) => setPlayerName(event.target.value)}
            />
          </label>
          <label>
            房间
            <input
              value={roomInput}
              maxLength={8}
              disabled={!isOnlineMode}
              onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  joinRoom();
                }
              }}
            />
          </label>
          <button type="button" onClick={createRoom}>
            创建房间
          </button>
          <button type="button" className="secondary" onClick={() => joinRoom()}>
            加入
          </button>
        </div>
      </section>

      <section className="game-layout">
        <aside className="panel" aria-label="对局状态">
          <div className="status-card">
            <span className="eyebrow">{currentStatusLabel}</span>
            <strong>{currentMessage}</strong>
            <p>{notice || `你的身份：${roleLabel}`}</p>
          </div>

          {isOnlineMode ? (
            <div className="players">
              <PlayerRow color="black" state={state} clientId={clientId} />
              <PlayerRow color="white" state={state} clientId={clientId} />
              <div className="spectator-row">
                <span>观战</span>
                <strong>{state?.spectators ?? 0}</strong>
              </div>
            </div>
          ) : (
            <div className="players">
              <LocalPlayerRow
                color="black"
                name={mode === "ai" ? "你" : "黑棋"}
                isTurn={localGame.status === "playing" && localGame.turn === "black"}
              />
              <LocalPlayerRow
                color="white"
                name={mode === "ai" ? "简单电脑" : "白棋"}
                isTurn={localGame.status === "playing" && localGame.turn === "white"}
              />
            </div>
          )}

          {state && isOnlineMode && (
            <div className="share-box">
              <span>分享链接</span>
              <button type="button" className="link-button" onClick={copyShareUrl}>
                {copied ? "已复制" : shareUrl}
              </button>
            </div>
          )}

          <div className="actions">
            <button type="button" onClick={restartGame} disabled={isOnlineMode && (!myPlayer || !state)}>
              重开
            </button>
            <button
              type="button"
              className="secondary"
              onClick={requestUndo}
              disabled={
                isOnlineMode
                  ? !myPlayer || !state || state.moveHistory.length === 0 || state.status !== "playing"
                  : localGame.moveHistory.length === 0 || localGame.status !== "playing"
              }
            >
              悔棋
            </button>
          </div>

          {state?.undoRequest && myPlayer && state.undoRequest.byClientId !== clientId && (
            <div className="undo-card">
              <span>{opponent?.name ?? "对手"} 请求悔棋</span>
              <div>
                <button type="button" onClick={() => respondUndo(true)}>
                  同意
                </button>
                <button type="button" className="secondary" onClick={() => respondUndo(false)}>
                  拒绝
                </button>
              </div>
            </div>
          )}
        </aside>

        <section className="board-wrap" aria-label="棋盘">
          <div className="board-frame">
            <div className={`board ${canMove ? "is-active" : ""}`}>
              {COORDINATE_LABELS.map((label, index) => (
                <span
                  className="coord-label coord-label-top"
                  key={`top-${label}`}
                  style={boardCoordinateStyle("top", index)}
                >
                  {label}
                </span>
              ))}
              {COORDINATE_LABELS.map((label, index) => (
                <span
                  className="coord-label coord-label-bottom"
                  key={`bottom-${label}`}
                  style={boardCoordinateStyle("bottom", index)}
                >
                  {label}
                </span>
              ))}
              {Array.from({ length: BOARD_SIZE }).map((_, index) => (
                <span
                  className="coord-label coord-label-left"
                  key={`left-${index}`}
                  style={boardCoordinateStyle("left", index)}
                >
                  {BOARD_SIZE - index}
                </span>
              ))}
              {Array.from({ length: BOARD_SIZE }).map((_, index) => (
                <span
                  className="coord-label coord-label-right"
                  key={`right-${index}`}
                  style={boardCoordinateStyle("right", index)}
                >
                  {BOARD_SIZE - index}
                </span>
              ))}
              {STAR_POINTS.map((point) => (
                <span
                  aria-hidden="true"
                  className="star-point"
                  key={`star-${point.row}-${point.col}`}
                  style={boardPointStyle(point.row, point.col)}
                />
              ))}
              {Array.from({ length: BOARD_SIZE }).map((_, row) =>
                Array.from({ length: BOARD_SIZE }).map((__, col) => {
                  const stone = board[row][col] ?? null;
                  const key = `${row}-${col}`;
                  const isLastMove = lastMove?.row === row && lastMove.col === col;

                  return (
                    <button
                      type="button"
                      key={key}
                      style={boardPointStyle(row, col)}
                      className={[
                        "cell",
                        stone ? `has-${stone}` : "",
                        winningSet.has(key) ? "is-winning" : "",
                        isLastMove ? "is-last" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-label={`${row + 1}行${col + 1}列${stone ? stoneLabel(stone) : "空位"}`}
                      disabled={!canMove || Boolean(stone)}
                      onClick={() => makeMove({ row, col })}
                    >
                      {stone && <span className="stone" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function PlayerRow({
  color,
  state,
  clientId
}: {
  color: Stone;
  state: RoomState | null;
  clientId: string;
}) {
  const player = state?.players.find((item) => item.color === color);
  const isTurn = state?.status === "playing" && state.turn === color;
  const isMe = player?.clientId === clientId;

  return (
    <div className={`player-row ${isTurn ? "is-turn" : ""}`}>
      <span className={`mini-stone ${color}`} />
      <div>
        <strong>{player?.name ?? "等待加入"}</strong>
        <small>
          {stoneLabel(color)}
          {isMe ? " · 你" : ""}
          {player && !player.online ? " · 离线" : ""}
        </small>
      </div>
    </div>
  );
}

function LocalPlayerRow({
  color,
  name,
  isTurn
}: {
  color: Stone;
  name: string;
  isTurn: boolean;
}) {
  return (
    <div className={`player-row ${isTurn ? "is-turn" : ""}`}>
      <span className={`mini-stone ${color}`} />
      <div>
        <strong>{name}</strong>
        <small>{stoneLabel(color)}</small>
      </div>
    </div>
  );
}

function applyLocalMove(
  game: LocalGame,
  position: Position,
  color: Stone,
  mode: GameMode
): LocalGame {
  if (game.status !== "playing" || game.board[position.row]?.[position.col] || color !== game.turn) {
    return game;
  }

  const board = game.board.map((row) => [...row]);
  board[position.row][position.col] = color;

  const winningLine = findWinningLine(board, position, color);
  const moveHistory = [
    ...game.moveHistory,
    { ...position, color, moveNumber: game.moveHistory.length + 1 }
  ];

  if (winningLine.length) {
    return {
      ...game,
      board,
      winner: color,
      winningLine,
      moveHistory,
      status: "won",
      message: `${stoneLabel(color)}获胜。`
    };
  }

  if (isBoardFull(board)) {
    return {
      ...game,
      board,
      moveHistory,
      status: "draw",
      message: "棋盘已满，平局。"
    };
  }

  const turn = nextTurn(color);

  return {
    ...game,
    board,
    turn,
    moveHistory,
    message: getLocalMessage(mode, turn)
  };
}

function undoLocalMove(game: LocalGame, mode: GameMode): LocalGame {
  const undoCount = mode === "ai" ? 2 : 1;
  const nextHistory = game.moveHistory.slice(0, Math.max(0, game.moveHistory.length - undoCount));
  const nextGame = createLocalGame(mode);

  return nextHistory.reduce(
    (current, move) => applyLocalMove(current, move, move.color, mode),
    nextGame
  );
}

function chooseSimpleAiMove(board: LocalGame["board"]): Position | null {
  const available = getAvailablePositions(board);

  if (!available.length) {
    return null;
  }

  return (
    findTacticalMove(board, available, "white") ??
    findTacticalMove(board, available, "black") ??
    getCenterMove(board) ??
    available[Math.floor(Math.random() * available.length)]
  );
}

function findTacticalMove(
  board: LocalGame["board"],
  available: Position[],
  color: Stone
): Position | null {
  for (const move of available) {
    const nextBoard = board.map((row) => [...row]);
    nextBoard[move.row][move.col] = color;

    if (findWinningLine(nextBoard, move, color).length) {
      return move;
    }
  }

  return null;
}

function getCenterMove(board: LocalGame["board"]): Position | null {
  const center = Math.floor(BOARD_SIZE / 2);

  return board[center][center] ? null : { row: center, col: center };
}

function getAvailablePositions(board: LocalGame["board"]): Position[] {
  const positions: Position[] = [];

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!board[row][col]) {
        positions.push({ row, col });
      }
    }
  }

  return positions;
}

function getLocalMessage(mode: GameMode, turn: Stone): string {
  if (mode === "ai") {
    return turn === "black" ? "轮到你落子。" : "电脑思考中。";
  }

  return `轮到${stoneLabel(turn)}。`;
}

function boardPointStyle(row: number, col: number): React.CSSProperties {
  return {
    left: `${boardAxisPercent(col)}%`,
    top: `${boardAxisPercent(row)}%`
  };
}

function boardCoordinateStyle(
  side: "top" | "bottom" | "left" | "right",
  index: number
): React.CSSProperties {
  const position = `${boardAxisPercent(index)}%`;

  if (side === "top") {
    return { left: position, top: "1.6%" };
  }

  if (side === "bottom") {
    return { left: position, top: "98.4%" };
  }

  if (side === "left") {
    return { left: "1.6%", top: position };
  }

  return { left: "98.4%", top: position };
}

function boardAxisPercent(index: number): number {
  return BOARD_EDGE_PERCENT + (index * BOARD_SPAN_PERCENT) / (BOARD_SIZE - 1);
}

function getRoomFromUrl(): string {
  return new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() ?? "";
}

function stoneLabel(stone: Stone): string {
  return stone === "black" ? "黑棋" : "白棋";
}
