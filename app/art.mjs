// Aster's art. Every pixel is a character in a row of a part; a frame says where
// the parts sit. Writes frames/sheet.png (one strip of frames, repeats shared),
// frames/icons.png (the menu's icons) and frames/manifest.json (each animation
// as [frame, milliseconds] pairs). The outputs are checked in, so building the
// app needs no Node.
//   node art.mjs                  build the art
//   node art.mjs --contact a.png  also write a contact sheet to look at
//   node art.mjs --preview a.png  also write an animated PNG for the README

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const W = 41
const H = 38
const LIFT = 4 // room above the spark for a hop

const hex = (color, alpha = 255) => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
  alpha,
]

const COLORS = {
  O: hex('#4a2318'), // outline
  B: hex('#d97757'), // body
  H: hex('#ee9e80'), // highlight
  S: hex('#b55a3c'), // shade
  W: hex('#f8e3d4'), // belly, paper
  C: hex('#f4a6a0'), // cheek
  E: hex('#2a1610'), // eye, mouth
  L: hex('#ffffff'), // eye shine
  Y: hex('#f6a94a'), // spark
  y: hex('#ffe2a8'), // spark's core
  V: hex('#a98a65'), // spark asleep
  v: hex('#c9a57a'), // spark asleep, core
  R: hex('#e5484d'), // heart, tongue
  r: hex('#ff8a8f'), // heart's shine
  G: hex('#6b7280'), // laptop, ink
  g: hex('#a8b0bc'), // laptop's deck, thought dots, dust
  D: hex('#1f2937'), // laptop's screen
  T: hex('#7de2b8'), // code
  A: hex('#5aa9e6'), // water, glass, book cover
  a: hex('#bfe3fb'), // glass's shine
  K: hex('#a8703e'), // cookie's edge, pencil's wood
  k: hex('#dfa866'), // cookie
  Z: hex('#8fa3c7'), // zzz
  P: hex('#ffd35c'), // sparkle, pencil
  q: [0, 0, 0, 50], // shadow
  b: hex('#d8453c'), // body, mad
  h: hex('#ef7f6e'), // highlight, mad
  s: hex('#a8322c'), // shade, mad
  c: hex('#ff9c8f'), // cheek, mad
}

const FOOT_LEFT = [10, 28, ['....OSSSO............', '....OOOOO............']]
const FOOT_RIGHT = [10, 28, ['............OSSSO....', '............OOOOO....']]
const SHADOW = [12, 30, ['..qqqqqqqqqqqqq..']]
const SHADOW_SMALL = [12, 30, ['.....qqqqqqqqq...']]
const BODY = [
  10,
  12,
  [
    '......OOOOOOOOO......',
    '....OOHHHHHBBBBOO....',
    '...OHHHBBBBBBBBBBO...',
    '..OHHBBBBBBBBBBBBSO..',
    '.OHHBBBBBBBBBBBBBBSO.',
    '.OHBBBBBBBBBBBBBBBSO.',
    '.OHBBBBBBBBBBBBBBBSO.',
    '.OBBBBBBBBBBBBBBBBSO.',
    '.OBBBBBBBBBBBBBBBBSO.',
    '.OBBBBBWWWWWWWBBBBSO.',
    '.OBBBWWWWWWWWWWWBBSO.',
    '..OBBWWWWWWWWWWWBSO..',
    '..OBBBWWWWWWWWWBBSO..',
    '...OSBBBBBBBBBBBSO...',
    '....OOSSSSSSSSSOO....',
    '......OOOOOOOOO......',
  ],
]
const STEM = [20, 9, ['O', 'O', 'O']]
const SPARK = {
  full: [17, 2, ['...Y...', '.Y.Y.Y.', '..YyY..', 'YYyyyYY', '..YyY..', '.Y.Y.Y.', '...Y...']],
  small: [17, 2, ['.......', '...Y...', '...y...', '.YyyyY.', '...y...', '...Y...', '.......']],
  dim: [17, 2, ['.......', '...V...', '...v...', '.VvvvV.', '...v...', '...V...', '.......']],
  hot: [17, 2, ['...R...', '.R.R.R.', '..RrR..', 'RRrrrRR', '..RrR..', '.R.R.R.', '...R...']],
  hotSmall: [17, 2, ['.......', '...R...', '...r...', '.RrrrR.', '...r...', '...R...', '.......']],
}
const CHEEKS = [
  [13, 20, ['CC']],
  [26, 20, ['CC']],
]
// Drawn over the body, each opens the body's outline where it joins.
const armLeft = (y, dx = 0) => [8 + dx, y, ['.OO.', 'OBBB', 'OBBB', '.OO.']]
const armRight = (y, dx = 0) => [29 + dx, y, ['.OO.', 'BBBO', 'BBBO', '.OO.']]

