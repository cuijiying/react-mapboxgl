/**
 * Mapbox 配置
 */

// 在 .env.local 中设置 VITE_MAPBOX_ACCESS_TOKEN
// 获取地址: https://account.mapbox.com/
export const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? ''

// 默认地图样式
export const MAP_STYLES = {
  STREETS: 'mapbox://styles/mapbox/streets-v12',
  LIGHT: 'mapbox://styles/mapbox/light-v11',
  DARK: 'mapbox://styles/mapbox/dark-v11',
  SATELLITE: 'mapbox://styles/mapbox/satellite-v9',
}
