/**
 * gridContour.ts
 *
 * 格点等值线 / 等值面 GeoJSON 生成。
 * - 等值线：Marching Squares → 合并 → Chaikin 平滑
 * - 等值面：格点上采样 → 格点并集拓扑 → 边界边 MS 插值 → Catmull-Rom 重采样
 */

import type { ColorStop, GridData } from '@/layers/GridLayer2'

type Position = [number, number]
type Ring = Position[]
type LineString = Position[]

const COORD_PRECISION = 5

/** Marching Squares 线段表（非 saddle 情形） */
const MS_SEGMENTS: number[][] = [
  [], [0, 3], [1, 0], [1, 3], [2, 1], [0, 3, 2, 1], [2, 0], [2, 3],
  [3, 2], [0, 2], [1, 0, 3, 2], [1, 2], [1, 3], [0, 1], [0, 3], []
]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getCellValue(data: GridData, row: number, col: number): number {
  const r = clamp(row, 0, data.rows - 1)
  const c = clamp(col, 0, data.cols - 1)
  return data.values[r]?.[c] ?? 0
}

function cellCenter(data: GridData, row: number, col: number): Position {
  return [
    data.lonStart + (col + 0.5) * data.lonStep,
    data.latStart + (row + 0.5) * data.latStep
  ]
}

function vertexLonLat(data: GridData, col: number, row: number): Position {
  return [
    data.lonStart + col * data.lonStep,
    data.latStart + row * data.latStep
  ]
}

function rgbaToHex(color: [number, number, number, number]): string {
  const [r, g, b] = color
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function getStopForLevel(colorStops: ColorStop[], level: number): ColorStop {
  return colorStops.find((s) => s.value === level) ?? colorStops[0]!
}

function snapPoint(p: Position): Position {
  const f = 10 ** COORD_PRECISION
  return [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f]
}

function posKey(p: Position): string {
  const s = snapPoint(p)
  return `${s[0]},${s[1]}`
}

function interpolateEdge(
  v1: number,
  v2: number,
  level: number,
  p1: Position,
  p2: Position
): Position {
  if (Math.abs(v2 - v1) < 1e-9) {
    return snapPoint([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2])
  }
  const t = (level - v1) / (v2 - v1)
  return snapPoint([
    p1[0] + t * (p2[0] - p1[0]),
    p1[1] + t * (p2[1] - p1[1])
  ])
}

function edgePoint(
  level: number,
  edge: number,
  corners: [number, number, number, number],
  positions: [Position, Position, Position, Position]
): Position {
  const [bl, br, tr, tl] = corners
  switch (edge) {
    case 0:
      return interpolateEdge(bl, br, level, positions[0], positions[1])
    case 1:
      return interpolateEdge(br, tr, level, positions[1], positions[2])
    case 2:
      return interpolateEdge(tr, tl, level, positions[2], positions[3])
    default:
      return interpolateEdge(tl, bl, level, positions[3], positions[0])
  }
}

/** 解析 saddle 歧义（case 5 / 10） */
function resolveMsEdges(
  caseIndex: number,
  bl: number,
  br: number,
  tr: number,
  tl: number,
  level: number
): number[] {
  if (caseIndex !== 5 && caseIndex !== 10) {
    return MS_SEGMENTS[caseIndex] ?? []
  }
  const center = (bl + br + tr + tl) / 4
  if (caseIndex === 5) {
    return center >= level ? [0, 3, 1, 2] : [0, 1, 2, 3]
  }
  return center >= level ? [1, 2, 3, 0] : [1, 0, 2, 3]
}

function mergeSegments(segments: [Position, Position][]): LineString[] {
  if (segments.length === 0) return []

  const normalized: [Position, Position][] = segments
    .map(([a, b]) => [snapPoint(a), snapPoint(b)] as [Position, Position])
    .filter(([a, b]) => posKey(a) !== posKey(b))

  const unused = new Set(normalized.map((_, i) => i))
  const lines: LineString[] = []

  while (unused.size > 0) {
    const firstIdx = unused.values().next().value as number
    unused.delete(firstIdx)

    const [startA, startB] = normalized[firstIdx]!
    const line: Position[] = [startA, startB]

    let extended = true
    while (extended) {
      extended = false
      const lastKey = posKey(line[line.length - 1]!)
      for (const i of unused) {
        const [c, d] = normalized[i]!
        if (posKey(c) === lastKey) {
          line.push(d)
          unused.delete(i)
          extended = true
          break
        }
        if (posKey(d) === lastKey) {
          line.push(c)
          unused.delete(i)
          extended = true
          break
        }
      }
    }

    extended = true
    while (extended) {
      extended = false
      const firstKey = posKey(line[0]!)
      for (const i of unused) {
        const [c, d] = normalized[i]!
        if (posKey(d) === firstKey) {
          line.unshift(c)
          unused.delete(i)
          extended = true
          break
        }
        if (posKey(c) === firstKey) {
          line.unshift(d)
          unused.delete(i)
          extended = true
          break
        }
      }
    }

    if (line.length >= 2) {
      lines.push(deduplicateConsecutive(line))
    }
  }

  return lines
}

function deduplicateConsecutive(line: LineString): LineString {
  if (line.length <= 1) return line
  const out: LineString = [line[0]!]
  for (let i = 1; i < line.length; i++) {
    if (posKey(line[i]!) !== posKey(out[out.length - 1]!)) {
      out.push(line[i]!)
    }
  }
  return out
}

/** 将多条折线再合并（同值级内部二次合并） */
function mergePolylines(lines: LineString[]): LineString[] {
  const segments: [Position, Position][] = []
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      segments.push([line[i]!, line[i + 1]!])
    }
  }
  return mergeSegments(segments)
}

