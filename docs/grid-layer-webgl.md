# GridLayer 实现详解

> 面向 WebGL 新手的完整技术文档，逐步讲解从格点数据到屏幕像素的每一个环节。

---

## 目录

1. [整体架构](#1-整体架构)
2. [核心概念：WebGL 渲染管线](#2-核心概念webgl-渲染管线)
3. [坐标系转换](#3-坐标系转换)
4. [数据结构设计](#4-数据结构设计)
5. [着色器（Shader）详解](#5-着色器shader详解)
6. [GPU 缓冲区（Buffer）详解](#6-gpu-缓冲区buffer详解)
7. [三角网格构建](#7-三角网格构建)
8. [颜色插值](#8-颜色插值)
9. [动态过滤：discard 指令](#9-动态过滤discard-指令)
10. [混合模式（Alpha Blending）](#10-混合模式alpha-blending)
11. [CustomLayerInterface 生命周期](#11-customlayerinterface-生命周期)
12. [点击事件与空间查询](#12-点击事件与空间查询)
13. [资源管理与内存泄漏防范](#13-资源管理与内存泄漏防范)
14. [性能关键点汇总](#14-性能关键点汇总)
15. [常见问题 FAQ](#15-常见问题-faq)

---

## 1. 整体架构

GridLayer 遵循 **Mapbox GL JS `CustomLayerInterface`** 协议，允许开发者在 Mapbox 的渲染循环中插入自定义 WebGL 绘制逻辑。

```
格点数据 (二维数组)
       │
       ▼
  坐标转换 (经纬度 → Mercator)
       │
       ▼
  构建 GPU 缓冲区 (vertices / colors / values / indices)
       │
       ▼
  WebGL 着色器 (GLSL)
   ┌───────────────────────────────────┐
   │  顶点着色器 (Vertex Shader)       │  ← 每顶点执行一次，决定位置
   │  → 将 Mercator 坐标变换到屏幕    │
   └─────────────┬─────────────────────┘
                 │ 光栅化 (Rasterization)
                 ▼
   ┌───────────────────────────────────┐
   │  片元着色器 (Fragment Shader)     │  ← 每像素执行一次，决定颜色
   │  → 过滤 + 着色                   │
   └───────────────────────────────────┘
       │
       ▼
  帧缓冲 → 屏幕
```

---

## 2. 核心概念：WebGL 渲染管线

WebGL 是运行在 GPU 上的低级图形 API。理解它的关键是掌握**渲染管线**：

| 阶段 | 发生在 | 说明 |
|------|--------|------|
| **顶点着色器** | GPU（每顶点） | 将顶点坐标变换到裁剪空间 |
| **图元装配** | GPU | 将顶点组装成三角形 |
| **光栅化** | GPU | 将三角形填充为屏幕像素，插值 Varying 变量 |
| **片元着色器** | GPU（每像素） | 计算每个像素的最终颜色 |
| **深度/模板测试** | GPU | 决定像素是否写入帧缓冲 |
| **混合** | GPU | Alpha 透明合成 |

**关键点：CPU 只负责准备数据，GPU 负责并行执行着色器。** 这就是 WebGL 能高性能渲染百万级顶点的原因。

---

## 3. 坐标系转换

### 3.1 为什么需要转换？

地理坐标使用经纬度（WGS84 球面坐标），而 Mapbox 内部使用 **Web Mercator 投影**（EPSG:3857）的归一化版本，坐标范围 $[0, 1] \times [0, 1]$。

### 3.2 转换公式

$$x = \frac{\text{lon} + 180}{360}$$

$$y = \frac{1 - \frac{\ln\!\left(\tan\!\left(\varphi\right) + \sec\!\left(\varphi\right)\right)}{\pi}}{2}$$

其中 $\varphi$ 为纬度弧度值（`lat * Math.PI / 180`）。

### 3.3 代码实现

```ts
function lngLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon + 180) / 360
  const latRad = (lat * Math.PI) / 180
  // Math.tan(latRad) + 1/Math.cos(latRad) = tan + sec = (sin+1)/cos
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}
```

> **注意**：Mercator 投影在高纬度（±85°以上）会严重变形，这也是 Web 地图通常裁剪在 ±85.05° 的原因。

---

## 4. 数据结构设计

### 4.1 格点数据（GridData）

```
格点示意（rows=3, cols=4，lonStep=0.1, latStep=0.1）：

lat=20.3：  ●  ●  ●  ●   ← row=2
lat=20.2：  ●  ●  ●  ●   ← row=1
lat=20.1：  ●  ●  ●  ●   ← row=0
           ↑           ↑
         lon=100     lon=100.4
```

`values[row][col]` 存储该格点中心位置的数值（如温度）。

### 4.2 顶点网格 vs 格点网格

**关键区别**：格点数据是 `rows × cols` 个"格子"，但 WebGL 绘制三角形需要"顶点"——顶点网格尺寸为 `(rows+1) × (cols+1)`。

```
顶点（★）和格子（□）的关系：

★──★──★──★──★   ← vRows = rows+1 = 4 行顶点
│□ │□ │□ │□ │
★──★──★──★──★
│□ │□ │□ │□ │
★──★──★──★──★
│□ │□ │□ │□ │
★──★──★──★──★
```

顶点数 = `(rows+1) × (cols+1)`，格子数 = `rows × cols`。

---

## 5. 着色器（Shader）详解

着色器用 **GLSL**（OpenGL Shading Language）编写，语法类似 C 语言。

### 5.1 顶点着色器

```glsl
// ── 输入：每个顶点的属性数据（由 CPU 端 Buffer 提供）─────
attribute vec2 a_position;    // Mercator 坐标 (x, y)
attribute vec4 a_color;       // 颜色 (r, g, b, a)
attribute float a_value;      // 原始数据值（温度）

// ── 输入：全局 Uniform（所有顶点共享同一值）─────────────
uniform mat4 u_matrix;        // Mapbox 提供的 MVP 变换矩阵

// ── 输出：传递给片元着色器的插值变量（Varying）──────────
varying vec4 v_color;
varying float v_value;

void main() {
  // gl_Position 是内置变量，必须赋值
  // u_matrix 将 [0,1]×[0,1] 的 Mercator 坐标变换至裁剪空间 [-1,1]^3
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);

  // 将颜色和数值传递给片元着色器（光栅化时自动插值）
  v_color = a_color;
  v_value = a_value;
}
```

**为什么要有 MVP 矩阵？**

Mapbox 内部按如下步骤变换坐标：

```
Mercator [0,1] → Model → View → Projection → 裁剪空间 [-1,1]
```

Mapbox 将合并后的矩阵通过 `render(gl, matrix)` 传入，我们只需乘以这个矩阵即可保证与地图同步（缩放、平移、旋转）。

### 5.2 片元着色器

```glsl
precision mediump float;  // 中等精度，性能与精度的平衡点

varying vec4 v_color;
varying float v_value;

uniform float u_filterMin;  // 过滤下限（来自 JS 滑块）
uniform float u_filterMax;  // 过滤上限
uniform float u_opacity;    // 整体透明度

void main() {
  // 数值不在范围内 → 丢弃片元（不写入帧缓冲）
  if (v_value < u_filterMin || v_value > u_filterMax) {
    discard;
  }

  // 最终颜色 = 顶点颜色 × 透明度因子
  gl_FragColor = vec4(v_color.rgb, v_color.a * u_opacity);
}
```

**Varying 插值机制**：

顶点着色器输出的 `v_color` 和 `v_value` 在光栅化阶段会被 GPU **自动线性插值**。

```
顶点A: v_value=10 ────────────── 顶点B: v_value=30
                   片元: v_value=20（插值结果）
```

这意味着格子内部的颜色是平滑过渡的，而无需 CPU 为每个像素计算颜色。

---

## 6. GPU 缓冲区（Buffer）详解

Buffer 是 GPU 显存中的一块内存，用于存储顶点数据。

### 6.1 三种顶点 Buffer

```ts
// 1. 顶点坐标 Buffer：每个顶点 2 个 float (x, y)
const positions = new Float32Array(vertexCount * 2)

// 2. 颜色 Buffer：每个顶点 4 个 float (r, g, b, a)
const colors = new Float32Array(vertexCount * 4)

// 3. 数值 Buffer：每个顶点 1 个 float (temperature)
const values = new Float32Array(vertexCount * 1)
```

### 6.2 上传到 GPU

```ts
// 创建 Buffer 对象（相当于在 GPU 显存申请一块空间）
const buf = gl.createBuffer()

// 告诉 WebGL 接下来的操作针对这个 Buffer
gl.bindBuffer(gl.ARRAY_BUFFER, buf)

// 将 CPU 内存的 Float32Array 复制到 GPU 显存
// STATIC_DRAW 提示：数据不会频繁修改，GPU 可以优化存储位置
gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
```

### 6.3 配置顶点属性指针

告诉 GPU 如何从 Buffer 中读取每个顶点的数据：

```ts
// 获取着色器中 a_position 的位置编号
const loc = gl.getAttribLocation(program, 'a_position')

// 绑定对应的 Buffer
gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)

// 启用该属性
gl.enableVertexAttribArray(loc)

// 告诉 GPU 读取规则：
//   loc    — 属性位置
//   2      — 每个顶点读取 2 个分量（x, y）
//   FLOAT  — 数据类型为 32 位浮点
//   false  — 不归一化（float 类型忽略此参数）
//   0      — stride=0 表示紧密排列（无间隔）
//   0      — offset=0 从 Buffer 起始位置开始读取
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
```

---

## 7. 三角网格构建

### 7.1 为什么用三角形？

GPU 只能绘制三角形（WebGL 原语）。一个矩形格子需要拆成两个三角形：

```
topLeft(tl) ──── topRight(tr)
     │              │
     │    三角形1   │
     │  tl,bl,tr   │
     │   ╲         │
     │    ╲        │
     │     ╲三角形2│
     │   tr,bl,br  │
     │              │
bottomLeft(bl) ── bottomRight(br)
```

### 7.2 顶点索引计算

顶点编号公式：`index = row * vCols + col`（其中 `vCols = cols + 1`）

```
row=0: 0  1  2  3  4
row=1: 5  6  7  8  9   ← vCols=5 的情况（cols=4）
row=2: 10 11 12 13 14
```

对格子 `(row, col)`：

```ts
const tl = row * vCols + col
const tr = tl + 1
const bl = (row + 1) * vCols + col
const br = bl + 1
```

### 7.3 为什么用 Index Buffer？

相邻格子共享顶点。如果不用索引，每个三角形需要重复存储顶点：

- **不用索引**：每个格子 2 个三角形 × 3 个顶点 = 6 个顶点，共 `rows×cols×6` 个顶点
- **用索引**：顶点数 = `(rows+1)×(cols+1)`，索引数 = `rows×cols×6`

对于 100×200 格点：
- 不用索引：120,000 个顶点
- 用索引：20,301 个顶点 + 120,000 个索引（每个索引 4 字节，远小于顶点的 `4+4×4=20` 字节）

**节省的 GPU 显存和带宽是巨大的。**

### 7.4 UNSIGNED_INT 扩展

WebGL 1.0 默认索引类型为 `UNSIGNED_SHORT`，最多支持 65535 个顶点。超过时需启用扩展：

```ts
// 几乎所有现代 GPU 都支持此扩展
gl.getExtension('OES_element_index_uint')
// 之后可使用 Uint32Array 和 gl.UNSIGNED_INT
```

---

## 8. 颜色插值

### 8.1 色标节点

色标定义了数值到颜色的分段映射，例如：

| 数值 | 颜色 (RGBA 归一化) | 颜色（HEX） |
|------|--------------------|-------------|
| -20  | [0.192, 0.212, 0.584, 1.0] | `#313695` |
| 0    | [0.455, 0.678, 0.820, 1.0] | `#74add1` |
| 20   | [0.996, 0.878, 0.565, 1.0] | `#fee090` |
| 40   | [0.647, 0.0, 0.149, 1.0]   | `#a50026` |

### 8.2 线性插值原理

对于值 $v$ 落在节点 $[v_i, v_{i+1}]$ 之间：

$$t = \frac{v - v_i}{v_{i+1} - v_i} \quad (t \in [0, 1])$$

$$\text{color} = \text{color}_i \times (1 - t) + \text{color}_{i+1} \times t$$

```ts
const t = (value - lo.value) / (hi.value - lo.value)
return [
  lo.color[0] + t * (hi.color[0] - lo.color[0]),
  lo.color[1] + t * (hi.color[1] - lo.color[1]),
  lo.color[2] + t * (hi.color[2] - lo.color[2]),
  lo.color[3] + t * (hi.color[3] - lo.color[3])
]
```

### 8.3 为什么在 CPU 端预计算颜色？

理论上可以在片元着色器中实时插值颜色。但：

- CPU 端计算：每次 `updateData()` 计算一次，结果存入 Buffer，每帧渲染无额外开销
- GPU 端计算：每帧每个片元都需执行插值逻辑，对色标节点较多时性能较差

**静态数据预计算到 Buffer 是 WebGL 的最佳实践。**

---

## 9. 动态过滤：discard 指令

### 9.1 原理

`discard` 是 GLSL 内置指令，执行后当前片元**不会写入帧缓冲**，效果等同于该像素"不存在"。

```glsl
if (v_value < u_filterMin || v_value > u_filterMax) {
  discard;  // GPU 放弃这个像素，继续处理下一个
}
```

### 9.2 为什么不用 alpha=0？

- `alpha=0` 仍然会**写入帧缓冲**，触发混合操作，消耗带宽
- `discard` 在 Early Z 阶段或片元着色器中提前退出，节省后续处理

### 9.3 动态更新机制

过滤范围是通过 `uniform` 变量传递的，每帧都可以读取最新值：

```ts
// JS 端（每次滑块变化）
layer.setFilter(minTemp, maxTemp)
map.triggerRepaint()  // 通知 Mapbox 下一帧重绘

// GLSL 端（每帧 render() 中）
gl.uniform1f(loc.uFilterMin, this.filterMin)
gl.uniform1f(loc.uFilterMax, this.filterMax)
```

Uniform 是 CPU 到 GPU 的"全局变量"，性能代价极低（相当于写寄存器）。

---

## 10. 混合模式（Alpha Blending）

### 10.1 开启混合

```ts
gl.enable(gl.BLEND)
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
```

### 10.2 混合公式

标准 "over" 混合（Porter-Duff）：

$$\text{output.rgb} = \text{src.rgb} \times \text{src.a} + \text{dst.rgb} \times (1 - \text{src.a})$$

其中 `src` 是当前片元（格点层），`dst` 是帧缓冲中已有的颜色（地图底图）。

当 `src.a = 0.85` 时，格点层贡献 85%，底图贡献 15%，实现半透明效果。

### 10.3 注意事项

混合模式对**绘制顺序**敏感。Mapbox 已经管理好图层顺序，`CustomLayer` 作为一个整体按 `addLayer` 的顺序参与混合，无需手动干预。

---

## 11. CustomLayerInterface 生命周期

Mapbox GL JS 的 `CustomLayerInterface` 定义了以下必须实现的方法：

### 11.1 onAdd(map, gl)

**触发时机**：`map.addLayer(layer)` 调用后，地图内部完成图层注册时。

```ts
onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext) {
  // ✅ 在这里初始化 WebGL 资源
  // ✅ 在这里注册地图事件
  // ❌ 不要在构造函数中初始化 WebGL（此时还没有 gl 上下文）
}
```

### 11.2 render(gl, matrix)

**触发时机**：地图每次重绘时（平移、缩放、调用 `triggerRepaint()` 等）。

```ts
render(gl: WebGLRenderingContext, matrix: number[]) {
  // matrix 是 Float32Array，长度 16，代表 4×4 列主序矩阵
  // ✅ 在这里执行 drawElements
  // ✅ 可以读取最新的 uniform 值（实现动态更新）
  // ❌ 不要在这里创建/删除 Buffer（性能极差）
}
```

### 11.3 onRemove(map, gl)

**触发时机**：`map.removeLayer(layerId)` 或 `map.remove()` 时。

```ts
onRemove(map: mapboxgl.Map, gl: WebGLRenderingContext) {
  // ✅ 释放所有 WebGL 资源（Program, Buffer, Texture）
  // ✅ 移除事件监听器
}
```

### 11.4 renderingMode

```ts
readonly renderingMode = '2d' as const
```

- `'2d'`：在 Mapbox 的 2D 图层之后、3D 图层之前渲染
- `'3d'`：参与 Mapbox 的 3D 深度排序，适用于 3D 建筑等场景

格点图通常使用 `'2d'`。

---

## 12. 点击事件与空间查询

### 12.1 策略：CPU 端反算，不依赖 GPU Picking

GPU Picking 方案（将对象 ID 编码为颜色，读取帧缓冲）虽然通用，但需要 `readPixels` 同步读取，会造成 GPU-CPU 管线停顿。

对于规则格点，CPU 端反算效率更高：

```ts
// 已知点击的经纬度 (lng, lat)
// 格点起始坐标 (lonStart, latStart) 和分辨率 (lonStep, latStep)

const col = Math.floor((lng - lonStart) / lonStep)
const row = Math.floor((lat - latStart) / latStep)

// 时间复杂度 O(1)，无 GPU 同步开销
const value = values[row][col]
```

### 12.2 事件注册与清理

```ts
// 注册
const handleClick = (e) => { /* ... */ }
map.on('click', handleClick)

// 清理（保存引用以便移除相同函数）
this.clickCleanup = () => map.off('click', handleClick)
```

**注意**：`map.off()` 要求传入与 `map.on()` 完全相同的函数引用，不能用匿名函数。

---

## 13. 资源管理与内存泄漏防范

WebGL 资源（Program、Buffer、Texture）存储在 GPU 显存。如果不主动释放，即使 JS 对象被垃圾回收，GPU 显存仍然占用。

### 13.1 需要释放的资源

```ts
gl.deleteProgram(this.program)    // 着色器程序
gl.deleteBuffer(this.vertexBuffer) // 顶点坐标 Buffer
gl.deleteBuffer(this.colorBuffer)  // 颜色 Buffer
gl.deleteBuffer(this.valueBuffer)  // 数值 Buffer
gl.deleteBuffer(this.indexBuffer)  // 索引 Buffer
// 若有 Texture：gl.deleteTexture(texture)
```

### 13.2 着色器对象的优化

```ts
// 链接完成后，着色器对象对 Program 没有影响了，可以删除节省内存
gl.deleteShader(vertexShader)
gl.deleteShader(fragmentShader)
```

### 13.3 Map 销毁时的级联清理

```ts
onUnmounted(() => {
  // map.remove() 会调用所有图层的 onRemove()，从而触发 WebGL 资源释放
  map.remove()
})
```

---

## 14. 性能关键点汇总

| 优化点 | 实现方式 | 收益 |
|--------|----------|------|
| **索引缓冲** | 使用 `ELEMENT_ARRAY_BUFFER` | 减少顶点数据量约 3/4 |
| **STATIC_DRAW** | `bufferData` 第三参数 | GPU 优化显存位置，提升带宽 |
| **预计算颜色** | 在 CPU 端 `onAdd` 时计算，存入 Buffer | 减少每帧 GPU 计算量 |
| **discard 过滤** | GLSL `discard` 而非 `alpha=0` | 减少帧缓冲写入操作 |
| **Uniform 缓存** | `getUniformLocation` 结果缓存到成员变量 | 避免每帧重复查询 |
| **Attribute 缓存** | `getAttribLocation` 结果缓存 | 避免每帧重复查询 |
| **着色器对象删除** | 链接后 `deleteShader` | 节省 GPU 显存 |
| **triggerRepaint 控制** | 只在数据变化时调用 | 避免不必要的重绘 |

---

## 15. 常见问题 FAQ

### Q1：地图加载后格点图层不显示？

**排查步骤：**
1. 确认在 `map.on('load', ...)` 回调内调用 `map.addLayer()`
2. 打开浏览器控制台，查看是否有 WebGL 错误信息
3. 确认 `gridData` 的经纬度范围与地图视野重叠
4. 检查 `colorStops` 至少包含 2 个节点

### Q2：过滤后格点颜色变成黑色而不是消失？

原因：`discard` 只在片元着色器中有效。如果你看到黑色，说明片元着色器没有正确运行，可能是 Uniform 变量名拼写错误导致过滤条件始终为 false，但 `gl_FragColor` 没有被赋值（默认是 (0,0,0,0)，即黑色透明）。

检查 `u_filterMin` / `u_filterMax` 的拼写是否与 GLSL 中完全一致。

### Q3：渲染性能差，帧率低？

**可能原因：**
- `generateGridData()` 放在 `render()` 中（每帧重建数据）→ 应该只在 `onAdd` 时调用一次
- Buffer 在 `render()` 中频繁重建 → 确保 `_buildBuffers` 只在数据更新时调用
- 格点数量过大（如 1000×1000）→ 考虑降分辨率或分块渲染

### Q4：点击事件不准确？

检查 `lonStep` / `latStep` 的精度，以及格点数组的行列对应关系（通常 row=0 对应最南端纬度）。

### Q5：`OES_element_index_uint` 不支持怎么办？

极少数旧设备不支持此扩展。解决方案：将大格点数据分成多个 65535 顶点以内的子块分别绘制，或将索引分段存储为 `Uint16Array`。

现代移动端（iOS Safari 8+、Android Chrome 30+）均已支持此扩展，实际项目中几乎不会遇到问题。

---

> 文档版本：v1.0.0 | 最后更新：2026-03-02
