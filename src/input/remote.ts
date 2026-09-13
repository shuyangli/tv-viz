export type RemoteAction =
  | 'back'
  | 'ok'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'playPause'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'

/** webOS remote key codes, from the LG "Remote Control" developer guide. */
const WEBOS_KEY_CODES: Readonly<Record<number, RemoteAction>> = {
  461: 'back',
  13: 'ok',
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
  415: 'playPause',
  19: 'playPause',
  413: 'playPause',
  403: 'red',
  404: 'green',
  405: 'yellow',
  406: 'blue',
}

/** Desktop keys so the app is usable in a laptop browser while developing. */
const DESKTOP_KEYS: Readonly<Record<string, RemoteAction>> = {
  Escape: 'back',
  Backspace: 'back',
  Enter: 'ok',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ' ': 'playPause',
  r: 'red',
  g: 'green',
  y: 'yellow',
  b: 'blue',
}

export function actionForKey(keyCode: number, key: string): RemoteAction | null {
  const remote = WEBOS_KEY_CODES[keyCode]
  if (remote) return remote
  const desktop = DESKTOP_KEYS[key]
  return desktop === undefined ? null : desktop
}