function collectThresholdSegments(data: GridData, level: number): [Position, Position][] {
  const segments: [Position, Position][] = []

  for (let row = 0; row < data.rows - 1; row++) {
    for (let col = 0; col < data.cols - 1; col++) {
      const bl = getCellValue(data, row, col)
      const br = getCellValue(data, row, col + 1)
      const tr = getCellValue(data, row + 1, col + 1)
      const tl = getCellValue(data, row + 1, col)

      const corners: [number, number, number, number] = [bl, br, tr, tl]
      const positions: [Position, Position, Position, Position] = [
        vertexLonLat(data, col, row),
        vertexLonLat(data, col + 1, row),
        vertexLonLat(data, col + 1, row + 1),
        vertexLonLat(data, col, row + 1)
      ]

      const caseIndex =
        (bl >= level ? 1 : 0) |
        (br >= level ? 2 : 0) |
        (tr >= level ? 4 : 0) |
        (tl >= level ? 8 : 0)

      const edgeList = resolveMsEdges(caseIndex, bl, br, tr, tl, level)
      for (let i = 0; i + 1 < edgeList.length; i += 2) {
        segments.push([
          edgePoint(level, edgeList[i]!, corners, positions),
          edgePoint(level, edgeList[i + 1]!, corners, positions)
        ])
      }
    }
  }

  return segments
}

function lineLengthDeg(line: LineString): number {
  let len = 0
  for (let i = 1; i < line.length; i++) {
    len += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1])
  }
  return len
}

