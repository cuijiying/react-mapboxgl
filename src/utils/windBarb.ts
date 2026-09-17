import type { LidarDataset } from '@/utils/lidarCsvParser'

/** 中国气象局 / WMO 风羽：三角旗 20 m/s，长划 4 m/s，短划 2 m/s */
export interface WindBarbSymbols {
  flags: number
  longBarbs: number
  shortBarbs: number
}

export const WIND_BARB_SPEED_STEP = 2
export const WIND_BARB_MAX_SPEED = 40
export const WIND_BARB_ATLAS_COLS = 8
export const WIND_BARB_ATLAS_CELL = 128

const BARB_BLUE = '#0066FF'
const BARB_BLUE_BRIGHT = '#4DA3FF'
const BARB_OUTLINE = '#021433'

export function speedToBin(speedMps: number): number {
  if (!Number.isFinite(speedMps) || speedMps < 1) return 0
  return Math.min(
    WIND_BARB_MAX_SPEED,
    Math.round(speedMps / WIND_BARB_SPEED_STEP) * WIND_BARB_SPEED_STEP,
  )
}

export function speedToAtlasIndex(speedMps: number): number {
  return speedToBin(speedMps) / WIND_BARB_SPEED_STEP
}

export function atlasSlotCount(): number {
  return WIND_BARB_MAX_SPEED / WIND_BARB_SPEED_STEP + 1
}

export function decomposeWindSpeed(speed: number): WindBarbSymbols {
  let s = speedToBin(speed)
  const flags = Math.floor(s / 20)
  s -= flags * 20
  const longBarbs = Math.floor(s / 4)
  s -= longBarbs * 4
  const shortBarbs = Math.round(s / 2)
  return { flags, longBarbs, shortBarbs }
}

function paintBarb(
  ctx: CanvasRenderingContext2D,
  speedMps: number,
  size: number,
  color: string,
  widthScale: number,
  fill = true,
) {
  const cx = size / 2
  const cy = size / 2
  const staffLen = size * 0.38
  const barbLen = size * 0.16
  const staffWidth = Math.max(1.15, size * 0.02) * widthScale
  const tipY = cy - staffLen
  const { flags, longBarbs, shortBarbs } = decomposeWindSpeed(speedMps)

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = staffWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (speedToBin(speedMps) === 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, size * 0.072 * widthScale, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx, tipY)
  ctx.stroke()

  const pennantStep = staffLen * 0.24
  const barbStep = staffLen * 0.155
  const slantX = -Math.sin((68 * Math.PI) / 180)
  const slantY = Math.cos((68 * Math.PI) / 180)
  let cursor = 0
  const staffY = (offset: number) => tipY + offset

  for (let i = 0; i < flags; i++) {
    const y0 = staffY(cursor)
    const y1 = y0 + pennantStep * 0.88
    ctx.beginPath()
    ctx.moveTo(cx, y0)
    ctx.lineTo(cx + slantX * barbLen, y0 + slantY * barbLen * 0.52)
    ctx.lineTo(cx, y1)
    ctx.closePath()
    if (fill) ctx.fill()
    ctx.stroke()
    cursor += pennantStep
  }

  const onlyHalfBarb = flags === 0 && longBarbs === 0 && shortBarbs === 1
  if (onlyHalfBarb) cursor += barbStep * 0.7

  for (let i = 0; i < longBarbs; i++) {
    const y = staffY(cursor)
    ctx.beginPath()
    ctx.moveTo(cx, y)
    ctx.lineTo(cx + slantX * barbLen, y + slantY * barbLen)
    ctx.stroke()
    cursor += barbStep
  }

  for (let i = 0; i < shortBarbs; i++) {
    const y = staffY(cursor)
    ctx.beginPath()
    ctx.moveTo(cx, y)
    ctx.lineTo(cx + slantX * barbLen * 0.55, y + slantY * barbLen * 0.55)
    ctx.stroke()
    cursor += barbStep
  }
}

