# Mapbox GL 温度色斑图 WebGL 渲染实现文档

## 概述

本文档详细介绍如何使用 Mapbox GL JS 的 CustomLayer 结合 WebGL 技术，实现温度格点数据的色斑图渲染。这种方式可以高效地渲染大规模气象数据，并且支持实时交互和动态更新。

## 数据格式

### 格点数据结构

```typescript
interface GridData {
  lonStart: number    // 起始经度
  latStart: number    // 起始纬度
  lonStep: number     // 经度步长
  latStep: number     // 纬度步长
  rows: number        // 行数（纬度方向）
  cols: number        // 列数（经度方向）
  values: number[][]  // 二维温度值数组
}
```

示例数据：

```json
{
  "lonStart": 100,
  "latStart": 20,
  "lonStep": 0.1,
  "latStep": 0.1,
  "rows": 100,
  "cols": 200,
  "values": [
    [23.1, 23.4, 23.8, ...],
    [23.0, 23.2, 23.7, ...],
    ...
  ]
}
```

## 技术实现

### 1. CustomLayer 接口

Mapbox GL JS 提供了 `CustomLayerInterface`，允许开发者直接使用 WebGL 在地图上绘制自定义内容。

```typescript
interface CustomLayerInterface {
  id: string                    // 图层唯一标识
  type: 'custom'               // 固定为 'custom'
  renderingMode?: '2d' | '3d'  // 渲染模式
  onAdd?(map: Map, gl: WebGLRenderingContext): void     // 图层添加时调用
  render(gl: WebGLRenderingContext, matrix: number[]): void  // 每帧渲染时调用
  onRemove?(map: Map, gl: WebGLRenderingContext): void  // 图层移除时调用
}
```

### 2. 着色器设计

#### 顶点着色器 (Vertex Shader)

顶点着色器负责：
- 接收顶点位置和颜色属性
- 将顶点位置通过投影矩阵转换到裁剪空间
- 将颜色传递给片元着色器

```glsl
attribute vec2 a_position;  // 顶点位置 (Mercator 坐标)
attribute vec4 a_color;     // 顶点颜色 (RGBA)
uniform mat4 u_matrix;      // Mapbox 提供的投影矩阵
varying vec4 v_color;       // 传递给片元着色器的颜色

void main() {
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  v_color = a_color;
}
```

#### 片元着色器 (Fragment Shader)

片元着色器负责：
- 接收从顶点着色器插值的颜色
- 输出最终的像素颜色

```glsl
precision mediump float;
varying vec4 v_color;

void main() {
  gl_FragColor = v_color;
}
```

### 3. 坐标转换

Mapbox GL 使用 Web Mercator 投影，需要将经纬度转换为 Mercator 坐标（0-1 范围）：

```typescript
function lngLatToMercator(lng: number, lat: number): [number, number] {
  // 经度转换：将 -180 到 180 映射到 0 到 1
  const x = (lng + 180) / 360
  
  // 纬度转换：使用 Mercator 投影公式
  const y = (1 - Math.log(
    Math.tan(lat * Math.PI / 180) + 
    1 / Math.cos(lat * Math.PI / 180)
  ) / Math.PI) / 2
  
  return [x, y]
}
```

### 4. 网格生成

将格点数据转换为三角形网格：

```
格点布局:
(0,0)---(0,1)---(0,2)
  |   \   |   \   |
(1,0)---(1,1)---(1,2)
  |   \   |   \   |
(2,0)---(2,1)---(2,2)

每个格子分解为两个三角形:
  顶左 --- 顶右        三角形1: 顶左 -> 底左 -> 顶右
    |   \   |          三角形2: 顶右 -> 底左 -> 底右
  底左 --- 底右
```

