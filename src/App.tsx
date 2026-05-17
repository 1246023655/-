import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { BOARD_SIZE, type Ack, type Position, type RoomState, type Stone } from "./shared/types";

const socket = io();
const CLIENT_ID_KEY = "gomoku.clientId";
const PLAYER_NAME_KEY = "gomoku.playerName";

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

export default function App() {
  const [clientId] = useState(getClientId);
  const [playerName, setPlayerName] = useState(getInitialName);
  const [roomInput, setRoomInput] = useState(() => getRoomFromUrl());
  const [state, setState] = useState<RoomState | null>(null);
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(socket.connected);
  const [copied, setCopied] = useState(false);

  const myPlayer = state?.players.find((player) => player.clientId === clientId) ?? null;
  const opponent = state?.players.find((player) => player.clientId !== clientId) ?? null;
  const roleLabel = myPlayer
    ? `${stoneLabel(myPlayer.color)}玩家`
    : state
      ? "观战"
      : "未入座";
  const canMove = Boolean(myPlayer && state?.status === "playing" && state.turn === myPlayer.color);
  const shareUrl = state
    ? `${window.location.origin}${window.location.pathname}?room=${state.roomId}`
    : "";
  const winningSet = useMemo(() => {
    return new Set(state?.winningLine.map((item) => `${item.row}-${item.col}`) ?? []);
  }, [state?.winningLine]);
  const lastMove = state?.moveHistory.at(-1);

  useEffect(() => {
    localStorage.setItem(PLAYER_NAME_KEY, playerName);
  }, [playerName]);

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

  function createRoom() {
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

    socket.emit("game:move", position, (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  function restartGame() {
    socket.emit("game:restart", (ack: Ack) => {
      if (!ack.ok) {
        setNotice(ack.error);
      }
    });
  }

  function requestUndo() {
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

  return (
    <main className="shell">
      <section className="topbar" aria-label="房间操作">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>五子棋</h1>
            <p>{connected ? "已连接" : "连接中"}</p>
          </div>
        </div>

        <div className="room-tools">
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
            <span className="eyebrow">{state?.roomId ? `房间 ${state.roomId}` : "未加入房间"}</span>
            <strong>{state?.message ?? "创建或加入房间开始。"}</strong>
            <p>{notice || `你的身份：${roleLabel}`}</p>
          </div>

          <div className="players">
            <PlayerRow color="black" state={state} clientId={clientId} />
            <PlayerRow color="white" state={state} clientId={clientId} />
            <div className="spectator-row">
              <span>观战</span>
              <strong>{state?.spectators ?? 0}</strong>
            </div>
          </div>

          {state && (
            <div className="share-box">
              <span>分享链接</span>
              <button type="button" className="link-button" onClick={copyShareUrl}>
                {copied ? "已复制" : shareUrl}
              </button>
            </div>
          )}

          <div className="actions">
            <button type="button" onClick={restartGame} disabled={!myPlayer || !state}>
              重开
            </button>
            <button
              type="button"
              className="secondary"
              onClick={requestUndo}
              disabled={!myPlayer || !state || state.moveHistory.length === 0 || state.status !== "playing"}
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
          <div
            className={`board ${canMove ? "is-active" : ""}`}
            style={{ "--board-size": BOARD_SIZE } as React.CSSProperties}
          >
            {Array.from({ length: BOARD_SIZE }).map((_, row) =>
              Array.from({ length: BOARD_SIZE }).map((__, col) => {
                const stone = state?.board[row][col] ?? null;
                const key = `${row}-${col}`;
                const isLastMove = lastMove?.row === row && lastMove.col === col;

                return (
                  <button
                    type="button"
                    key={key}
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

function getRoomFromUrl(): string {
  return new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() ?? "";
}

function stoneLabel(stone: Stone): string {
  return stone === "black" ? "黑棋" : "白棋";
}