const EYE = ['LE', 'EE', 'EE']
const pair = (rows, left, right, y) => [
  [left, y, rows],
  [right, y, rows],
]
const EYES = {
  open: pair(EYE, 16, 23, 17),
  left: pair(EYE, 15, 22, 17),
  right: pair(EYE, 17, 24, 17),
  up: pair(EYE, 17, 24, 16),
  down: pair(EYE, 16, 23, 18),
  downLeft: pair(EYE, 15, 22, 18),
  downRight: pair(EYE, 17, 24, 18),
  shut: pair(['EEE'], 15, 23, 18),
  joy: pair(['.E.', 'E.E'], 15, 23, 17),
  wide: pair(['LLL', 'LEL', 'LLL'], 15, 23, 17),
  angry: [
    [14, 16, ['EE...', '.EEE.', '..LE.', '..EE.']],
    [22, 16, ['...EE', '.EEE.', '.LE..', '.EE..']],
  ],
}
const MOUTH = {
  smile: [19, 21, ['E.E', '.E.']],
  grin: [19, 21, ['EEE', 'ERE', '.E.']],
  gasp: [19, 21, ['.E.', 'E.E', '.E.']],
  flat: [19, 22, ['EEE']],
  tiny: [20, 22, ['E']],
  frown: [19, 22, ['.E.', 'E.E']],
  teeth: [18, 21, ['EEEEE', 'ELELE', 'EEEEE']],
}

const HEART = ['.R.R.', 'RrRRR', 'RRRRR', '.RRR.', '..R..']
const STAR = ['.P.', 'PPP', '.P.']
const BIG_Z = ['ZZZZZ', '...Z.', '..Z..', '.Z...', 'ZZZZZ']
const SMALL_Z = ['ZZZZ', '..Z.', '.Z..', 'ZZZZ']
const DOT = ['gg', 'gg']
const DROP = ['.A.', 'AAA', 'AAA', '.A.']
const BANG = ['RR', 'RR', 'RR', '..', 'RR']
const PUFF = ['.gg', 'ggg', '.g.']
const VEIN = ['.R.R.', 'RR.RR', '.....', 'RR.RR', '.R.R.']

const screen = (a, b, c) => [
  14,
  23,
  ['.GGGGGGGGGGG.', '.GDDDDDDDDDG.', a, b, c, '.GGGGGGGGGGG.', 'GgggggggggggG'],
]
const NO_CODE = '.GDDDDDDDDDG.'
const CODE_1 = '.GDTTTDDDDDG.'
const CODE_2 = '.GDDTTTTDDDG.'
const CODE_3 = '.GDTTDDDDDDG.'
const CODE_3_CURSOR = '.GDTTLDDDDDG.'

