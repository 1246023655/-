export const BOARD_SIZE = 15;

export type Stone = "black" | "white";
export type Cell = Stone | null;
export type Board = Cell[][];

export type Position = {
  row: number;
  col: number;
};

export type PlayerInfo = {
  clientId: string;
  name: string;
  color: Stone;
  online: boolean;
  ready: boolean;
};

export type Move = Position & {
  color: Stone;
  clientId: string;
  moveNumber: number;
  playedAt: number;
};

export type UndoRequest = {
  byClientId: string;
  byColor: Stone;
  moveNumber: number;
};

export type RoomEvent = {
  id: number;
  message: string;
  type: "info" | "success" | "warning";
  code?: "game-start" | "swap-request";
};

export type ColorSwapRequest = {
  id: number;
  fromClientId: string;
  toClientId: string;
  requestedColor: Stone;
  fromName: string;
};

export type GameStatus =
  | "waiting"
  | "playing"
  | "won"
  | "draw"
  | "paused";

export type RoomState = {
  roomId: string;
  board: Board;
  players: PlayerInfo[];
  spectators: number;
  turn: Stone;
  winner: Stone | null;
  winningLine: Position[];
  moveHistory: Move[];
  status: GameStatus;
  undoRequest: UndoRequest | null;
  colorSwapRequest: ColorSwapRequest | null;
  lastEvent: RoomEvent | null;
  message: string;
};

export type JoinPayload = {
  roomId: string;
  clientId: string;
  name: string;
};

export type CreateRoomPayload = {
  clientId: string;
  name: string;
};

export type MovePayload = Position;

export type Ack<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : T))
  | { ok: false; error: string };
