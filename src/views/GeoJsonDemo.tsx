import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './demo-common.css'

const geojsonData: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        name: '北京',
        description: '中国首都，历史文化名城',
      },
      geometry: {
        type: 'Point',
        coordinates: [116.4074, 39.9042],
      },
    },
    {
      type: 'Feature',
      properties: {
        name: '上海',
        description: '中国经济中心',
      },
      geometry: {
        type: 'Point',
        coordinates: [121.4737, 31.2304],
      },
    },
    {
      type: 'Feature',
      properties: {
        name: '京沪线',
        description: '连接北京和上海的线路',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116.4074, 39.9042],
          [117.2, 36.6],
          [118.8, 34.2],
          [121.4737, 31.2304],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {
        name: '华北区域',
        description: '中国华北地区示意',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [113.5, 37.5],
            [119.5, 37.5],
            [119.5, 41.5],
            [113.5, 41.5],
            [113.5, 37.5],
          ],
        ],
      },
    },
  ],
}

export default function GeoJsonDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.STREETS,
      center: [116.4074, 35],
      zoom: 4,
    })

    map.on('load', () => {
      map.addSource('demo-geojson', {
        type: 'geojson',
        data: geojsonData,
      })

      map.addLayer({
        id: 'polygon-layer',
        type: 'fill',
        source: 'demo-geojson',
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'fill-color': '#088',
          'fill-opacity': 0.3,
        },
      })

      map.addLayer({
        id: 'polygon-outline',
        type: 'line',
        source: 'demo-geojson',
        filter: ['==', '$type', 'Polygon'],
        paint: {
          'line-color': '#088',
          'line-width': 2,
        },
      })

      map.addLayer({
        id: 'line-layer',
        type: 'line',
        source: 'demo-geojson',
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': '#f00',
          'line-width': 3,
        },
      })

      map.addLayer({
        id: 'point-layer',
        type: 'circle',
        source: 'demo-geojson',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#f0f',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      })

      map.on('click', 'point-layer', (e) => {
        if (!e.features || !e.features[0]) return
        const feature = e.features[0]
        const coordinates = (feature.geometry as GeoJSON.Point).coordinates.slice() as [
          number,
          number,
        ]
        const { name, description } = feature.properties as {
          name: string
          description: string
        }

        new mapboxgl.Popup()
          .setLngLat(coordinates)
          .setHTML(`<h3>${name}</h3><p>${description}</p>`)
          .addTo(map)
      })

      map.on('click', 'line-layer', (e) => {
        if (!e.features || !e.features[0]) return
        const feature = e.features[0]
        const { name, description } = feature.properties as {
          name: string
          description: string
        }

        new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`<h3>${name}</h3><p>${description}</p>`)
          .addTo(map)
      })

      map.on('click', 'polygon-layer', (e) => {
        if (!e.features || !e.features[0]) return
        const feature = e.features[0]
        const { name, description } = feature.properties as {
          name: string
          description: string
        }

        new mapboxgl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`<h3>${name}</h3><p>${description}</p>`)
          .addTo(map)
      })

      const layers = ['point-layer', 'line-layer', 'polygon-layer']
      layers.forEach((layer) => {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
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
