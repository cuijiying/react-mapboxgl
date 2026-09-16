# react-mapboxgl 技术栈与实现指南

> 面向 React 初学者的项目说明文档。  
> 本项目由 `vue3-mapboxgl` 完整移植而来，功能一一对应，技术栈从 Vue 3 换成了 React 19。

---

## 目录

1. [项目是做什么的](#1-项目是做什么的)
2. [技术栈一览](#2-技术栈一览)
3. [目录结构](#3-目录结构)
4. [React 基础概念（结合本项目）](#4-react-基础概念结合本项目)
5. [应用启动流程](#5-应用启动流程)
6. [路由与页面导航](#6-路由与页面导航)
7. [地图集成核心模式](#7-地图集成核心模式)
8. [图层架构（layers/）](#8-图层架构layers)
9. [17 个 Demo 分类说明](#9-17-个-demo-分类说明)
10. [Vue 版 vs React 版对照](#10-vue-版-vs-react-版对照)
11. [如何新增一个 Demo](#11-如何新增一个-demo)
12. [开发与构建](#12-开发与构建)
13. [常见问题 FAQ](#13-常见问题-faq)
14. [延伸阅读](#14-延伸阅读)

---

## 1. 项目是做什么的

`react-mapboxgl` 是一个 **Mapbox GL JS 能力演示集合**：

- 左侧：深色侧边栏，列出 17 个 Demo
- 右侧：全屏地图 + 控制面板
- 每个 Demo 独立展示一种 GIS / 可视化能力（GeoJSON、WebGL 色斑图、风场粒子、Three.js 三维等）

你可以把它理解成：**一个带导航菜单的「地图实验室」**，而不是一个完整的业务系统。

---

## 2. 技术栈一览

### 2.1 核心依赖（运行时）

| 包 | 版本 | 作用 |
|---|---|---|
| **react** | ^19.2 | UI 框架，用组件描述界面 |
| **react-dom** | ^19.2 | 把 React 组件渲染到浏览器 DOM |
| **react-router-dom** | ^7.9 | 单页应用路由（URL ↔ 页面组件） |
| **mapbox-gl** | ^3.18 | Mapbox 地图引擎（WebGL 底图 + 图层） |
| **three** | ^0.183 | 3D 渲染（无人机、Three.js Demo） |

### 2.2 开发工具（构建时）

| 包 | 作用 |
|---|---|
| **vite** ^7.3 | 开发服务器 + 打包工具（比 Webpack 更快） |
| **@vitejs/plugin-react** | 让 Vite 支持 JSX/TSX 和 React 热更新 |
| **typescript** ~5.9 | 类型检查，减少低级错误 |
| **@types/react / @types/mapbox-gl / @types/geojson / @types/three** | 第三方库的类型声明 |

### 2.3 技术选型说明（给小白）

```
浏览器
  └── React 组件（页面 UI）
        └── Mapbox GL JS（地图实例）
              ├── 内置图层（fill / line / circle / symbol / raster …）
              ├── CustomLayer（自定义 WebGL 图层，本项目核心）
              └── Three.js（部分 Demo 在 CustomLayer 里做 3D）
```

**为什么不用 `react-map-gl`？**  
本项目与 Vue 版保持一致，**直接操作 `mapboxgl.Map` 实例**，学习成本更低，也更灵活。React 只负责「页面壳子 + 控制面板」，地图逻辑与框架解耦。

---

## 3. 目录结构

```
react-mapboxgl/
├── index.html                 # HTML 入口，挂载 #root
├── vite.config.ts             # Vite 配置（路径别名、GLB 资源）
├── package.json
├── docs/                      # 文档（含本文 + WebGL 原理文档）
│
└── src/
    ├── main.tsx               # JS 入口：挂载 React 到 #root
    ├── App.tsx                # 根组件：Suspense + 路由
    ├── index.css              # 全局样式（全屏布局 reset）
    │
    ├── config/
    │   └── mapbox.ts          # Access Token + 地图样式常量
    │
    ├── router/
    │   ├── index.tsx          # Routes 定义
    │   └── routes.tsx         # 17 条 Demo 路由表（懒加载）
    │
    ├── components/
    │   ├── AppLayout.tsx      # 侧边栏 + 内容区布局
    │   └── AppLayout.css
    │
    ├── hooks/
    │   └── useMapbox.ts       # 地图生命周期 Hook（可选封装）
    │
    ├── layers/                # 可复用的 CustomLayer 类（与框架无关）
    │   ├── GridLayer.ts       # 格点色斑 V1
    │   ├── GridLayer2.ts      # 格点色斑 V2（GPU 纹理采样）
    │   ├── GridVectorContourLayer.ts
    │   ├── WindLayer.ts       # 风场粒子
    │   └── DroneFleetLayer.ts # 无人机机群
    │
    ├── utils/
    │   └── gridContour.ts     # 等值线/面 GeoJSON 生成算法
    │
    ├── views/                 # 17 个 Demo 页面（每个一个 .tsx）
    │   ├── GeoJsonDemo.tsx
    │   ├── GridLayer2Demo.tsx
    │   ├── WindFieldDemo.tsx
    │   └── …
    │
    ├── images/                # 静态资源
    │   ├── evtol.glb          # 无人机 3D 模型
    │   └── icons/devs/        # 设备图标 PNG
    │
    └── styles/
        └── geoserver-popup.css  # Mapbox Popup 全局样式
```

**关键原则：**

- `views/`：React 页面，负责 UI + 初始化地图
- `layers/`：纯 TypeScript 类，**不 import React**，可在任何框架复用
- `utils/`：与 UI 无关的算法工具

---

## 4. React 基础概念（结合本项目）

如果你刚学 React，先掌握下面 5 个概念，就能读懂本项目 90% 的代码。

### 4.1 组件（Component）

一个 `.tsx` 文件导出一个函数，就是一张「页面」或「UI 块」：

```tsx
export default function GeoJsonDemo() {
  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />
    </div>
  )
}
```

- 函数名首字母大写
- `return` 里是 **JSX**（长得像 HTML，实际是 JavaScript）
- `className` 对应 HTML 的 `class`

### 4.2 JSX 与表达式

JSX 里用 `{}` 插入 JavaScript 表达式：

```tsx
<label>最低: {filterMin}°C</label>
<span>{onlineCount}</span>
```

### 4.3 useState — 会驱动界面刷新的数据

```tsx
const [filterMin, setFilterMin] = useState(-20)

// 滑块变化时
<input
  type="range"
  value={filterMin}
  onChange={(e) => setFilterMin(Number(e.target.value))}
/>
```

| Vue 3 | React |
|---|---|
| `ref(0)` / `reactive({})` | `useState(0)` |
| `count.value = 1` | `setCount(1)` |
| 模板里自动解包 `.value` | 直接用变量名 `count` |

### 4.4 useRef — 不触发刷新的引用

适合存放：**DOM 节点、Map 实例、图层实例** 等不需要直接显示在界面上的对象。

```tsx
const mapContainer = useRef<HTMLDivElement>(null)

// JSX 绑定 DOM
<div ref={mapContainer} />

// 读取 DOM
mapContainer.current   // HTMLDivElement | null
```

| 用途 | 用 useState 还是 useRef |
|---|---|
| 滑块数值、面板文字 | `useState` |
| 地图实例 `mapboxgl.Map` | `useRef` |
| 图层实例 `GridLayer` | `useRef` |
| DOM 容器 div | `useRef` |

### 4.5 useEffect — 副作用与清理（最重要！）

对应 Vue 的 `onMounted` + `onUnmounted`。

```tsx
useEffect(() => {
  // 组件挂载后执行：创建地图
  const map = new mapboxgl.Map({ container: mapContainer.current!, ... })

  return () => {
    // 组件卸载前执行：销毁地图（防内存泄漏）
    map.remove()
  }
}, [])   // 空数组 = 只执行一次
```

**本项目铁律：创建了 `mapboxgl.Map`，就必须在 cleanup 里 `map.remove()`。**

### 4.6 其他常用 Hook

| Hook | 本项目用途 | Vue 对照 |
|---|---|---|
| `useCallback` | 缓存事件处理函数 | 普通 function |
| `useMemo` | 缓存计算结果（如 GisAiDemo 统计） | `computed` |
| `lazy` + `Suspense` | 路由懒加载 Demo | `() => import(...)` |

### 4.7 ref 同步 state 的技巧（避免闭包陷阱）

React 的 `useEffect(..., [])` 只运行一次，内部回调可能读到「旧的 state」。  
本项目在需要实时读最新值的场景，会用 **ref 镜像 state**：

```tsx
const [opacity, setOpacity] = useState(0.85)
const opacityRef = useRef(opacity)
opacityRef.current = opacity   // 每次渲染同步最新值

const applyOpacity = () => {
  gridLayerRef.current?.setOpacity(opacityRef.current)
}
```

这在 `GridLayerDemo`、`DroneFleetDemoClass` 等带控制面板的 Demo 中很常见。

---

## 5. 应用启动流程

```
index.html
  └── <div id="root">
        └── main.tsx
              ├── BrowserRouter        ← 启用路由
              └── App.tsx
                    └── Suspense       ← 懒加载时的 loading
                          └── AppRouter (router/index.tsx)
                                └── AppLayout
                                      ├── 侧边栏 NavLink
                                      └── <Outlet />  ← 当前 Demo 组件
```

### 5.1 main.tsx — 入口

```tsx
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
```

- `createRoot`：React 18+ 的新挂载方式
- `BrowserRouter`：使用浏览器 URL（如 `/wind-field-demo`）

### 5.2 App.tsx — 根组件

用 `Suspense` 包裹路由，Demo 懒加载时显示「加载中...」。

### 5.3 AppLayout — 布局壳

- 从 `demoRoutes` 读取菜单项
- `<Outlet />` 是 react-router 的占位符，渲染当前匹配的子路由组件

---

## 6. 路由与页面导航

### 6.1 路由表（routes.tsx）

每条路由包含：

```tsx
{
  path: '/geojson-demo',           // URL 路径
  title: 'GeoJSON 点线面加载',     // 侧边栏显示文字
  Component: lazy(() => import('@/views/GeoJsonDemo')),  // 懒加载组件
}
```

**懒加载的好处：** 首次打开只下载当前 Demo 的代码，不会一次加载全部 17 个页面。

### 6.2 路由注册（router/index.tsx）

```tsx
<Routes>
  <Route path="/" element={<AppLayout />}>
    <Route index element={<Navigate to="/geojson-demo" replace />} />
    {demoRoutes.map(({ path, Component }) => (
      <Route key={path} path={path.slice(1)} element={<Component />} />
    ))}
  </Route>
</Routes>
```

- 访问 `/` 自动跳转到 `/geojson-demo`
- 子路由 `path.slice(1)` 去掉开头的 `/`，如 `geojson-demo`

### 6.3 与 Vue Router 对照

| 概念 | Vue 3 | React |
|---|---|---|
| 路由配置 | `router/index.ts` | `router/routes.tsx` + `router/index.tsx` |
| 布局 + 子页面 | `<router-view />` | `<Outlet />` |
| 导航链接 | `<router-link>` | `<NavLink>` |
| 懒加载 | `() => import('...')` | `lazy(() => import('...'))` |
| 路由元信息 | `meta: { title }` | 路由对象里的 `title` 字段 |

---

## 7. 地图集成核心模式

所有 Demo 都遵循同一套模式，难度从低到高分为 3 级。

### 7.1 模式 A：纯 Mapbox 内置图层（入门）

**代表：** `GeoJsonDemo`、`RasterImageDemo`、`DeviceMarkersDemo`

```tsx
export default function GeoJsonDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapContainer.current!,
      style: MAP_STYLES.STREETS,
      center: [116.4074, 35],
      zoom: 4,
    })

    map.on('load', () => {
      map.addSource('demo-geojson', { type: 'geojson', data: geojsonData })
      map.addLayer({ id: 'point-layer', type: 'circle', source: 'demo-geojson', ... })
    })

    return () => map.remove()
  }, [])

  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />
    </div>
  )
}
```

**步骤记忆口诀：**

1. 准备 DOM 容器（`ref`）
2. `new mapboxgl.Map`
3. `map.on('load', ...)` 里加 source / layer
4. 卸载时 `map.remove()`

### 7.2 模式 B：封装 CustomLayer 类（进阶）

**代表：** `GridLayerDemo`、`WindFieldDemo`、`DroneFleetDemoClass`

```tsx
map.on('load', () => {
  const gridLayer = new GridLayer({
    layerId: 'temperature-grid',
    gridData,
    colorStops: COLOR_STOPS,
    onClick: (info) => setClickInfo(info),  // 回调更新 React state
  })
  map.addLayer(gridLayer)
  gridLayerRef.current = gridLayer
})

// 控制面板改参数
const applyFilter = () => {
  gridLayerRef.current?.setFilter(filterMinRef.current, filterMaxRef.current)
}
```

**分工：**

- `GridLayer.ts`：WebGL 渲染、点击反查格点
- `GridLayerDemo.tsx`：React UI、滑块、调用 `setFilter` / `setOpacity`

### 7.3 模式 C：Demo 内联 WebGL / Three.js（高级）

**代表：** `TemperatureGridDemo`、`WaterSurfaceDemo`、`RadarScanDemo`、`ThreeJsDemo`

WebGL 着色器代码直接写在 Demo 的 `useEffect` 里（或独立函数），实现 `mapboxgl.CustomLayerInterface`：

```tsx
const layer: mapboxgl.CustomLayerInterface = {
  id: 'temperature-layer',
  type: 'custom',
  renderingMode: '2d',
  onAdd(map, gl) { /* 编译 shader、创建 buffer */ },
  render(gl, matrix) { /* 每帧绘制 */ },
  onRemove(map, gl) { /* 释放 GPU 资源 */ },
}
map.addLayer(layer)
```

这类 Demo 体量大，但结构仍是 **模式 A 的壳 + CustomLayer 实现**。

### 7.4 useMapbox Hook（可选简化）

项目提供了 `hooks/useMapbox.ts`，把「创建 / 销毁地图」封装成 Hook：

```tsx
const { containerRef, mapRef } = useMapbox({
  style: MAP_STYLES.STREETS,
  center: [116, 35],
  zoom: 4,
  onLoad: (map) => {
    map.addSource(...)
  },
})

return <div ref={containerRef} className="map-container" />
```

当前多数 Demo 仍直接使用 `useEffect`，两种方式等价，Hook 适合快速新建简单页面。

### 7.5 样式与布局要点

每个 Demo 容器需要 **占满右侧内容区**：

```css
/* demo-common.css */
.demo-container { width: 100%; height: 100%; }
.map-container  { width: 100%; height: 100%; }
```

父级链：`#root` → `.app-layout` → `.main-content` → `.demo-container` → `.map-container`，每一层都要有高度，否则地图高度为 0。

**必须引入 Mapbox CSS：**

```tsx
import 'mapbox-gl/dist/mapbox-gl.css'
```

---

## 8. 图层架构（layers/）

图层类实现 Mapbox 的 `CustomLayerInterface`，与 React **完全无关**，这是本项目的核心资产。

### 8.1 五个图层类

| 类 | 文件 | 能力 |
|---|---|---|
| `GridLayer` | `GridLayer.ts` | V1 格点 WebGL，每格 2 三角形，CPU 预计算颜色 |
| `GridLayer2` | `GridLayer2.ts` | V2 GPU 纹理采样，支持 smooth / filled / lines 等显示模式 |
| `GridVectorContourLayer` | `GridVectorContourLayer.ts` | CPU 等值线/面 GeoJSON，叠在 GPU 色斑之上 |
| `WindLayer` | `WindLayer.ts` | 风场粒子动画 + `generateChinaWindData()` |
| `DroneFleetLayer` | `DroneFleetLayer.ts` | Three.js 无人机机群、航迹、光环 |

### 8.2 CustomLayer 生命周期

```
map.addLayer(customLayer)
  └── onAdd(map, gl)      初始化 WebGL Program / Buffer
        └── render(gl, matrix)   每帧调用（动画在这里）
              └── onRemove(map, gl)   释放 GPU 资源
```

### 8.3 工具库 gridContour.ts

提供 Marching Squares 等值线、等值面、平滑算法，供 `GridLayer2` 和 `GridVectorContourLayer` 使用。

详细 WebGL 原理见：

- `docs/grid-layer-webgl.md`
- `docs/grid-layer2-texture.md`
- `docs/temperature-grid-webgl.md`
- `docs/grid-vertex-mapping.md`

---

## 9. 17 个 Demo 分类说明

### 9.1 基础地图能力

| Demo | 路由 | 技术要点 |
|---|---|---|
| GeoJsonDemo | `/geojson-demo` | GeoJSON source + fill/line/circle + Popup |
| RasterImageDemo | `/raster-image-demo` | image source + raster layer |
| GeoServerVectorTileDemo | `/geoserver-vector-tile-demo` | TMS 矢量切片 + fill-extrusion 3D 建筑 |
| DeviceMarkersDemo | `/device-markers-demo` | Symbol 图层 + 图标加载 + 闪烁动画 |

### 9.2 格点 / 色斑图

| Demo | 路由 | 技术要点 |
|---|---|---|
| TemperatureGridDemo | `/temperature-grid-demo` | 内联 CustomLayer WebGL |
| TemperatureGridDemoNC | `/temperature-grid-demo-nc` | 从 API 拉 NC 卫星数据 |
| GridLayerDemo | `/grid-layer-demo` | `GridLayer` 类 |
| GridLayer2Demo | `/grid-layer2-demo` | `GridLayer2` + 矢量等值线 + 时间动画 |
| Grid3dDemo | `/grid-3d-demo` | 格点 → GeoJSON + fill-extrusion 高度 |

### 9.3 风场 / 水面 / 雷达

| Demo | 路由 | 技术要点 |
|---|---|---|
| WindFieldDemo | `/wind-field-demo` | `WindLayer` 粒子 + 参数面板 |
| WaterSurfaceDemo | `/water-surface-demo` | 内联 WebGL 水面波浪 |
| RadarScanDemo | `/radar-scan-demo` | 内联 WebGL 雷达扫描锥 |

### 9.4 Three.js / 无人机

| Demo | 路由 | 技术要点 |
|---|---|---|
| ThreeJsDemo | `/threejs-demo` | CustomLayer + Three.js 基础几何体 |
| DroneFleetDemoInit | `/drone-fleet-demo-init` | 内联 Three.js + GLTFLoader |
| DroneFleetDemoClass | `/drone-fleet-demo-class` | `DroneFleetLayer` 封装 + HUD 面板 |
| DroneFleetDemo | `/drone-fleet-demo` | 完整版：点击 Popup + 状态着色 |

### 9.5 联动 / 分析

| Demo | 路由 | 技术要点 |
|---|---|---|
| SplitViewDemo | `/split-view-demo` | 双 Map 实例 + center/zoom/bearing 同步 |
| GisAiDemo | `/gis-ai-demo` | 监测站 + 聊天面板 + 客户端空间分析算法 |

### 9.6 外部服务依赖

| Demo | 依赖 |
|---|---|
| GeoServerVectorTileDemo | 内网 GeoServer `10.1.109.141:28080` |
| TemperatureGridDemoNC | 本地 API `http://localhost:3000/api/temperature-grid` |
| 所有 Demo | 有效 Mapbox Access Token（`config/mapbox.ts`） |

---

## 10. Vue 版 vs React 版对照

本项目是从 `vue3-mapboxgl` 移植的，下面是最常见的写法对照，方便有 Vue 经验的同学迁移。

### 10.1 生命周期

```vue
<!-- Vue -->
<script setup>
import { onMounted, onUnmounted } from 'vue'
onMounted(() => { /* 创建地图 */ })
onUnmounted(() => { map.remove() })
</script>
```

```tsx
// React
useEffect(() => {
  /* 创建地图 */
  return () => { map.remove() }
}, [])
```

### 10.2 响应式数据

```vue
<!-- Vue -->
const count = ref(0)
const cfg = reactive({ speed: 1 })
watch(() => cfg.speed, (v) => layer.setSpeed(v))
```

```tsx
// React
const [count, setCount] = useState(0)
const [cfg, setCfg] = useState({ speed: 1 })
useEffect(() => {
  layer?.setSpeed(cfg.speed)
}, [cfg.speed])
```

### 10.3 模板 vs JSX

```vue
<div v-if="clickInfo" class="card">{{ clickInfo.value }}</div>
<input v-model.number="opacity" @input="applyOpacity" />
```

```tsx
{clickInfo && <div className="card">{clickInfo.value}</div>}
<input
  type="range"
  value={opacity}
  onChange={(e) => {
    setOpacity(Number(e.target.value))
    applyOpacity()
  }}
/>
```

### 10.4 框架分工（两版相同）

```
React/Vue 页面  →  只负责 UI + 地图生命周期
layers/ 类      →  纯 TS，与框架无关
mapbox-gl       →  地图引擎
```

---

## 11. 如何新增一个 Demo

以新增「我的 Demo」为例，共 4 步：

### 步骤 1：创建页面组件

`src/views/MyDemo.tsx`：

```tsx
import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MAPBOX_ACCESS_TOKEN, MAP_STYLES } from '@/config/mapbox'
import './demo-common.css'

export default function MyDemo() {
  const mapContainer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mapContainer.current) return
    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLES.STREETS,
      center: [116.4, 39.9],
      zoom: 10,
    })
    map.on('load', () => {
      // 你的图层逻辑
    })
    return () => map.remove()
  }, [])

  return (
    <div className="demo-container">
      <div ref={mapContainer} className="map-container" />
    </div>
  )
}
```

### 步骤 2：注册路由

在 `src/router/routes.tsx` 的 `demoRoutes` 数组末尾添加：

```tsx
{
  path: '/my-demo',
  title: '我的 Demo',
  Component: lazy(() => import('@/views/MyDemo')),
},
```

### 步骤 3：保存并访问

```bash
npm run dev
```

浏览器打开 `http://localhost:5173/my-demo`，侧边栏会自动出现新菜单项（菜单从 `demoRoutes` 读取，无需改 AppLayout）。

### 步骤 4（可选）：抽离可复用图层

如果 WebGL 逻辑超过 200 行，建议像 `GridLayer.ts` 一样抽到 `src/layers/`，Demo 只负责 UI。

---

## 12. 开发与构建

### 12.1 常用命令

```bash
# 安装依赖（首次或 clone 后）
npm install

# 启动开发服务器（热更新）
npm run dev

# 类型检查 + 生产打包
npm run build

# 预览打包结果
npm run preview
```

### 12.2 路径别名

`@/` 指向 `src/`，在 `vite.config.ts` 和 `tsconfig.app.json` 中配置：

```tsx
import { GridLayer } from '@/layers/GridLayer'
import droneModelUrl from '@/images/evtol.glb?url'
```

### 12.3 静态资源导入

| 写法 | 结果 |
|---|---|
| `import url from './x.png?url'` | 得到资源 URL 字符串 |
| `import url from './x.glb?url'` | GLB 模型 URL（Vite 当静态资源处理） |

类型声明在 `src/vite-env.d.ts`。

### 12.4 Mapbox Token

编辑 `src/config/mapbox.ts` 中的 `MAPBOX_ACCESS_TOKEN`。  
生产环境建议改用环境变量，不要把 Token 提交到公开仓库。

### 12.5 推荐学习顺序（Demo）

1. **GeoJsonDemo** — 理解 Map 基本流程  
2. **GridLayerDemo** — 理解 CustomLayer + React 控制面板  
3. **WindFieldDemo** — 理解复杂图层 + 多参数调试  
4. **GridLayer2Demo** — 理解最完整的格点可视化  
5. **DroneFleetDemoClass** — 理解 Three.js + 配置同步  

---

## 13. 常见问题 FAQ

### Q1：地图区域是空白的？

检查：

1. 是否 `import 'mapbox-gl/dist/mapbox-gl.css'`
2. `.demo-container` / `.map-container` 是否有 `height: 100%`
3. Token 是否有效（浏览器控制台是否有 401 错误）

### Q2：切换 Demo 后内存涨、页面卡顿？

确保每个 Demo 的 `useEffect` cleanup 里调用了 `map.remove()`，CustomLayer 的 `onRemove` 是否释放了 WebGL 资源。

### Q3：控制面板改了参数，地图没反应？

常见原因：在 `useEffect(..., [])` 的一次性回调里读了旧的 state。  
解决：用 `ref` 同步最新值，或像 `DroneFleetDemoClass` 那样用第二个 `useEffect` 监听 state 变化。

### Q4：TypeScript 报 `Cannot find namespace 'GeoJSON'`？

项目已依赖 `@types/geojson`。若仍报错，确认 `tsconfig.app.json` 没有限制 `"types": ["vite/client"]` 导致 geojson 类型未加载。

### Q5：构建失败，提示 three / GLTFLoader 相关错误？

执行完整重装：

```bash
Remove-Item -Recurse -Force node_modules
npm install
```

确保 `three@0.183.2` 完整，且使用 **Vite 7.x**（不要用 Vite 8，与当前 plugin-react 版本存在兼容问题）。

### Q6：和 Vue 版功能一样吗？

是的。17 个 Demo 路由、图层类、算法工具与 `vue3-mapboxgl` 一一对应，仅 UI 框架从 Vue 换成了 React。

---

## 14. 延伸阅读

| 文档 | 内容 |
|---|---|
| 本文 | React 技术栈 + 项目结构 + 开发指南 |
| `docs/grid-layer-webgl.md` | GridLayer V1 WebGL 原理 |
| `docs/grid-layer2-texture.md` | GridLayer2 GPU 纹理采样 |
| `docs/temperature-grid-webgl.md` | 温度色斑图 CustomLayer |
| `docs/grid-vertex-mapping.md` | 格点顶点与 Mercator 映射 |
| [React 官方文档](https://react.dev/) | React 基础 |
| [Mapbox GL JS 文档](https://docs.mapbox.com/mapbox-gl-js/guides/) | 地图 API |
| [react-router 文档](https://reactrouter.com/) | 路由 |

---

## 附录：一张图看懂整体架构

```
┌─────────────────────────────────────────────────────────┐
│  main.tsx → App.tsx → AppRouter → AppLayout             │
│    │                              │                     │
│    │                              ├── 侧边栏 (NavLink)   │
│    │                              └── Outlet            │
│    │                                    │               │
│    │                                    ▼               │
│    │                              views/XxxDemo.tsx     │
│    │                              ┌─────────────────┐   │
│    │                              │ useEffect       │   │
│    │                              │  new Map()      │   │
│    │                              │  addLayer()     │   │
│    │                              │  return remove  │   │
│    │                              └────────┬────────┘   │
│    │                                       │             │
│    └───────────────────────────────────────┼─────────────┘
│                                            ▼
│                              mapbox-gl + layers/*.ts
│                              (CustomLayer / 内置图层)
└─────────────────────────────────────────────────────────┘
```

---

*文档版本：与 react-mapboxgl 当前代码同步（17 Demo + React 19 + Vite 7 + Mapbox GL 3.18）*