const book = (left, right) => [
  14,
  23,
  ['.AAAAAAAAAAA.', 'AWWWWWAWWWWWA', left, 'AWWWWWAWWWWWA', right, 'AWWWWWAWWWWWA', '.AAAAAAAAAAA.'],
]
const LENS = [
  24,
  19,
  [
    '..OOOOO...',
    '.OaaAAAO..',
    'OaaAAAAAO.',
    'OaAAAAAAO.',
    'OAAAAAAAO.',
    '.OAAAAAO..',
    '..OOOOOKK.',
    '.......KKK',
    '........KK',
  ],
]
const PENCIL = [
  23,
  18,
  ['.......RR', '......RRR', '.....PPR.', '....PPP..', '...PPP...', '..PPP....', '.kPP.....', '.kk......', 'E........'],
]
const paper = (a, b) => [13, 25, ['WWWWWWWWWWWWW', a, 'WWWWWWWWWWWWW', b, 'WWWWWWWWWWWWW']]
const BLANK_LINE = 'WWWWWWWWWWWWW'

const COOKIES = [
  ['..KKK..', '.KkkkK.', 'KkEkkkK', 'KkkkEkK', 'KkkEkkK', '.KkkkK.', '..KKK..'],
  ['....K..', '....kK.', '....kkK', '...kEkK', 'KkkEkkK', '.KkkkK.', '..KKK..'],
  ['.......', '.......', '.....kK', '....EkK', '...EkkK', '..kkkK.', '..KKK..'],
  ['.......', '.......', '.......', '.....kK', '....kkK', '....kK.', '....K..'],
]

const shift = ([x, y, rows], dx = 0, dy = 0) => [x + dx, y + dy, rows]
const f = (ms, o = {}) => ({ ms, ...o })
const repeat = (times, frames) => Array.from({ length: times }, () => frames).flat()

