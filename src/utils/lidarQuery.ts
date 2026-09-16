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

function snapToNearest(values: number[], target: number): number {
  if (values.length === 0) return target
  let nearest = values[0]!
  let minDiff = Math.abs(target - nearest)
  for (const v of values) {
    const diff = Math.abs(target - v)
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

export function queryLidarAtLngLat(
  dataset: LidarDataset,
  index: Map<string, LidarSample>,
  lng: number,
  lat: number,
): LidarHoverInfo | null {
  const { metadata, azimuths, maxDistance } = dataset
  const { longitude, latitude, startRange, rangeResolution } = metadata

  const groundDistance = haversineMeters(longitude, latitude, lng, lat)
  if (groundDistance > maxDistance * 1.05 || groundDistance < startRange * 0.5) {
    return null
  }

  const azimuth = bearingDeg(longitude, latitude, lng, lat)
  const snappedAz = snapToNearest(azimuths, azimuth)

  const gateIndex = Math.round((groundDistance - startRange) / rangeResolution)
  const snappedDist = startRange + gateIndex * rangeResolution
  if (snappedDist < startRange || snappedDist > maxDistance) {
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