```typescript
// 创建顶点
for (let row = 0; row <= rows; row++) {
  for (let col = 0; col <= cols; col++) {
    const lon = lonStart + col * lonStep
    const lat = latStart + row * latStep
    const [x, y] = lngLatToMercator(lon, lat)
    vertices.push(x, y)
    
    // 获取该点的温度值并计算颜色
    const temp = values[Math.min(row, rows - 1)][Math.min(col, cols - 1)]
    const color = getColorForTemperature(temp)
    colors.push(...color)
  }
}

// 创建索引
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    const topLeft = row * (cols + 1) + col
    const topRight = topLeft + 1
    const bottomLeft = (row + 1) * (cols + 1) + col
    const bottomRight = bottomLeft + 1

    // 第一个三角形
    indices.push(topLeft, bottomLeft, topRight)
    // 第二个三角形
    indices.push(topRight, bottomLeft, bottomRight)
  }
}
```

### 5. 温度到颜色映射

使用线性插值在颜色节点之间过渡，实现平滑的色斑效果：

```typescript
const temperatureColorStops = [
  { temp: -20, color: [0.192, 0.212, 0.584, 1.0] },  // 深蓝
  { temp: -10, color: [0.271, 0.459, 0.706, 1.0] },  // 蓝
  { temp: 0,   color: [0.455, 0.678, 0.820, 1.0] },  // 浅蓝
  { temp: 10,  color: [0.671, 0.851, 0.914, 1.0] },  // 淡蓝
  { temp: 15,  color: [0.878, 0.953, 0.973, 1.0] },  // 青白
  { temp: 20,  color: [0.996, 0.878, 0.565, 1.0] },  // 浅黄
  { temp: 25,  color: [0.992, 0.682, 0.380, 1.0] },  // 橙黄
  { temp: 30,  color: [0.957, 0.427, 0.263, 1.0] },  // 橙红
  { temp: 35,  color: [0.843, 0.188, 0.153, 1.0] },  // 红
  { temp: 40,  color: [0.647, 0.0, 0.149, 1.0] }     // 深红
]

function getColorForTemperature(temp: number): [number, number, number, number] {
  // 边界检查
  if (temp <= temperatureColorStops[0].temp) {
    return temperatureColorStops[0].color
  }
  if (temp >= temperatureColorStops[temperatureColorStops.length - 1].temp) {
    return temperatureColorStops[temperatureColorStops.length - 1].color
  }

  // 查找温度所在区间并线性插值
  for (let i = 0; i < temperatureColorStops.length - 1; i++) {
    const lower = temperatureColorStops[i]
    const upper = temperatureColorStops[i + 1]
    if (temp >= lower.temp && temp < upper.temp) {
      const t = (temp - lower.temp) / (upper.temp - lower.temp)
      return [
        lower.color[0] + t * (upper.color[0] - lower.color[0]),
        lower.color[1] + t * (upper.color[1] - lower.color[1]),
        lower.color[2] + t * (upper.color[2] - lower.color[2]),
        lower.color[3] + t * (upper.color[3] - lower.color[3])
      ]
    }
  }
  
  return [1, 1, 1, 1]
}
```

### 6. WebGL 渲染流程

#### 初始化阶段 (onAdd)

```typescript
onAdd(map: Map, gl: WebGLRenderingContext) {
  // 1. 创建并编译着色器
  const vertexShader = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vertexShader, vertexShaderSource)
  gl.compileShader(vertexShader)

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fragmentShader, fragmentShaderSource)
  gl.compileShader(fragmentShader)

  // 2. 创建程序并链接着色器
  program = gl.createProgram()
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)

  // 3. 创建顶点缓冲区
  vertexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)

  // 4. 创建颜色缓冲区
  colorBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW)

  // 5. 创建索引缓冲区
  indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW)
}
```

#### 渲染阶段 (render)

