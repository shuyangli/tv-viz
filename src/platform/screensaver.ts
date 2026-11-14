interface ServiceBridge {
  onservicecallback: ((message: string) => void) | null
  call(uri: string, payload: string): void
}

type BridgeConstructor = new () => ServiceBridge

const POWER_SERVICE = 'luna://com.webos.service.tvpower/power/'
const CLIENT_NAME = 'com.shuyangli.fractals.screensaver'

/**
 * webOS asks subscribed apps before it starts its screensaver and starts it unless one
 * of them declines. The show never holds still, so it declines every time. Outside
 * webOS there is no bridge and this does nothing.
 */
export function keepScreenAwake(): void {
  const scope = window as unknown as { WebOSServiceBridge?: BridgeConstructor; PalmServiceBridge?: BridgeConstructor }
  const Bridge = scope.WebOSServiceBridge || scope.PalmServiceBridge
  if (!Bridge) return
  const subscription = new Bridge()
  subscription.onservicecallback = (message) => {
    let timestamp: unknown
    try {
      timestamp = (JSON.parse(message) as { timestamp?: unknown }).timestamp
    } catch {
      return
    }
    if (timestamp === undefined) return
    const reply = new Bridge()
    reply.onservicecallback = null
    reply.call(
      POWER_SERVICE + 'responseScreenSaverRequest',
      JSON.stringify({ clientName: CLIENT_NAME, ack: false, timestamp }),
    )
  }
  subscription.call(
    POWER_SERVICE + 'registerScreenSaverRequest',
    JSON.stringify({ subscribe: true, clientName: CLIENT_NAME }),
  )
}