/** 北半球标准风杆：杆朝上（北），风羽在左侧并向测站倾斜 */
export function drawWindBarb(
  ctx: CanvasRenderingContext2D,
  speedMps: number,
  size: number,
) {
  ctx.clearRect(0, 0, size, size)
  ctx.save()

  ctx.shadowColor = 'rgba(0, 80, 255, 0.4)'
  ctx.shadowBlur = size * 0.045
  paintBarb(ctx, speedMps, size, BARB_BLUE, 1.05)
  ctx.shadowBlur = 0

  paintBarb(ctx, speedMps, size, BARB_OUTLINE, 1.25, false)
  paintBarb(ctx, speedMps, size, BARB_BLUE, 0.95)
  paintBarb(ctx, speedMps, size, BARB_BLUE_BRIGHT, 0.45, false)

  ctx.restore()
}

export function createWindBarbAtlas(): {
  canvas: HTMLCanvasElement
  cols: number
  rows: number
  cell: number
} {
  const cell = WIND_BARB_ATLAS_CELL
  const cols = WIND_BARB_ATLAS_COLS
  const count = atlasSlotCount()
  const rows = Math.ceil(count / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * cell
  canvas.height = rows * cell
  const ctx = canvas.getContext('2d')
  if (!ctx) return { canvas, cols, rows, cell }

  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    ctx.save()
    ctx.translate(col * cell, row * cell)
    drawWindBarb(ctx, i * WIND_BARB_SPEED_STEP, cell)
    ctx.restore()
  }

  return { canvas, cols, rows, cell }
}

const BARB_QUAD_CORNERS: Array<[number, number]> = [
  [-1, 1],
  [-1, -1],
  [1, 1],
  [1, 1],
  [-1, -1],
  [1, -1],
]

export const BARB_QUAD_FLOATS = 15

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1
  return [x / len, y / len, z / len]
}

/** 贴在 PPI 切平面上的风杆四边形：center / right / staff / normal / corner / bin */
export function buildBarbQuadBuffer(
  dataset: LidarDataset,
  origin: readonly [number, number, number],
  options: { azimuthStride?: number; distanceStride?: number } = {},
): Float32Array {
  const azimuthStride = options.azimuthStride ?? 1
  const distanceStride = options.distanceStride ?? 3
  const { metadata, validSamples, azimuths } = dataset
  const pickedAz = new Set(azimuths.filter((_, i) => i % azimuthStride === 0))
  const data: number[] = []

  for (const sample of validSamples) {
    if (!pickedAz.has(sample.azimuth)) continue
    const gate = Math.round((sample.distance - metadata.startRange) / metadata.rangeResolution)
    if (gate % distanceStride !== 0) continue
    if (sample.hWindDirection === null || sample.hWindSpeed === null) continue

    const radial = normalize3(
      sample.x - origin[0],
      sample.y - origin[1],
      sample.z - origin[2],
    )
    const azim = normalize3(-radial[1], radial[0], 0)
    const normal = normalize3(
      radial[1] * azim[2] - radial[2] * azim[1],
      radial[2] * azim[0] - radial[0] * azim[2],
      radial[0] * azim[1] - radial[1] * azim[0],
    )

    const dirRad = (sample.hWindDirection * Math.PI) / 180
    let fx = Math.sin(dirRad)
    let fy = -Math.cos(dirRad)
    let fz = 0
    const alongNormal = fx * normal[0] + fy * normal[1] + fz * normal[2]
    fx -= alongNormal * normal[0]
    fy -= alongNormal * normal[1]
    fz -= alongNormal * normal[2]
    const staff = normalize3(fx, fy, fz)
    const right = normalize3(
      staff[1] * normal[2] - staff[2] * normal[1],
      staff[2] * normal[0] - staff[0] * normal[2],
      staff[0] * normal[1] - staff[1] * normal[0],
    )
    const bin = speedToAtlasIndex(sample.hWindSpeed)

    for (const [cx, cy] of BARB_QUAD_CORNERS) {
      data.push(
        sample.x,
        sample.y,
        sample.z,
        right[0],
        right[1],
        right[2],
        staff[0],
        staff[1],
        staff[2],
        normal[0],
        normal[1],
        normal[2],
        cx,
        cy,
        bin,
      )
    }
  }

  return new Float32Array(data)
}