/** 等值线弧长中点（用于唯一标注） */
function lineLabelPoint(line: LineString): Position {
  if (line.length <= 1) return line[0]!
  const total = lineLengthDeg(line)
  if (total < 1e-9) return line[0]!

  let half = total / 2
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!
    const b = line[i]!
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (half <= seg) {
      const t = half / seg
      return snapPoint([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    }
    half -= seg
  }
  return line[Math.floor(line.length / 2)]!
}

function edgeKeyUndirected(p1: Position, p2: Position): string {
  const k1 = posKey(p1)
  const k2 = posKey(p2)
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
}

/** 沿边界边逐段追踪闭合环，每条边仅走一次，避免错误合并导致缠绕 */
function traceClosedRings(segments: [Position, Position][]): Ring[] {
  if (segments.length === 0) return []

  const adj = new Map<string, Position[]>()
  for (const [a, b] of segments) {
    const ka = posKey(a)
    const kb = posKey(b)
    if (!adj.has(ka)) adj.set(ka, [])
    if (!adj.has(kb)) adj.set(kb, [])
    adj.get(ka)!.push(b)
    adj.get(kb)!.push(a)
  }

  const edgeUsed = new Set<string>()
  const rings: Ring[] = []

  for (const [startA, startB] of segments) {
    const firstEdgeKey = edgeKeyUndirected(startA, startB)
    if (edgeUsed.has(firstEdgeKey)) continue

    const ring: Position[] = [startA, startB]
    edgeUsed.add(firstEdgeKey)

    let prev = startA
    let cur = startB
    let guard = 0

    while (guard++ < segments.length + 2) {
      if (posKey(cur) === posKey(ring[0]!) && ring.length >= 3) break

      const neighbors = adj.get(posKey(cur)) ?? []
      let next: Position | null = null

      for (const candidate of neighbors) {
        const ek = edgeKeyUndirected(cur, candidate)
        if (edgeUsed.has(ek)) continue
        if (posKey(candidate) === posKey(prev)) continue
        next = candidate
        break
      }

      if (!next) break

      edgeUsed.add(edgeKeyUndirected(cur, next))
      ring.push(next)
      prev = cur
      cur = next
    }

    if (ring.length >= 3) {
      const closed =
        posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
          ? ring
          : [...ring, ring[0]!]
      if (closed.length >= 4) rings.push(closed)
    }
  }

  return rings
}

function cellEdgeEndpoints(
  gridData: GridData,
  row: number,
  col: number,
  edge: 0 | 1 | 2 | 3
): [Position, Position] {
  const lon0 = gridData.lonStart + col * gridData.lonStep
  const lon1 = gridData.lonStart + (col + 1) * gridData.lonStep
  const lat0 = gridData.latStart + row * gridData.latStep
  const lat1 = gridData.latStart + (row + 1) * gridData.latStep

  switch (edge) {
    case 0:
      return [snapPoint([lon0, lat0]), snapPoint([lon1, lat0])]
    case 1:
      return [snapPoint([lon1, lat0]), snapPoint([lon1, lat1])]
    case 2:
      return [snapPoint([lon1, lat1]), snapPoint([lon0, lat1])]
    case 3:
      return [snapPoint([lon0, lat1]), snapPoint([lon0, lat0])]
  }
}

function neighborCellForEdge(
  gridData: GridData,
  row: number,
  col: number,
  edge: 0 | 1 | 2 | 3
): { row: number; col: number } | null {
  switch (edge) {
    case 0:
      return row > 0 ? { row: row - 1, col } : null
    case 1:
      return col < gridData.cols - 1 ? { row, col: col + 1 } : null
    case 2:
      return row < gridData.rows - 1 ? { row: row + 1, col } : null
    case 3:
      return col > 0 ? { row, col: col - 1 } : null
  }
}

interface TaggedBoundaryEdge {
  a: Position
  b: Position
  inRow: number
  inCol: number
  edge: 0 | 1 | 2 | 3
}

/** 收集 band 内 cell 的外边界边（带归属 cell 信息，拓扑严格正确） */
function collectCellUnionBoundaryEdges(
  gridData: GridData,
  inBand: (v: number) => boolean
): TaggedBoundaryEdge[] {
  const edgeCounts = new Map<string, { info: TaggedBoundaryEdge; count: number }>()

  for (let row = 0; row < gridData.rows; row++) {
    for (let col = 0; col < gridData.cols; col++) {
      if (!inBand(getCellValue(gridData, row, col))) continue

      for (let edge = 0; edge < 4; edge++) {
        const [a, b] = cellEdgeEndpoints(gridData, row, col, edge as 0 | 1 | 2 | 3)
        const key = edgeKeyUndirected(a, b)
        const info: TaggedBoundaryEdge = {
          a,
          b,
          inRow: row,
          inCol: col,
          edge: edge as 0 | 1 | 2 | 3
        }
        const existing = edgeCounts.get(key)
        if (existing) existing.count++
        else edgeCounts.set(key, { info, count: 1 })
      }
    }
  }

  const boundary: TaggedBoundaryEdge[] = []
  for (const { info, count } of edgeCounts.values()) {
    if (count === 1) boundary.push(info)
  }
  return boundary
}

/** 在格点并集边界边上，按 in/out 格点值在 lo/hi 处插值 */
function crossingOnBoundaryEdge(
  gridData: GridData,
  tagged: TaggedBoundaryEdge,
  lo: number,
  hi: number,
  isOpenTop: boolean
): Position {
  const { a, b, inRow, inCol } = tagged
  const inVal = getCellValue(gridData, inRow, inCol)
  const neighbor = neighborCellForEdge(gridData, inRow, inCol, tagged.edge)
  const outVal = neighbor
    ? getCellValue(gridData, neighbor.row, neighbor.col)
    : lo - 1

  const level =
    isOpenTop || !Number.isFinite(hi)
      ? lo
      : outVal < lo
        ? lo
        : hi

  const inCenter = cellCenter(gridData, inRow, inCol)
  const distAIn = Math.hypot(a[0] - inCenter[0], a[1] - inCenter[1])
  const distBIn = Math.hypot(b[0] - inCenter[0], b[1] - inCenter[1])
  const pOut = distAIn >= distBIn ? a : b
  const pIn = distAIn >= distBIn ? b : a

  if (Math.abs(inVal - outVal) > 1e-12) {
    return interpolateEdge(outVal, inVal, level, pOut, pIn)
  }

  return snapPoint([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
}

/**
 * 格点并集提取边界环，并将每条轴对齐边替换为 lo/hi 插值点（平滑且拓扑正确）。
 */
function buildSmoothBandRingsFromCellUnion(
  gridData: GridData,
  inBand: (v: number) => boolean,
  lo: number,
  hi: number,
  isOpenTop: boolean
): Ring[] {
  const boundaryEdges = collectCellUnionBoundaryEdges(gridData, inBand)
  if (boundaryEdges.length === 0) return []

  const crossingByKey = new Map<string, Position>()
  for (const edge of boundaryEdges) {
    crossingByKey.set(
      edgeKeyUndirected(edge.a, edge.b),
      crossingOnBoundaryEdge(gridData, edge, lo, hi, isOpenTop)
    )
  }

  const gridRings = traceClosedRings(boundaryEdges.map((e) => [e.a, e.b]))
  const smoothRings: Ring[] = []

  for (const gridRing of gridRings) {
    const smooth = buildSmoothRingFromGridRing(gridRing, crossingByKey)
    if (smooth.length >= 4) smoothRings.push(smooth)
  }

  return smoothRings
}

/** 格点并集轴对齐边界（无插值，拓扑严格正确，作自交回退） */
function buildGridBandRingsFromCellUnion(
  gridData: GridData,
  inBand: (v: number) => boolean
): Ring[] {
  const boundaryEdges = collectCellUnionBoundaryEdges(gridData, inBand)
  if (boundaryEdges.length === 0) return []
  return traceClosedRings(boundaryEdges.map((e) => [e.a, e.b])).filter((ring) => ring.length >= 4)
}

function pushUniquePoint(out: Position[], p: Position): void {
  if (out.length === 0 || posKey(p) !== posKey(out[out.length - 1]!)) {
    out.push(p)
  }
}

/** 凹角处保留格点转角，凸角处仅连插值点，避免跨角连线自交 */
function buildSmoothRingFromGridRing(
  gridRing: Ring,
  crossingByKey: Map<string, Position>
): Ring {
  const closed =
    gridRing.length > 1 && posKey(gridRing[0]!) === posKey(gridRing[gridRing.length - 1]!)
      ? gridRing.slice(0, -1)
      : gridRing
  if (closed.length < 3) return gridRing

  const ccw = signedArea(gridRing) > 0
  const n = closed.length
  const smooth: Position[] = []

  for (let i = 0; i < n; i++) {
    const prev = closed[(i - 1 + n) % n]!
    const cur = closed[i]!
    const next = closed[(i + 1) % n]!

    const cross = orient(prev, cur, next)
    const concave = ccw ? cross < -1e-12 : cross > 1e-12
    if (concave) pushUniquePoint(smooth, cur)

    const crossing = crossingByKey.get(edgeKeyUndirected(cur, next))
    if (crossing) pushUniquePoint(smooth, crossing)
  }

  if (smooth.length < 3) return gridRing
  return [...smooth.map(snapPoint), snapPoint(smooth[0]!)]
}

function ringCentroid(ring: Ring): Position {
  const pts =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
      ? ring.slice(0, -1)
      : ring
  if (pts.length === 0) return ring[0] ?? [0, 0]
  let lon = 0
  let lat = 0
  for (const p of pts) {
    lon += p[0]
    lat += p[1]
  }
  return [lon / pts.length, lat / pts.length]
}

function signedArea(ring: Ring): number {
  const pts =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
      ? ring.slice(0, -1)
      : ring
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[(i + 1) % pts.length]!
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

function reverseRing(ring: Ring): Ring {
  const closed =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
  const pts = closed ? ring.slice(0, -1).reverse() : [...ring].reverse()
  return closed ? [...pts.map(snapPoint), snapPoint(pts[0]!)] : pts.map(snapPoint)
}

/** GeoJSON 外环 CCW、孔洞 CW */
function ensureWinding(ring: Ring, ccw: boolean): Ring {
  const area = signedArea(ring)
  const isCcw = area > 0
  if (ccw === isCcw) return ring.map(snapPoint) as Ring
  return reverseRing(ring)
}

function pointInRing(point: Position, ring: Ring): boolean {
  const [x, y] = point
  const pts =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
      ? ring.slice(0, -1)
      : ring

  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-18) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function ringBBox(
  ring: Ring
): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  const pts =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
      ? ring.slice(0, -1)
      : ring
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const p of pts) {
    minLon = Math.min(minLon, p[0])
    maxLon = Math.max(maxLon, p[0])
    minLat = Math.min(minLat, p[1])
    maxLat = Math.max(maxLat, p[1])
  }
  return { minLon, maxLon, minLat, maxLat }
}

/** 环内是否包含 band 格点（比环心点判定更可靠，避免 ≥40 等开放顶档被误判为孔洞） */
function ringEnclosesBand(
  gridData: GridData,
  ring: Ring,
  inBand: (v: number) => boolean
): boolean {
  const { minLon, maxLon, minLat, maxLat } = ringBBox(ring)
  const row0 = clamp(
    Math.floor((minLat - gridData.latStart) / gridData.latStep),
    0,
    gridData.rows - 1
  )
  const row1 = clamp(
    Math.ceil((maxLat - gridData.latStart) / gridData.latStep) - 1,
    0,
    gridData.rows - 1
  )
  const col0 = clamp(
    Math.floor((minLon - gridData.lonStart) / gridData.lonStep),
    0,
    gridData.cols - 1
  )
  const col1 = clamp(
    Math.ceil((maxLon - gridData.lonStart) / gridData.lonStep) - 1,
    0,
    gridData.cols - 1
  )

  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const center = cellCenter(gridData, row, col)
      if (!pointInRing(center, ring)) continue
      if (inBand(getCellValue(gridData, row, col))) return true
    }
  }
  return false
}