const ANIMS = {
  idle: [
    ...repeat(2, [f(500), f(500, { dy: 1 }), f(500, { spark: 'small' }), f(500, { dy: 1, spark: 'small' })]),
    f(110, { eyes: 'shut' }),
    f(400),
    f(500, { dy: 1, spark: 'small' }),
    f(700, { eyes: 'left' }),
    f(700, { eyes: 'left', dy: 1 }),
    f(300),
    f(700, { eyes: 'right', spark: 'small' }),
    f(700, { eyes: 'right', dy: 1 }),
    f(300),
    f(110, { eyes: 'shut' }),
    f(140),
    f(110, { eyes: 'shut' }),
    f(500, { spark: 'small' }),
    f(500, { dy: 1 }),
  ],
  thinking: [0, 1, 2, 3, 3, 2].map((dots, i) =>
    f(300, {
      eyes: 'up',
      mouth: 'tiny',
      spark: i % 2 ? 'small' : 'full',
      dy: i > 2 ? 1 : 0,
      fx: [[29, 9, DOT], [32, 6, DOT], [35, 3, DOT]].slice(0, dots),
    }),
  ),
  'working-laptop': [
    screen(NO_CODE, NO_CODE, NO_CODE),
    screen(CODE_1, NO_CODE, NO_CODE),
    screen(CODE_1, CODE_2, NO_CODE),
    screen(CODE_1, CODE_2, CODE_3),
    screen(CODE_1, CODE_2, CODE_3_CURSOR),
    screen(CODE_1, CODE_2, CODE_3),
    screen(CODE_1, CODE_2, CODE_3_CURSOR),
    screen(CODE_2, CODE_3, NO_CODE),
  ].map((held, i) =>
    f(170, {
      eyes: i === 6 ? 'shut' : 'down',
      mouth: 'flat',
      spark: i % 2 ? 'small' : 'full',
      armL: i % 2 ? 21 : 20,
      armR: i % 2 ? 20 : 21,
      dy: i % 4 < 2 ? 0 : 1,
      held: [held],
    }),
  ),
  'working-book': [
    [book('AWGGGWAWGGGWA', 'AWGGGWAWGGWWA'), 'downLeft'],
    [book('AWGGGWAWGGGWA', 'AWGGGWAWGGWWA'), 'down'],
    [book('AWGGGWAWGGGWA', 'AWGGGWAWGGWWA'), 'downRight'],
    [book('AWGGGWAWGGGWA', 'AWGGGWAWGGWWA'), 'down'],
    [book('AWGGGWAWGGGWA', 'AWGGGWAWGGWWA'), 'downLeft'],
    [book('AWGGGWWWWWWWA', 'AWGGGWWWWWWWA'), 'down'],
    [book('AWGGWWAWGGGWA', 'AWGGGWAWGGGWA'), 'downLeft'],
    [book('AWGGWWAWGGGWA', 'AWGGGWAWGGGWA'), 'downRight'],
  ].map(([held, eyes], i) =>
    f(300, { eyes, mouth: 'tiny', spark: i % 2 ? 'small' : 'full', dy: i % 4 < 2 ? 0 : 1, held: [held] }),
  ),
  'working-magnifier': [0, -2, -4, -6, -4, -2].map((dx, i) =>
    f(230, {
      eyes: dx <= -4 ? 'down' : 'downRight',
      mouth: 'flat',
      spark: i % 2 ? 'small' : 'full',
      armR: 21,
      dy: i % 3 === 2 ? 1 : 0,
      held: [shift(LENS, dx)],
    }),
  ),
  'working-pencil': [
    ['WGGWWWWWWWWWW', BLANK_LINE],
    ['WGGGGGWWWWWWW', BLANK_LINE],
    ['WGGGGGGGGWWWW', BLANK_LINE],
    ['WGGGGGGGGWWWW', 'WGGWWWWWWWWWW'],
    ['WGGGGGGGGWWWW', 'WGGGGGWWWWWWW'],
    ['WGGGGGGGGWWWW', 'WGGGGGGGWWWWW'],
  ].map(([a, b], i) =>
    f(180, {
      eyes: 'down',
      mouth: 'flat',
      spark: i % 2 ? 'small' : 'full',
      armR: 21,
      dy: i % 3 === 2 ? 1 : 0,
      held: [paper(a, b), shift(PENCIL, i % 2 ? -2 : 0, i % 2 ? 1 : 0)],
    }),
  ),
  waving: [17, 14, 17, 14, 17, 14].map((armR, i) =>
    f(200, { eyes: 'joy', mouth: 'grin', armR, armRDx: armR === 14 ? 1 : 0, dy: i % 2, spark: i % 2 ? 'small' : 'full' }),
  ),
  // Claude needs you: both arms going, little hops, a flashing "!".
  asking: [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
    f(140, {
      eyes: i === 6 ? 'shut' : 'open',
      mouth: 'grin',
      armL: i % 2 ? 13 : 16,
      armLDx: i % 2 ? -1 : 0,
      armR: i % 2 ? 16 : 13,
      armRDx: i % 2 ? 0 : 1,
      dy: [0, -1, -2, -1, 0, -1, -2, -1][i],
      feetDy: [0, 0, -1, 0, 0, 0, -1, 0][i],
      spark: i % 2 ? 'small' : 'full',
      fx: i % 4 < 3 ? [[31, 3, BANG]] : [],
    }),
  ),
  // Ten minutes and still no answer: red, gritting its teeth, stomping, steaming.
  mad: [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
    f(170, {
      eyes: 'angry',
      mouth: i % 4 < 2 ? 'teeth' : 'frown',
      isRed: true,
      spark: i % 2 ? 'hotSmall' : 'hot',
      dx: i % 2 ? 1 : -1,
      armL: i % 2 ? 18 : 20,
      armR: i % 2 ? 20 : 18,
      feetLDy: i % 4 === 0 ? -2 : 0,
      feetRDy: i % 4 === 2 ? -2 : 0,
      fx: [
        [5 - i % 4, 15 - (i % 4) * 2, PUFF],
        [33 + i % 4, 15 - (i % 4) * 2, PUFF],
        ...(i % 4 < 2 ? [[31, 4, VEIN]] : []),
      ],
    }),
  ),
  happy: [0, -2, -4, -4, -2, 0, 1, 0].map((dy, i) =>
    f(95, {
      eyes: 'joy',
      mouth: 'grin',
      armL: 16,
      armR: 16,
      dy,
      feetDy: Math.min(dy, 0),
      spark: i % 2 ? 'small' : 'full',
      fx: i % 4 < 2 ? [[5, 8, STAR], [34, 10, STAR]] : [[3, 22, STAR], [36, 22, STAR]],
    }),
  ),
  oops: [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
    f(115, {
      eyes: 'wide',
      mouth: 'gasp',
      dx: i % 2 ? 1 : -1,
      fx: [[31, 11 + i, DROP], ...(i % 4 < 2 ? [[8, 7, BANG]] : [])],
    }),
  ),
  asleep: [[], [], [0], [0], [0, 1], [0, 1], [0, 1, 2], [0, 1, 2], [1, 2], [2]].map((zs, i) =>
    f(750, {
      eyes: 'shut',
      mouth: 'tiny',
      spark: 'dim',
      dy: i % 2,
      fx: zs.map(z => [[30, 11, SMALL_Z], [33, 5, BIG_Z], [37, 0, SMALL_Z]][z]),
    }),
  ),
  loved: [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
    f(130, {
      eyes: 'joy',
      mouth: 'grin',
      armL: 17,
      armR: 17,
      dy: [0, -1, -2, -1, 0, -1, -2, -1][i],
      feetDy: [0, 0, -1, 0, 0, 0, -1, 0][i],
      spark: i % 2 ? 'small' : 'full',
      fx: [
        [3, 16 - i, HEART],
        [33, 12 - ((i + 3) % 8), HEART],
        [28, 4 - ((i + 6) % 8) / 2 | 0, HEART],
      ],
    }),
  ),
  munching: Array.from({ length: 12 }, (_, i) =>
    f(175, {
      eyes: 'joy',
      mouth: i % 2 ? 'flat' : 'gasp',
      dy: i % 2,
      armR: 22,
      spark: i % 4 < 2 ? 'small' : 'full',
      held: [[23, 23, COOKIES[Math.floor(i / 3)]]],
      fx: i % 3 === 0 ? [] : [[20 + (i % 5), 26 + (i % 3), ['k']]],
    }),
  ),
  held: [0, 1, 2, 1].map(i =>
    f(170, {
      eyes: 'joy',
      mouth: 'grin',
      armL: 13,
      armR: 13,
      armRDx: 0,
      dy: -3,
      feetDx: i - 1,
      feetDy: -1,
      spark: i % 2 ? 'small' : 'full',
      shadow: false,
    }),
  ),
  land: [
    f(70, { eyes: 'shut', mouth: 'flat', dy: 2, spark: 'small', fx: [[9, 29, PUFF], [29, 29, PUFF]] }),
    f(90, { eyes: 'shut', mouth: 'flat', dy: 1, spark: 'small', fx: [[6, 28, PUFF], [32, 28, PUFF]] }),
    f(110, { eyes: 'open', mouth: 'smile', dy: 0, fx: [[4, 27, PUFF], [34, 27, PUFF]] }),
    f(130, { eyes: 'joy', mouth: 'smile', dy: 0 }),
  ],
}

