import mapboxgl from 'mapbox-gl'
import type { LidarDataset, LidarSample } from '@/utils/lidarCsvParser'

export interface LidarHoverInfo {
  sample: LidarSample
  lng: number
  lat: number
  groundDistance: number
  queryAzimuth: number
  queryDistance: number
}

function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearingDeg(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const lat1Rad = (lat1 * Math.PI) / 180
  const lat2Rad = (lat2 * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2Rad)
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng)
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

function circularAzDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

function snapToNearestAzimuth(values: number[], target: number): number {
  if (values.length === 0) return target
  let nearest = values[0]!
  let minDiff = circularAzDiff(target, nearest)
  for (const v of values) {
    const diff = circularAzDiff(target, v)
    if (diff < minDiff) {
      minDiff = diff
      nearest = v
    }
  }
  return nearest
}

function sampleToLngLat(sample: LidarSample): [number, number] {
  const mc = new mapboxgl.MercatorCoordinate(sample.x, sample.y, sample.z)
  const { lng, lat } = mc.toLngLat()
  return [lng, lat]
}

export function buildLidarSampleIndex(dataset: LidarDataset): Map<string, LidarSample> {
  const index = new Map<string, LidarSample>()
  for (const sample of dataset.samples) {
    index.set(`${sample.azimuth}_${sample.distance}`, sample)
  }
  return index
}

/** 按距离门格子命中：探测点为格心，值代表整个格子 */
export function queryLidarAtLngLat(
  dataset: LidarDataset,
  index: Map<string, LidarSample>,
  lng: number,
  lat: number,
): LidarHoverInfo | null {
  const { metadata, azimuths, maxValidDistance, minValidDistance } = dataset
  const { longitude, latitude, startRange, rangeResolution, azimuthStep, fixAngle } = metadata

  const groundDistance = haversineMeters(longitude, latitude, lng, lat)
  const pitchRad = (fixAngle * Math.PI) / 180
  const slantRange = groundDistance / Math.max(Math.cos(pitchRad), 1e-6)

  const halfRange = rangeResolution / 2
  const halfAz = azimuthStep / 2
  const inner = Math.max(0, minValidDistance - halfRange)
  const outer = maxValidDistance + halfRange
  if (slantRange < inner || slantRange > outer) {
    return null
  }

  const azimuth = bearingDeg(longitude, latitude, lng, lat)
  const snappedAz = snapToNearestAzimuth(azimuths, azimuth)
  if (circularAzDiff(azimuth, snappedAz) > halfAz + 1e-6) {
    return null
  }

  const gateIndex = Math.round((slantRange - startRange) / rangeResolution)
  const snappedDist = startRange + gateIndex * rangeResolution
  if (
    Math.abs(slantRange - snappedDist) > halfRange + 1e-6 ||
    snappedDist < minValidDistance - 1e-6 ||
    snappedDist > maxValidDistance + 1e-6
  ) {
    return null
  }

  const sample = index.get(`${snappedAz}_${snappedDist}`)
  if (!sample) return null

  const [sampleLng, sampleLat] = sampleToLngLat(sample)

  return {
    sample,
    lng: sampleLng,
    lat: sampleLat,
    groundDistance: snappedDist,
    queryAzimuth: snappedAz,
    queryDistance: snappedDist,
  }
}
