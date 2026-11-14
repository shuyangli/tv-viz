// Screenshots a visualization in headless Chrome (software GL) and reports shader errors.
//   node scripts/shot.mjs --scene liquid --t 0,30,90 --out /tmp/shots [--palette 1] [--wait 1500] [--size 960x540]
// Each time in --t is loaded fresh at that scene time and left running for --wait ms first,
// so feedback scenes have frames to build on. Exits 1 if the page logged an error.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const scene = arg('scene', '0')
const times = arg('t', '10').split(',').map(Number)
const out = arg('out', 'shots')
const palette = arg('palette', '')
const wait = Number(arg('wait', '1500'))
const [width, height] = arg('size', '960x540').split('x').map(Number)

mkdirSync(out, { recursive: true })
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' })
await server.listen()
const address = server.httpServer.address()
const base = 'http://127.0.0.1:' + address.port + '/'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
})
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width, height })
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|Failed to load resource/.test(message.text())) errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  for (const t of times) {
    await page.goto(base + '?res=1&scene=' + scene + '&t=' + t + (palette === '' ? '' : '&palette=' + palette))
    await page.addStyleTag({ content: '#hud { display: none }' })
    await new Promise((resolve) => setTimeout(resolve, wait))
    const file = join(out, scene + '-p' + (palette === '' ? 0 : palette) + '-t' + t + '.png')
    await page.screenshot({ path: file })
    console.log(file)
  }
} finally {
  await browser.close()
  await server.close()
}
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
