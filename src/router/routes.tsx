import { lazy, type ComponentType } from 'react'

export interface DemoRoute {
  path: string
  title: string
  Component: ComponentType
}

export const demoRoutes: DemoRoute[] = [
  {
    path: '/geojson-demo',
    title: 'GeoJSON 点线面加载',
    Component: lazy(() => import('@/views/GeoJsonDemo')),
  },
  {
    path: '/raster-image-demo',
    title: '栅格图片加载',
    Component: lazy(() => import('@/views/RasterImageDemo')),
  },
  {
    path: '/temperature-grid-demo',
    title: '温度色斑图(WebGL)',
    Component: lazy(() => import('@/views/TemperatureGridDemo')),
  },
  {
    path: '/temperature-grid-demo-nc',
    title: 'NC文件温度色斑图(WebGL)',
    Component: lazy(() => import('@/views/TemperatureGridDemoNC')),
  },
  {
    path: '/grid-layer-demo',
    title: 'GridLayer 通用格点图层',
    Component: lazy(() => import('@/views/GridLayerDemo')),
  },
  {
    path: '/grid-layer2-demo',
    title: 'GridLayer2 纹理采样优化',
    Component: lazy(() => import('@/views/GridLayer2Demo')),
  },
  {
    path: '/geoserver-vector-tile-demo',
    title: 'GeoServer 矢量切片加载',
    Component: lazy(() => import('@/views/GeoServerVectorTileDemo')),
  },
  {
    path: '/wind-field-demo',
    title: '风场粒子可视化',
    Component: lazy(() => import('@/views/WindFieldDemo')),
  },
  {
    path: '/split-view-demo',
    title: '二三维分屏联动',
    Component: lazy(() => import('@/views/SplitViewDemo')),
  },
  {
    path: '/grid-3d-demo',
    title: '三维色斑图(值作高度)',
    Component: lazy(() => import('@/views/Grid3dDemo')),
  },
  {
    path: '/water-surface-demo',
    title: '水面模拟(WebGL)',
    Component: lazy(() => import('@/views/WaterSurfaceDemo')),
  },
  {
    path: '/threejs-demo',
    title: 'Three.js 三维场景',
    Component: lazy(() => import('@/views/ThreeJsDemo')),
  },
  {
    path: '/radar-scan-demo',
    title: '雷达三维扫描(WebGL)',
    Component: lazy(() => import('@/views/RadarScanDemo')),
  },
  {
    path: '/drone-fleet-demo-init',
    title: '无人机机群初版(GLB+Three.js)',
    Component: lazy(() => import('@/views/DroneFleetDemoInit')),
  },
  {
    path: '/drone-fleet-demo-class',
    title: '无人机机群封装版(GLB+Three.js)',
    Component: lazy(() => import('@/views/DroneFleetDemoClass')),
  },
  {
    path: '/drone-fleet-demo',
    title: '无人机机群(GLB+Three.js)',
    Component: lazy(() => import('@/views/DroneFleetDemo')),
  },
  {
    path: '/gis-ai-demo',
    title: 'GIS + AI 智能分析',
    Component: lazy(() => import('@/views/GisAiDemo')),
  },
  {
    path: '/device-markers-demo',
    title: '设备图标点位',
    Component: lazy(() => import('@/views/DeviceMarkersDemo')),
  },
  {
    path: '/lidar-wind-demo',
    title: '探测激光雷达(PPI)',
    Component: lazy(() => import('@/views/LidarWindDemo')),
  },
]