interface RingInfo {
  ring: Ring
  enclosesBand: boolean
  area: number
  centroid: Position
}

/** 将多个环组装为带孔洞的 Polygon 列表，避免孔洞被误作独立面导致重叠 */
function assembleBandPolygons(
  rings: Ring[],
  gridData: GridData,
  inBand: (v: number) => boolean
): Ring[][] {
  if (rings.length === 0) return []

  const infos: RingInfo[] = rings.map((ring) => ({
    ring,
    enclosesBand: ringEnclosesBand(gridData, ring, inBand),
    area: signedArea(ring),
    centroid: ringCentroid(ring)
  }))

  const outers = infos.filter((i) => i.enclosesBand)
  const holes = infos.filter((i) => !i.enclosesBand)

  if (outers.length === 0) return []

  const holesByOuter = new Map<RingInfo, RingInfo[]>()
  for (const outer of outers) holesByOuter.set(outer, [])

  for (const hole of holes) {
    let bestOuter: RingInfo | null = null
    let bestArea = Infinity
    for (const outer of outers) {
      if (!pointInRing(hole.centroid, outer.ring)) continue
      const absArea = Math.abs(outer.area)
      if (absArea < bestArea) {
        bestOuter = outer
        bestArea = absArea
      }
    }
    if (bestOuter) holesByOuter.get(bestOuter)!.push(hole)
  }

  const islandOuters = new Set<RingInfo>()
  for (const outer of outers) {
    for (const hole of holes) {
      if (pointInRing(outer.centroid, hole.ring)) {
        islandOuters.add(outer)
        break
      }
    }
  }

  const polygons: Ring[][] = []
  for (const outer of outers) {
    if (ringSelfIntersects(outer.ring)) continue

    if (islandOuters.has(outer)) {
      polygons.push([ensureWinding(outer.ring, true)])
      continue
    }
    const holeList = (holesByOuter.get(outer) ?? []).filter((h) => !ringSelfIntersects(h.ring))
    polygons.push([
      ensureWinding(outer.ring, true),
      ...holeList.map((h) => ensureWinding(h.ring, false))
    ])
  }

  return polygons
}

