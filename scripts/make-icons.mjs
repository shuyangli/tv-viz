// Renders the app icons as PNGs without any image dependency: a tiny Mandelbrot on a
// dark ground, encoded by hand (zlib is built into Node).
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
// Sizes from the webOS TV appinfo.json guide.
const ICONS = [
  { file: 'icon.png', size: 80 },
  { file: 'largeIcon.png', size: 130 },
]
const MAX_ITER = 120
const BACKGROUND = [5, 6, 10]

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function escapeTime(cx, cy) {
  let zx = 0
  let zy = 0
  for (let i = 0; i < MAX_ITER; i++) {
    const xx = zx * zx
    const yy = zy * zy
    if (xx + yy > 256) return i + 2 - Math.log2(Math.log2(xx + yy))
    zy = 2 * zx * zy + cy
    zx = xx - yy + cx
  }
  return -1
}

function palette(t) {
  const ch = (d) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (t + d))
  return [ch(0), ch(0.1), ch(0.2)]
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const radius = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius
      const dy = y + 0.5 - radius
      const o = (y * size + x) * 4
      const rounded = dx * dx + dy * dy <= radius * radius
      if (!rounded) {
        rgba[o + 3] = 0
        continue
      }
      const cx = -0.65 + (dx / size) * 2.6
      const cy = (dy / size) * 2.6
      const n = escapeTime(cx, cy)
      let rgb = BACKGROUND
      if (n >= 0) {
        const fade = Math.min(1, n / 5)
        rgb = palette(n / 24).map((c) => Math.round(255 * c * fade))
      }
      rgba[o] = rgb[0]
      rgba[o + 1] = rgb[1]
      rgba[o + 2] = rgb[2]
      rgba[o + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const { file, size } of ICONS) {
  writeFileSync(join(OUT_DIR, file), renderIcon(size))
  console.log('wrote', file, size + 'x' + size)
}
