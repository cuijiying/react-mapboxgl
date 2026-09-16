import mapboxgl from 'mapbox-gl'

export const LIDAR_DATA_URL = '/data/lidar-ppi-sample.csv'
export const INVALID_VALUE = -9999

export interface LidarMetadata {
  model: string
  latitude: number
  longitude: number
  seaHeight: number
  northAngle: number
  scanMode: string
  azimuthFrom: number
  azimuthTo: number
  azimuthStep: number
  fixAngle: number
  startRange: number
  rangeResolution: number
  gate: number
  pulseWidth: number
  cnr: number
}

export interface LidarSample {
  azimuth: number
  pitch: number
  distance: number
  hWindSpeed: number | null
  hWindDirection: number | null
  vWindSpeed: number | null
  x: number
  y: number
  z: number
}

export interface LidarDataset {
  metadata: LidarMetadata
  samples: LidarSample[]
  validSamples: LidarSample[]
  azimuths: number[]
  maxDistance: number
  windSpeedMin: number
  windSpeedMax: number
}

function parseHeaderLine(line: string): LidarMetadata {
  const pairs = line.split(',')
  const map: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf(':')
    if (idx === -1) continue
    map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }

  return {
    model: map['Model'] ?? 'Unknown',
    latitude: Number(map['Latitude'] ?? 0),
    longitude: Number(map['Longtitude'] ?? map['Longitude'] ?? 0),
    seaHeight: Number(map['SeaHeight'] ?? 0),
    northAngle: Number(map['NorthAngle'] ?? 0),
    scanMode: map['ScanMode'] ?? 'PPI',
    azimuthFrom: Number(map['From'] ?? 0),
    azimuthTo: Number(map['To'] ?? 360),
    azimuthStep: Number(map['Step'] ?? 10),
    fixAngle: Number(map['FixAngle'] ?? 2),
    startRange: Number(map['StartRange'] ?? 15),
    rangeResolution: Number(map['RangeResolution'] ?? 30),
    gate: Number(map['Gate'] ?? 100),
    pulseWidth: Number(map['PulseWidth'] ?? 300),
    cnr: Number(map['CNR'] ?? 2),
  }
}

function toNullable(value: number): number | null {
  return value === INVALID_VALUE || Number.isNaN(value) ? null : value
}

export function polarToMercator(
  originLng: number,
  originLat: number,
  originAlt: number,
  azimuthDeg: number,
  pitchDeg: number,
  distanceM: number,
): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180

  const horizDist = distanceM * Math.cos(pitch)
  const up = distanceM * Math.sin(pitch)
  const east = horizDist * Math.sin(az)
  const north = horizDist * Math.cos(az)

  const origin = mapboxgl.MercatorCoordinate.fromLngLat([originLng, originLat], originAlt)
  const m = origin.meterInMercatorCoordinateUnits()

  return [origin.x + east * m, origin.y - north * m, origin.z + up * m]
}

export function parseLidarCsv(text: string): LidarDataset {
  const lines = text.trim().split(/\r?\n/)
  const metadata = parseHeaderLine(lines[0] ?? '')

  const samples: LidarSample[] = []
  const validSamples: LidarSample[] = []
  const azimuthSet = new Set<number>()
  let maxDistance = 0
  let windSpeedMin = Infinity
  let windSpeedMax = -Infinity

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (!line) continue

    const cols = line.split(',')
    if (cols.length < 10) continue

    const azimuth = Number(cols[4])
    const pitch = Number(cols[5])
    const distance = Number(cols[6])
    const hWindSpeed = toNullable(Number(cols[7]))
    const hWindDirection = toNullable(Number(cols[8]))
    const vWindSpeed = toNullable(Number(cols[9]))

    const [x, y, z] = polarToMercator(
      metadata.longitude,
      metadata.latitude,
      metadata.seaHeight,
      azimuth,
      pitch,
      distance,
    )

    const sample: LidarSample = {
      azimuth,
      pitch,
      distance,
      hWindSpeed,
      hWindDirection,
      vWindSpeed,
      x,
      y,
      z,
    }

    samples.push(sample)
    azimuthSet.add(azimuth)
    maxDistance = Math.max(maxDistance, distance)

    if (hWindSpeed !== null) {
      validSamples.push(sample)
      windSpeedMin = Math.min(windSpeedMin, hWindSpeed)
      windSpeedMax = Math.max(windSpeedMax, hWindSpeed)
    }
  }

  if (!Number.isFinite(windSpeedMin)) {
    windSpeedMin = 0
    windSpeedMax = 5
  }

  return {
    metadata,
    samples,
    validSamples,
    azimuths: [...azimuthSet].sort((a, b) => a - b),
    maxDistance,
    windSpeedMin,
    windSpeedMax,
  }
}

export async function loadLidarDataset(url = LIDAR_DATA_URL): Promise<LidarDataset> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`加载 LiDAR 数据失败: ${res.status}`)
  const text = await res.text()
  return parseLidarCsv(text)
}