function orient(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: Position, b: Position, c: Position): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= c[1] &&
    c[1] <= Math.max(a[1], b[1]) + 1e-12
  )
}

function segmentsProperIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)

  if (o1 * o2 < 0 && o3 * o4 < 0) return true
  if (Math.abs(o1) < 1e-12 && onSegment(a, b, c)) return true
  if (Math.abs(o2) < 1e-12 && onSegment(a, b, d)) return true
  if (Math.abs(o3) < 1e-12 && onSegment(c, d, a)) return true
  if (Math.abs(o4) < 1e-12 && onSegment(c, d, b)) return true
  return false
}

function ringSelfIntersects(ring: Ring): boolean {
  const pts =
    ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
      ? ring.slice(0, -1)
      : ring
  const n = pts.length
  if (n < 4) return false

  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue
      const c = pts[j]!
      const d = pts[(j + 1) % n]!
      if (segmentsProperIntersect(a, b, c, d)) return true
    }
  }
  return false
}

/** 双线性插值采样格点场 */
function sampleGridBilinear(data: GridData, fRow: number, fCol: number): number {
  const r0 = clamp(Math.floor(fRow), 0, data.rows - 1)
  const c0 = clamp(Math.floor(fCol), 0, data.cols - 1)
  const r1 = Math.min(r0 + 1, data.rows - 1)
  const c1 = Math.min(c0 + 1, data.cols - 1)
  const tr = fRow - r0
  const tc = fCol - c0

  const v00 = getCellValue(data, r0, c0)
  const v01 = getCellValue(data, r0, c1)
  const v10 = getCellValue(data, r1, c0)
  const v11 = getCellValue(data, r1, c1)

  return (
    v00 * (1 - tr) * (1 - tc) +
    v01 * (1 - tr) * tc +
    v10 * tr * (1 - tc) +
    v11 * tr * tc
  )
}

