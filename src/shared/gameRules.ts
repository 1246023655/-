import { BOARD_SIZE, type Board, type Cell, type Position, type Stone } from "./types.js";

const DIRECTIONS: Position[] = [
  { row: 0, col: 1 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
  { row: 1, col: -1 }
];

export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from<Cell>({ length: BOARD_SIZE }).fill(null)
  );
}

export function isInsideBoard(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function nextTurn(turn: Stone): Stone {
  return turn === "black" ? "white" : "black";
}

export function findWinningLine(board: Board, origin: Position, color: Stone): Position[] {
  for (const direction of DIRECTIONS) {
    const line = collectLine(board, origin, color, direction);

    if (line.length >= 5) {
      return line.slice(0, 5);
    }
  }

  return [];
}

export function isBoardFull(board: Board): boolean {
  return board.every((row) => row.every(Boolean));
}

function collectLine(
  board: Board,
  origin: Position,
  color: Stone,
  direction: Position
): Position[] {
  const negative = collectSide(board, origin, color, {
    row: -direction.row,
    col: -direction.col
  }).reverse();
  const positive = collectSide(board, origin, color, direction);

  return [...negative, origin, ...positive];
}

function collectSide(
  board: Board,
  origin: Position,
  color: Stone,
  direction: Position
): Position[] {
  const line: Position[] = [];
  let row = origin.row + direction.row;
  let col = origin.col + direction.col;

  while (isInsideBoard(row, col) && board[row][col] === color) {
    line.push({ row, col });
    row += direction.row;
    col += direction.col;
  }

  return line;
}