const put = (img, [x, y, rows], dx = 0, dy = 0) => {
  rows.forEach((row, r) => {
    ;[...row].forEach((ch, c) => {
      if (ch === '.') return
      const px = x + c + dx
      const py = y + r + dy + LIFT
      if (px < 0 || px >= W || py < 0 || py >= H) return
      img.set(COLORS[ch], (py * W + px) * 4)
    })
  })
}

const RED_SKIN = { B: 'b', H: 'h', S: 's', C: 'c' }
const reddened = ([x, y, rows]) => [x, y, rows.map(row => row.replace(/[BHSC]/g, ch => RED_SKIN[ch]))]

const draw = frame => {
  const s = {
    eyes: 'open',
    mouth: 'smile',
    spark: 'full',
    armL: 20,
    armR: 20,
    armLDx: 0,
    armRDx: 0,
    dx: 0,
    dy: 0,
    feetDx: 0,
    feetDy: 0,
    feetLDy: 0,
    feetRDy: 0,
    fx: [],
    held: [],
    isRed: false,
    shadow: true,
    ...frame,
  }
  const img = new Uint8Array(W * H * 4)
  if (s.shadow) put(img, s.dy <= -3 ? SHADOW_SMALL : SHADOW)
  put(img, FOOT_LEFT, s.feetDx, s.feetDy + s.feetLDy)
  put(img, FOOT_RIGHT, s.feetDx, s.feetDy + s.feetRDy)
  const on = part => put(img, part, s.dx, s.dy)
  const skin = s.isRed ? reddened : part => part
  on(skin(BODY))
  on(STEM)
  CHEEKS.map(skin).forEach(on)
  on(skin(armLeft(s.armL, s.armLDx)))
  on(skin(armRight(s.armR, s.armRDx)))
  EYES[s.eyes].forEach(on)
  on(MOUTH[s.mouth])
  on(SPARK[s.spark])
  s.held.forEach(on)
  s.fx.forEach(part => put(img, part))

  return img
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)

  return out
}