/** 上采样格点（双线性插值），细化边界阶梯 */
function upsampleGridData(data: GridData, factor: number): GridData {
  if (factor <= 1) return data

  const newRows = data.rows * factor
  const newCols = data.cols * factor
  const values: number[][] = []

  for (let row = 0; row < newRows; row++) {
    const rowData: number[] = []
    for (let col = 0; col < newCols; col++) {
      rowData.push(sampleGridBilinear(data, row / factor, col / factor))
    }
    values.push(rowData)
  }

  return {
    lonStart: data.lonStart,
    latStart: data.latStart,
    lonStep: data.lonStep / factor,
    latStep: data.latStep / factor,
    rows: newRows,
    cols: newCols,
    values
  }
}

export interface ContourGenerateOptions {
  filterMin?: number
  filterMax?: number
  /** 等值线 Chaikin 平滑迭代次数，默认 2 */
  smoothIterations?: number
  /** 等值面 Catmull-Rom 每段采样数，0 = 仅 MS 插值边界，默认 0 */
  bandSmoothIterations?: number
  /** 等值面边界提取前的格点上采样倍数，默认 4 */
  bandUpsampleFactor?: number
}

/** 移除共线冗余点，减少格点阶梯上的多余顶点 */
function removeCollinear(line: LineString, closed = false): LineString {
  if (line.length <= 2) return line

  const pts = closed && line.length > 1 && posKey(line[0]!) === posKey(line[line.length - 1]!)
    ? line.slice(0, -1)
    : line

  if (pts.length <= 2) return line

  const keep = (i: number): boolean => {
    const n = pts.length
    const prev = pts[(i - 1 + n) % n]!
    const curr = pts[i]!
    const next = pts[(i + 1) % n]!
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) -
      (curr[1] - prev[1]) * (next[0] - curr[0])
    return Math.abs(cross) > 1e-10
  }

  if (closed) {
    const out = pts.filter((_, i) => keep(i))
    if (out.length < 3) return line
    return [...out.map(snapPoint), snapPoint(out[0]!)]
  }

  const out: LineString = [pts[0]!]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1]!
    const curr = pts[i]!
    const next = pts[i + 1]!
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) -
      (curr[1] - prev[1]) * (next[0] - curr[0])
    if (Math.abs(cross) > 1e-10) out.push(curr)
  }
  out.push(pts[pts.length - 1]!)
  return out.map(snapPoint)
}

function pointToSegmentDistance(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function douglasPeuckerOpen(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points

  let maxDist = 0
  let maxIdx = 0
  const start = points[0]!
  const end = points[points.length - 1]!

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentDistance(points[i]!, start, end)
    if (d > maxDist) {
      maxDist = d
      maxIdx = i
    }
  }

  if (maxDist <= tolerance) return [start, end]

  const left = douglasPeuckerOpen(points.slice(0, maxIdx + 1), tolerance)
  const right = douglasPeuckerOpen(points.slice(maxIdx), tolerance)
  return [...left.slice(0, -1), ...right]
}

function douglasPeuckerClosed(ring: Ring, tolerance: number): Ring {
  const isClosed = ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
  const pts = isClosed ? ring.slice(0, -1) : [...ring]
  if (pts.length < 4) return ring

  let maxDist = 0
  let splitIdx = 0
  const a = pts[0]!
  const b = pts[Math.floor(pts.length / 2)]!

  for (let i = 1; i < pts.length; i++) {
    const d = pointToSegmentDistance(pts[i]!, a, b)
    if (d > maxDist) {
      maxDist = d
      splitIdx = i
    }
  }

  if (maxDist <= tolerance) {
    return [a, b, a].map(snapPoint) as Ring
  }

  const rotated = [...pts.slice(splitIdx), ...pts.slice(0, splitIdx + 1)]
  const simplified = douglasPeuckerOpen(rotated, tolerance)
  if (simplified.length < 3) return ring

  const closed =
    posKey(simplified[0]!) === posKey(simplified[simplified.length - 1]!)
      ? simplified
      : [...simplified, simplified[0]!]
  return closed.map(snapPoint) as Ring
}

function catmullRomPoint(p0: Position, p1: Position, p2: Position, p3: Position, t: number): Position {
  const t2 = t * t
  const t3 = t2 * t
  return [
    0.5 *
      (2 * p1[0] +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
  ]
}

function catmullRomClosed(ring: Ring, subdivisions: number): Ring {
  const isClosed = ring.length > 1 && posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
  const pts = isClosed ? ring.slice(0, -1) : ring
  if (pts.length < 3) return ring

  const n = pts.length
  const subs = Math.max(2, subdivisions)
  const result: Position[] = []

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!
    const p1 = pts[i]!
    const p2 = pts[(i + 1) % n]!
    const p3 = pts[(i + 2) % n]!
    for (let j = 0; j < subs; j++) {
      result.push(snapPoint(catmullRomPoint(p0, p1, p2, p3, j / subs)))
    }
  }

  if (result.length < 3) return ring
  return [...result, result[0]!]
}