```typescript
render(gl: WebGLRenderingContext, matrix: number[]) {
  gl.useProgram(program)

  // 1. 设置投影矩阵
  const matrixLocation = gl.getUniformLocation(program, 'u_matrix')
  gl.uniformMatrix4fv(matrixLocation, false, matrix)

  // 2. 绑定顶点属性
  const positionLocation = gl.getAttribLocation(program, 'a_position')
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.enableVertexAttribArray(positionLocation)
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

  // 3. 绑定颜色属性
  const colorLocation = gl.getAttribLocation(program, 'a_color')
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer)
  gl.enableVertexAttribArray(colorLocation)
  gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0)

  // 4. 启用混合（支持透明度）
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  // 5. 绑定索引缓冲区并绘制
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.drawElements(gl.TRIANGLES, numIndices, gl.UNSIGNED_INT, 0)
}
```

## 渲染流程图

```
┌─────────────────────────────────────────────────────────────┐
│                       数据准备阶段                           │
├─────────────────────────────────────────────────────────────┤
│  格点数据 → 坐标转换 → 生成顶点 → 温度映射颜色 → 构建三角形索引  │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      WebGL 初始化                            │
├─────────────────────────────────────────────────────────────┤
│  编译着色器 → 创建程序 → 创建缓冲区 → 上传数据到 GPU           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      每帧渲染                                │
├─────────────────────────────────────────────────────────────┤
│  使用程序 → 设置矩阵 → 绑定属性 → 启用混合 → 绘制三角形        │
└─────────────────────────────────────────────────────────────┘
```

## 性能优化建议

### 1. 数据简化
- 对于大范围数据，可以根据缩放级别动态调整格点密度
- 使用 LOD (Level of Detail) 技术

### 2. GPU 优化
- 使用 `STATIC_DRAW` 提示 GPU 数据不会频繁变化
- 考虑使用 WebGL 2.0 的实例化渲染

### 3. 内存优化
- 对于超大数据集，考虑分块加载和渲染
- 及时释放不需要的 WebGL 资源

### 4. 视觉优化
- 可以在片元着色器中添加双线性插值，使颜色过渡更平滑
- 添加边界检测，仅渲染视口内的数据

## 完整代码示例

完整实现请参考 `src/views/TemperatureGridDemo.vue` 文件。

## 扩展功能

1. **动态更新**：实现 `updateData()` 方法，支持实时更新温度数据
2. **交互功能**：添加鼠标悬停显示温度值
3. **动画效果**：实现温度变化的过渡动画
4. **等值线叠加**：在色斑图上叠加温度等值线

---

## 温度范围过滤功能

### 功能概述

通过滑动进度条动态过滤地图上显示的温度范围。该功能完全在 GPU 端（片元着色器）实现，性能极高。

### 实现原理

#### 1. 数据流架构

```
┌────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│   Vue 组件      │────▶│  温度范围状态     │────▶│  Shader Uniform  │
│  (滑动条 UI)    │     │  (min, max)     │     │  (u_tempMin/Max) │
└────────────────┘     └─────────────────┘     └──────────────────┘
                                                        │
                                                        ▼
                                               ┌──────────────────┐
                                               │   片元着色器      │
                                               │  (discard 过滤)  │
                                               └──────────────────┘
```

#### 2. 着色器设计

**顶点着色器** - 传递温度值到片元着色器：

```glsl
attribute vec2 a_position;
attribute vec4 a_color;
attribute float a_temperature;  // 新增：温度属性
uniform mat4 u_matrix;
varying vec4 v_color;
varying float v_temperature;    // 新增：传递给片元着色器

void main() {
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
  v_color = a_color;
  v_temperature = a_temperature;
}
```

**片元着色器** - 根据温度范围过滤：

```glsl
precision mediump float;
varying vec4 v_color;
varying float v_temperature;
uniform float u_tempMin;  // 新增：最低温度阈值
uniform float u_tempMax;  // 新增：最高温度阈值

void main() {
  // 如果温度不在范围内，丢弃该片元
  if (v_temperature < u_tempMin || v_temperature > u_tempMax) {
    discard;
  }
  gl_FragColor = v_color;
}
```

#### 3. Vue 组件实现

**响应式状态定义：**