const pngHeader = (width, height) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8 bits, RGBA

  return chunk('IHDR', header)
}

const packed = (width, height, rgba) => {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }

  return deflateSync(raw, { level: 9 })
}

const png = (width, height, rgba) =>
  Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(width, height),
    chunk('IDAT', packed(width, height, rgba)),
    chunk('IEND', Buffer.alloc(0)),
  ])

// An animated PNG: browsers play it, and it keeps the transparency a GIF can't.
const apng = (width, height, frames) => {
  const parts = [PNG_SIGNATURE, pngHeader(width, height)]
  const control = Buffer.alloc(8)
  control.writeUInt32BE(frames.length, 0)
  parts.push(chunk('acTL', control))
  let sequence = 0
  frames.forEach(({ rgba, ms }, i) => {
    const timing = Buffer.alloc(26)
    timing.writeUInt32BE(sequence++, 0)
    timing.writeUInt32BE(width, 4)
    timing.writeUInt32BE(height, 8)
    timing.writeUInt16BE(ms, 20)
    timing.writeUInt16BE(1000, 22)
    timing[24] = 1 // clear to transparent before the next frame
    parts.push(chunk('fcTL', timing))
    const data = packed(width, height, rgba)
    if (i === 0) {
      parts.push(chunk('IDAT', data))
    } else {
      const numbered = Buffer.alloc(4 + data.length)
      numbered.writeUInt32BE(sequence++, 0)
      data.copy(numbered, 4)
      parts.push(chunk('fdAT', numbered))
    }
  })
  parts.push(chunk('IEND', Buffer.alloc(0)))

  return Buffer.concat(parts)
}

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'frames')
mkdirSync(out, { recursive: true })

// The menu's icons, each in a cell of its own.
const ICON = 9
const ICONS = {
  heart: [2, 2, HEART],
  cookie: [1, 1, COOKIES[0]],
  spark: [1, 1, SPARK.full[2]],
  moon: [1, 1, ['..KKK..', '.KKK...', 'KKK....', 'KKK....', 'KKK...K', '.KKKKK.', '..KKK..']],
  bubble: [0, 1, ['.OOOOOOO.', 'OWWWWWWWO', 'OWGWGWGWO', 'OWWWWWWWO', '.OOOOOOO.', '..OO.....', '..O......']],
  size: [0, 2, ['.....OOOO', '.....OBBO', 'OOO..OBBO', 'OBO..OBBO', 'OOO..OOOO']],
  alert: [3, 2, BANG],
}
const iconStrip = new Uint8Array(ICON * Object.keys(ICONS).length * ICON * 4)
const iconNames = Object.keys(ICONS)
iconNames.forEach((name, i) => {
  const [x, y, rows] = ICONS[name]
  rows.forEach((row, r) => {
    ;[...row].forEach((ch, c) => {
      if (ch !== '.') iconStrip.set(COLORS[ch], ((y + r) * ICON * iconNames.length + i * ICON + x + c) * 4)
    })
  })
})
writeFileSync(join(out, 'icons.png'), png(ICON * iconNames.length, ICON, iconStrip))

