export interface ActiveComputerUseTurn {
  sourceId: string
  turnId: string
  expiresAt: number
}

const STORAGE_KEY = 'runtime/computer-use/active-turn'
const TURN_TTL_MS = 5 * 60 * 1000

let activeTurn: ActiveComputerUseTurn | undefined

function readSharedTurn() {
  if (typeof localStorage === 'undefined')
    return activeTurn

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return undefined
    const turn = JSON.parse(raw) as Partial<ActiveComputerUseTurn>
    if (typeof turn.sourceId !== 'string' || typeof turn.turnId !== 'string' || typeof turn.expiresAt !== 'number' || turn.expiresAt <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY)
      return undefined
    }
    return turn as ActiveComputerUseTurn
  }
  catch {
    return undefined
  }
}

function writeSharedTurn(turn: ActiveComputerUseTurn | undefined) {
  if (typeof localStorage === 'undefined')
    return

  try {
    if (turn)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(turn))
    else
      localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // Browser storage is a cross-window convenience only; main-process token
    // validation remains the enforcement boundary.
  }
}

export function beginComputerUseTurn(sourceId: string) {
  const turn = {
    sourceId,
    turnId: `${sourceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    expiresAt: Date.now() + TURN_TTL_MS,
  }
  activeTurn = turn
  writeSharedTurn(turn)
  return turn
}

export function endComputerUseTurn(sourceId: string) {
  const current = getActiveComputerUseTurn()
  if (current?.sourceId === sourceId) {
    activeTurn = undefined
    writeSharedTurn(undefined)
  }
}

export function getActiveComputerUseTurn() {
  const sharedTurn = readSharedTurn()
  if (sharedTurn)
    activeTurn = sharedTurn
  return activeTurn
}
