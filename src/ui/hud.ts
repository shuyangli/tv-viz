export interface HudInfo {
  readonly title: string
  readonly subtitle: string
  readonly help: string
}

const DEFAULT_VISIBLE_MS = 4000

/** Small overlay that appears on remote input and hides itself, so nothing static burns into the OLED. */
export class Hud {
  private hideTimer: number | null = null
  private readonly title: HTMLElement
  private readonly subtitle: HTMLElement
  private readonly help: HTMLElement

  constructor(private readonly root: HTMLElement) {
    this.title = this.line('hud-title')
    this.subtitle = this.line('hud-sub')
    this.help = this.line('hud-help')
  }

  show(info: HudInfo, visibleMs = DEFAULT_VISIBLE_MS): void {
    this.title.textContent = info.title
    this.subtitle.textContent = info.subtitle
    this.help.textContent = info.help
    this.root.classList.add('visible')
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => this.hide(), visibleMs)
  }

  hide(): void {
    this.root.classList.remove('visible')
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  get visible(): boolean {
    return this.root.classList.contains('visible')
  }

  private line(className: string): HTMLElement {
    const el = document.createElement('div')
    el.className = className
    this.root.appendChild(el)
    return el
  }
}