/** 校验并净化 band 环：自交时回退格点边界，可选轻度样条 */
function sanitizeBandRing(
  smooth: Ring,
  gridFallback: Ring | undefined,
  splineSubdivisions: number
): Ring | null {
  let ring = deduplicateConsecutive(smooth)
  if (ring.length < 4 && gridFallback) ring = gridFallback
  if (ring.length < 4) return null

  if (splineSubdivisions > 0 && !ringSelfIntersects(ring)) {
    const subs = Math.min(3, Math.max(2, splineSubdivisions))
    const smoothed = catmullRomClosed(ring, subs)
    if (!ringSelfIntersects(smoothed)) ring = smoothed
  }

  if (ringSelfIntersects(ring)) {
    ring = gridFallback ? deduplicateConsecutive(gridFallback) : ring
  }
  if (ring.length < 4 || ringSelfIntersects(ring)) return null
  return ring
}

/** Chaikin 角切割平滑（开放折线） */
function chaikinSmoothOpen(line: LineString, iterations: number): LineString {
  if (iterations <= 0 || line.length < 3) return line

  let pts = line
  for (let iter = 0; iter < iterations; iter++) {
    const next: LineString = [pts[0]!]
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!
      const p1 = pts[i + 1]!
      next.push(
        snapPoint([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]),
        snapPoint([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]])
      )
    }
    next.push(pts[pts.length - 1]!)
    pts = next
  }
  return pts
}

/** Chaikin 角切割平滑（闭合环） */
function chaikinSmoothClosed(ring: Ring, iterations: number): Ring {
  if (iterations <= 0 || ring.length < 4) return ring

  const isClosed = posKey(ring[0]!) === posKey(ring[ring.length - 1]!)
  let pts = isClosed ? ring.slice(0, -1) : ring
  if (pts.length < 3) return ring

  for (let iter = 0; iter < iterations; iter++) {
    const next: Position[] = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const p0 = pts[i]!
      const p1 = pts[(i + 1) % n]!
      next.push(
        snapPoint([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]),
        snapPoint([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]])
      )
    }
    pts = next
  }

  return [...pts, pts[0]!].map(snapPoint)
}

function smoothLineString(line: LineString, iterations: number): LineString {
  if (iterations <= 0) return line
  const simplified = removeCollinear(line, false)
  return chaikinSmoothOpen(simplified, iterations)
}

/** 生成等值线 GeoJSON：同值级线段合并为连续 LineString，每线一个标注点 */
export function generateContourLinesGeoJSON(
  gridData: GridData,
  colorStops: ColorStop[],
  options: ContourGenerateOptions = {}
): GeoJSON.FeatureCollection {
  const { filterMin = -Infinity, filterMax = Infinity, smoothIterations = 2 } = options
  const sorted = [...colorStops].sort((a, b) => a.value - b.value)
  const features: GeoJSON.Feature[] = []

  const minStop = sorted[0]!.value

  // 色标节点对应等值线（排除最低档下界，含最高档上界 40）
  const levels = sorted
    .map((s) => s.value)
    .filter((v) => v > minStop)
    .filter((v) => v >= filterMin && v <= filterMax)

  for (const level of levels) {
    const stop = getStopForLevel(sorted, level)
    const segments = collectThresholdSegments(gridData, level)
    const lines = mergePolylines(mergeSegments(segments))

    for (const raw of lines) {
      if (raw.length < 2) continue
      const coordinates = smoothLineString(raw, smoothIterations)
      features.push({
        type: 'Feature',
        properties: {
          value: level,
          label: `${level}`,
          lineColor: rgbaToHex(stop.color),
          labelPoint: lineLabelPoint(coordinates)
        },
        geometry: { type: 'LineString', coordinates }
      })
    }
  }

  return { type: 'FeatureCollection', features }
}

export interface BandMeta {
  value: number
  valueMax: number
  label: string
  fillColor: string
  centroid: Position
}