```typescript
import { reactive } from 'vue'

// 温度过滤范围
const tempRange = reactive({
  min: -20,
  max: 50
})

// 用于更新 shader uniform 的回调函数
let updateTempRangeUniform: ((min: number, max: number) => void) | null = null

// 更新过滤器
function updateFilter() {
  if (updateTempRangeUniform) {
    updateTempRangeUniform(tempRange.min, tempRange.max)
  }
  // 触发地图重绘
  if (map) {
    map.triggerRepaint()
  }
}
```

**滑动条 UI 模板：**

```html
<div class="filter-control">
  <h4>温度过滤</h4>
  <div class="slider-group">
    <label>最低温度: {{ tempRange.min }}°C</label>
    <input
      type="range"
      v-model.number="tempRange.min"
      :min="-20"
      :max="50"
      step="1"
      @input="updateFilter"
    />
  </div>
  <div class="slider-group">
    <label>最高温度: {{ tempRange.max }}°C</label>
    <input
      type="range"
      v-model.number="tempRange.max"
      :min="-20"
      :max="50"
      step="1"
      @input="updateFilter"
    />
  </div>
</div>
```

#### 4. WebGL 缓冲区配置

**创建温度值缓冲区：**

```typescript
// 在 onAdd 中创建温度缓冲区
const temperatures: number[] = []

// 为每个顶点存储温度值
for (let row = 0; row <= rows; row++) {
  for (let col = 0; col <= cols; col++) {
    const r = Math.min(row, rows - 1)
    const c = Math.min(col, cols - 1)
    const temp = values[r][c]
    temperatures.push(temp)
  }
}

// 创建并上传温度缓冲区
tempBuffer = gl.createBuffer()
gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer)
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(temperatures), gl.STATIC_DRAW)
```

**在 render 中绑定：**

```typescript
render(gl: WebGLRenderingContext, matrix: number[]) {
  gl.useProgram(program)

  // 设置温度过滤范围 uniform
  gl.uniform1f(tempMinLocation, currentTempMin)
  gl.uniform1f(tempMaxLocation, currentTempMax)

  // ... 其他绑定

  // 绑定温度缓冲区
  const tempLocation = gl.getAttribLocation(program, 'a_temperature')
  gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer)
  gl.enableVertexAttribArray(tempLocation)
  gl.vertexAttribPointer(tempLocation, 1, gl.FLOAT, false, 0, 0)

  // 绘制
  gl.drawElements(gl.TRIANGLES, numIndices, gl.UNSIGNED_INT, 0)
}
```

### 性能分析

| 方案 | 过滤位置 | 性能 | 适用场景 |
|------|----------|------|----------|
| **CPU 过滤** | JavaScript | 慢，需重建缓冲区 | 数据量小 |
| **GPU discard** | 片元着色器 | 快，仅改变 uniform | 推荐方案 |
| **GPU 透明度** | 片元着色器 | 快，有透明开销 | 需要过渡效果 |

使用 `discard` 关键字的优势：
- **零 CPU 开销**：仅传递两个 float uniform
- **即时响应**：滑动条拖动时实时更新
- **内存友好**：无需重建任何缓冲区

### 过滤流程图

```
┌─────────────────────────────────────────────────────────────┐
│                     用户拖动滑动条                           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Vue 响应式更新 tempRange                        │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│            调用 updateFilter() 更新 uniform 值               │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              map.triggerRepaint() 触发重绘                   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│        render() 中设置 u_tempMin/u_tempMax uniform           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│     片元着色器判断 v_temperature 是否在范围内                  │
│     不在范围内 → discard (不渲染)                            │
│     在范围内 → 正常渲染颜色                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 参考资料

- [Mapbox GL JS Custom Layers](https://docs.mapbox.com/mapbox-gl-js/api/properties/#customlayerinterface)
- [WebGL 基础教程](https://webglfundamentals.org/)
- [Mapbox GL JS 坐标系统](https://docs.mapbox.com/mapbox-gl-js/api/geography/)
- [GLSL discard 关键字](https://www.khronos.org/opengl/wiki/Fragment_Shader#Special_operations)