const unique = []
const seen = new Map()
const manifest = {
  w: W,
  h: H,
  icon: ICON,
  icons: Object.fromEntries(iconNames.map((name, i) => [name, i])),
  anims: {},
}
for (const [name, frames] of Object.entries(ANIMS)) {
  manifest.anims[name] = frames.map(frame => {
    const img = draw(frame)
    const key = Buffer.from(img).toString('latin1')
    if (!seen.has(key)) {
      seen.set(key, unique.length)
      unique.push(img)
    }

    return [seen.get(key), frame.ms]
  })
}

const sheet = new Uint8Array(W * unique.length * H * 4)
unique.forEach((img, i) => {
  for (let y = 0; y < H; y++) {
    sheet.set(img.subarray(y * W * 4, (y + 1) * W * 4), (y * W * unique.length + i * W) * 4)
  }
})
writeFileSync(join(out, 'sheet.png'), png(W * unique.length, H, sheet))
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest))
console.log(`${Object.keys(ANIMS).length} animations, ${unique.length} frames`)

const previewAt = process.argv.indexOf('--preview')
if (previewAt > 0) {
  const SCALE = 5
  const reel = [
    ['waving', 1],
    ['idle', 1],
    ['thinking', 2],
    ['working-laptop', 2],
    ['working-book', 1],
    ['working-magnifier', 1],
    ['working-pencil', 2],
    ['happy', 3],
    ['asking', 3],
    ['mad', 4],
    ['loved', 2],
    ['munching', 1],
    ['held', 3],
    ['land', 1],
    ['oops', 2],
    ['asleep', 1],
  ]
  const frames = []
  for (const [name, loops] of reel) {
    for (let loop = 0; loop < loops; loop++) {
      for (const frame of ANIMS[name]) {
        const img = draw(frame)
        const big = new Uint8Array(W * SCALE * H * SCALE * 4)
        for (let y = 0; y < H * SCALE; y++) {
          for (let x = 0; x < W * SCALE; x++) {
            const from = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4
            big.set(img.subarray(from, from + 4), (y * W * SCALE + x) * 4)
          }
        }
        frames.push({ rgba: big, ms: frame.ms })
      }
    }
  }
  writeFileSync(process.argv[previewAt + 1], apng(W * SCALE, H * SCALE, frames))
}

const contactAt = process.argv.indexOf('--contact')
if (contactAt > 0) {
  // Each animation's frames on a row, three times the size, on a dark and a light strip.
  const SCALE = 3
  const names = Object.keys(ANIMS)
  const across = Math.max(...names.map(n => ANIMS[n].length))
  const cw = across * W * SCALE
  const ch = names.length * H * SCALE
  const rgba = new Uint8Array(cw * ch * 4)
  names.forEach((name, row) => {
    const bg = row % 2 ? [38, 38, 36] : [250, 249, 245]
    for (let y = row * H * SCALE; y < (row + 1) * H * SCALE; y++) {
      for (let x = 0; x < cw; x++) rgba.set([...bg, 255], (y * cw + x) * 4)
    }
    ANIMS[name].forEach((frame, col) => {
      const img = draw(frame)
      for (let y = 0; y < H * SCALE; y++) {
        for (let x = 0; x < W * SCALE; x++) {
          const at = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4
          const a = img[at + 3] / 255
          if (!a) continue
          const to = ((row * H * SCALE + y) * cw + col * W * SCALE + x) * 4
          for (let c = 0; c < 3; c++) rgba[to + c] = img[at + c] * a + rgba[to + c] * (1 - a)
        }
      }
    })
  })
  writeFileSync(process.argv[contactAt + 1], png(cw, ch, rgba))
}