/** 生成等值面 GeoJSON：每个温度间隔合并为一个 MultiPolygon Feature */
export function generateContourBandsGeoJSON(
  gridData: GridData,
  colorStops: ColorStop[],
  options: ContourGenerateOptions = {}
): { collection: GeoJSON.FeatureCollection; bandMetas: BandMeta[] } {
  const {
    filterMin = -Infinity,
    filterMax = Infinity,
    bandSmoothIterations = 0,
    bandUpsampleFactor = 4
  } = options
  const sorted = [...colorStops].sort((a, b) => a.value - b.value)
  const features: GeoJSON.Feature[] = []
  const bandMetas: BandMeta[] = []

  const bandGrid = upsampleGridData(gridData, bandUpsampleFactor)

  const pushBand = (
    lo: ColorStop,
    hi: ColorStop | null,
    bandIndex: number,
    inBand: (v: number) => boolean,
    loLevel: number,
    hiLevel: number,
    isOpenTop: boolean
  ) => {
    let rings: Ring[]

    if (isOpenTop) {
      const smoothRings = buildSmoothBandRingsFromCellUnion(
        bandGrid,
        inBand,
        loLevel,
        loLevel,
        true
      )
      const gridRings = buildGridBandRingsFromCellUnion(bandGrid, inBand)
      rings = smoothRings
        .map((ring, i) => sanitizeBandRing(ring, gridRings[i], 0))
        .filter((ring): ring is Ring => ring !== null)
    } else {
      const smoothRings = buildSmoothBandRingsFromCellUnion(
        bandGrid,
        inBand,
        loLevel,
        hiLevel,
        false
      )
      const gridRings = buildGridBandRingsFromCellUnion(bandGrid, inBand)
      rings = smoothRings
        .map((ring, i) => sanitizeBandRing(ring, gridRings[i], bandSmoothIterations))
        .filter((ring): ring is Ring => ring !== null)
    }

    if (rings.length === 0) return

    const bandPolygons = assembleBandPolygons(rings, bandGrid, inBand)
    if (bandPolygons.length === 0) return

    let sumLon = 0
    let sumLat = 0
    let cellCount = 0
    for (let row = 0; row < gridData.rows; row++) {
      for (let col = 0; col < gridData.cols; col++) {
        if (!inBand(getCellValue(gridData, row, col))) continue
        const [cx, cy] = cellCenter(gridData, row, col)
        sumLon += cx
        sumLat += cy
        cellCount++
      }
    }
    if (cellCount === 0) return

    const valueMax = hi?.value ?? lo.value
    const label = hi ? `${lo.value} ~ ${hi.value}°C` : `≥ ${lo.value}°C`

    features.push({
      type: 'Feature',
      properties: {
        value: lo.value,
        valueMax,
        bandIndex,
        fillColor: rgbaToHex(lo.color)
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: bandPolygons
      }
    })

    bandMetas.push({
      value: lo.value,
      valueMax,
      label,
      fillColor: rgbaToHex(lo.color),
      centroid: [sumLon / cellCount, sumLat / cellCount]
    })
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!
    const hi = sorted[i + 1]!
    if (hi.value < filterMin || lo.value > filterMax) continue

    pushBand(
      lo,
      hi,
      i,
      (v) => v >= lo.value && v < hi.value,
      lo.value,
      hi.value,
      false
    )
  }

  // 图例最高档：≥ 末级色标值（如 ≥ 40°C）
  const top = sorted[sorted.length - 1]!
  if (top.value <= filterMax && top.value >= filterMin) {
    pushBand(
      top,
      null,
      sorted.length - 1,
      (v) => v >= top.value,
      top.value,
      top.value,
      true
    )
  }

  return { collection: { type: 'FeatureCollection', features }, bandMetas }
}

export interface ContourLabelOptions {
  lineFeatures: GeoJSON.Feature[]
  bandMetas?: BandMeta[]
  formatValue?: (value: number) => string
}

/** 每条等值线一个标注；每个等值面区间一个标注 */
export function generateContourLabelGeoJSON(
  options: ContourLabelOptions
): GeoJSON.FeatureCollection {
  const {
    lineFeatures,
    bandMetas = [],
    formatValue = (v) => String(Math.round(v * 10) / 10)
  } = options

  const features: GeoJSON.Feature[] = []

  for (const feature of lineFeatures) {
    if (feature.geometry.type !== 'LineString') continue
    const value = feature.properties?.value as number
    if (value === undefined) continue

    const labelPoint =
      (feature.properties?.labelPoint as Position | undefined) ??
      lineLabelPoint(feature.geometry.coordinates as LineString)

    features.push({
      type: 'Feature',
      properties: {
        value,
        label: formatValue(value),
        kind: 'line'
      },
      geometry: { type: 'Point', coordinates: labelPoint }
    })
  }

  for (const band of bandMetas) {
    features.push({
      type: 'Feature',
      properties: {
        value: band.value,
        label: band.label,
        kind: 'band'
      },
      geometry: { type: 'Point', coordinates: band.centroid }
    })
  }

  return { type: 'FeatureCollection', features }
}
