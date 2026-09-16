import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './demo-common.css'

export default function RasterImageDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.LIGHT,
      center: [-75.789, 41.874],
      zoom: 10,
    })

    map.on('load', () => {
      map.addSource('radar', {
        type: 'image',
        url: 'https://docs.mapbox.com/mapbox-gl-js/assets/radar.gif',
        coordinates: [
          [-80.425, 46.437],
          [-71.516, 46.437],
          [-71.516, 37.936],
          [-80.425, 37.936],
        ],
      })

      map.addLayer({
        id: 'radar-layer',
        type: 'raster',
        source: 'radar',
        paint: {
          'raster-fade-duration': 0,
          'raster-opacity': 0.85,
        },
      })
    })

    return () => {
      map.remove()
    }
  }, [])

  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />
    </div>
  )
}
