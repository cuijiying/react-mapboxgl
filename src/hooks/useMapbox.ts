import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN } from '@/config/mapbox'

export interface UseMapboxOptions extends Omit<mapboxgl.MapOptions, 'container'> {
  onLoad?: (map: mapboxgl.Map) => void
}

/**
 * 封装 Mapbox 地图生命周期：挂载时创建，卸载时 remove。
 */
export function useMapbox(options: UseMapboxOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const onLoadRef = useRef(options.onLoad)
  onLoadRef.current = options.onLoad

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const { onLoad: _onLoad, ...mapOptions } = options
    const map = new mapboxgl.Map({
      container,
      ...mapOptions,
    })
    mapRef.current = map

    if (onLoadRef.current) {
      if (map.loaded()) {
        onLoadRef.current(map)
      } else {
        map.on('load', () => onLoadRef.current?.(map))
      }
    }

    return () => {
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { containerRef, mapRef }
}
