# GridLayer2 — 基于 GPU 纹理采样的高性能格点图层

## 概述

`GridLayer2` 是对 `GridLayer`（V1）的工业级优化重构。核心思想是**将数据存入 GPU 纹理，由片元着色器实时采样着色**，而不是在 CPU 侧逐格构建三角形网格。

### 一句话总结

> **V1：每个格子 2 个三角形 → 百万级顶点 → CPU/GPU 双重瓶颈**  
> **V2：整张图只有 4 个顶点 + 2 张纹理 → GPU 采样完成一切**

---

## 架构对比

### V1（GridLayer）传统做法

```
CPU 侧：
  for 每个格子 (rows × cols):
    创建 4 个顶点
    创建 2 个三角形（6 个索引）
    为每个顶点计算颜色（interpolateColor）
  上传 positions[], colors[], values[], indices[] 到 GPU

GPU 侧：
  对每个三角形执行顶点着色器 → 光栅化 → 片元着色器
```

**问题**：
- 100×200 的网格 → 20301 顶点 + 120000 索引
- 500×1000 的网格 → 501501 顶点 + 3000000 索引 → CPU 构建时间可能达到秒级
- 换色标需要重新遍历所有顶点计算颜色

### V2（GridLayer2）纹理采样做法

```
CPU 侧：
  创建 4 个顶点（矩形四个角）
  将 rows×cols 数据展平为 Uint8Array → 上传为 GPU 纹理
  将色标渲染为 256×1 像素数组 → 上传为 GPU 色带纹理

GPU 侧（片元着色器）：
  1. texture2D(dataTexture, uv) → 采样得到归一化值 t
  2. texture2D(colorRamp, vec2(t, 0.5)) → 查找颜色
  3. 过滤 + 透明度 → 输出
```

**优势**：
| 指标 | V1 | V2 |
|------|----|----|
| 顶点数 | (rows+1)×(cols+1) | **4** |
| 索引数 | rows×cols×6 | **6** |
| CPU 构建耗时 | O(rows×cols) | **O(1)** |
| 换色标 | 重算所有顶点颜色 | **只更新 256 像素** |
| 更新数据 | 重建全部缓冲 | **texSubImage2D 增量传输** |
| 深度测试 | 开启（默认） | **关闭（disable depthTest）** |

---

## 核心优化要点详解

### 1. 纹理存储数据 — 不再逐格建三角形

传统做法是为每个格点创建顶点和三角形，数据量与格点数成正比。V2 将整个矩形区域只用 4 个顶点覆盖，格点数据以纹理形式存储在 GPU 显存中。

```
传统做法（V1）：
  顶点数 = (101) × (201) = 20,301
  索引数 = 100 × 200 × 6 = 120,000

纹理做法（V2）：
  顶点数 = 4（固定）
  纹理大小 = 100 × 200 = 20,000 字节
```

**数据纹理格式选择**：`LUMINANCE + UNSIGNED_BYTE`
- `LUMINANCE`：单通道灰度纹理，采样返回 `(L, L, L, 1.0)`
- `UNSIGNED_BYTE`：8 位精度，[0, 255] → 归一化后 [0.0, 1.0]
- 精度 ≈ 1/255 ≈ 0.004，对温度场景完全够用
- 兼容性最好，无需扩展

### 2. Color Ramp 纹理 — GPU 端颜色查找

将色标数组预渲染为 **256×1 的 RGBA 纹理**：

```
像素 0   → 色标最小值的颜色（如 -20°C → 深蓝）
像素 127 → 色标中间值的颜色（如 10°C → 浅蓝）
像素 255 → 色标最大值的颜色（如 40°C → 深红）
```

片元着色器只需一次纹理采样即可完成 `value → color` 映射：

```glsl
// t 是归一化后的数据值 [0, 1]
vec4 color = texture2D(u_colorRamp, vec2(t, 0.5));
```

**动态换色的优势**：
- V1：换色标需要遍历所有顶点重新计算颜色 → O(rows × cols)
- V2：只需重新生成 256 像素的色带纹理 → O(256)

### 3. texSubImage2D — 增量数据更新

`texSubImage2D` 与 `texImage2D` 的区别：

| 函数 | 作用 | 性能开销 |
|------|------|---------|
| `texImage2D` | 重新分配纹理显存 + 上传数据 | 高（内存分配） |
| `texSubImage2D` | 直接修改已有纹理的像素 | 低（仅数据传输） |

```typescript
// 高效的增量更新：
gl.texSubImage2D(
  gl.TEXTURE_2D,
  0,            // mipmap level
  0, 0,         // x, y 偏移
  cols, rows,   // 更新区域大小
  gl.LUMINANCE, // 格式
  gl.UNSIGNED_BYTE,
  newPixels     // 新数据
)
```

**适用场景**：
- 时间序列动画（如逐小时温度预报）
- 实时数据推送（如传感器数据流）
- 每帧只传输数据，不重建 GPU 资源

### 4. 关闭 depthTest — 减少 GPU 管线开销

```typescript
gl.disable(gl.DEPTH_TEST)
```

2D 覆盖图层不需要深度比较，关闭后：
- 跳过深度缓冲区读写
- 减少 GPU 每像素处理开销
- 避免深度冲突导致的 z-fighting 闪烁

### 5. 像素对齐优化

```typescript
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
```

WebGL 默认行对齐为 4 字节，但 `LUMINANCE` 纹理每行字节数 = cols。若 cols 不是 4 的倍数，会读取错误像素。设为 1 字节对齐可避免此问题。

---

## 着色器详解

### 顶点着色器

```glsl
attribute vec2 a_position;    // Mercator 坐标 (x, y)，范围 [0, 1]
attribute vec2 a_texCoord;    // 纹理坐标 (u, v)，范围 [0, 1]
uniform mat4 u_matrix;        // MVP 矩阵
varying vec2 v_texCoord;

void main() {
    gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
```

只有 4 个顶点通过此着色器，GPU 在三角形内部自动对 `v_texCoord` 做双线性插值。

### 片元着色器

```glsl
uniform sampler2D u_dataTexture;  // 数据纹理
uniform sampler2D u_colorRamp;    // 色带纹理
uniform float u_filterMin, u_filterMax;
uniform float u_dataMin, u_dataMax;   // 实际数据值域（纹理归一化基准）
uniform float u_colorMin, u_colorMax; // 色标值域（色带映射基准）
uniform float u_opacity;
varying vec2 v_texCoord;

void main() {
    // 1. 采样数据纹理 → 归一化值 t
    float t = texture2D(u_dataTexture, v_texCoord).r;

    // 2. 用 dataMin/dataMax 反算真实值并过滤
    float realValue = u_dataMin + t * (u_dataMax - u_dataMin);
    if (realValue < u_filterMin || realValue > u_filterMax) discard;

    // 3. 用 colorMin/colorMax 重新映射到色带纹理坐标，查找颜色
    float colorT = clamp((realValue - u_colorMin) / (u_colorMax - u_colorMin), 0.0, 1.0);
    vec4 color = texture2D(u_colorRamp, vec2(colorT, 0.5));

    // 4. 应用透明度
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
}
```

**整个过程只有 2 次纹理采样 + 1 次比较 + 1 次乘法**，非常高效。

### 🔑 为什么需要两套值域（dataMin/dataMax 与 colorMin/colorMax）？

这是理解片元着色器的关键。两套值域分别服务于不同的映射阶段：

| 值域 | 来源 | 用途 | 示例 |
|------|------|------|------|
| `dataMin/dataMax` | 实际数据的最小/最大值（至少覆盖色标） | 数据纹理归一化基准：决定纹理字节如何反算为真实值 | `-10, 50` |
| `colorMin/colorMax` | 色标数组的第一/最后个节点值 | 色带纹理映射基准：决定真实值如何映射到色带坐标 | `0, 40` |

**典型场景**：色标定义了 0°C（蓝）到40°C（红）的颜色映射，但实际数据范围是 -10°C 到50°C。

```
映射流程：
  纹理字节(0~255)  ──dataMin/dataMax──►  真实值(-10~50)  ──colorMin/colorMax──►  色带坐标(0.0~1.0)  ─►  颜色

如果只用一套值域：
  假设用 colorMin/colorMax=[0,40] 归一化数据纹理，
  那么 -10°C 和 0°C 都会被 clamp 到纹理值 0，无法区分——过滤功能就失效了。
  用实际数据值域 [-10,50] 做归一化，所有值都能被精确保留。
```

---

## 纹理坐标映射说明

```
地理空间             纹理空间           屏幕空间
                    v=0 (顶部)
  latMax ─────────  ┌──────────┐     ┌──────────┐
  (高纬)            │ row=last │     │          │
                    │          │     │  渲染结果 │
  latMin ─────────  └──────────┘     └──────────┘
  (低纬)            v=1 (底部)

  lonMin  lonMax    u=0    u=1
```

纹理的 v=0 对应图像顶部（数据最后一行 = 最高纬度），所以左下角顶点（最低纬度）的 v=1。

---

## API 文档

### 构造选项 `GridLayer2Options`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `layerId` | `string` | `'grid-layer-2'` | 图层唯一标识 |
| `gridData` | `GridData` | *必填* | 格点数据 |
| `colorStops` | `ColorStop[]` | *必填* | 色标分段（≥2 个节点） |
| `opacity` | `number` | `0.85` | 全局透明度 [0, 1] |
| `filterMin` | `number` | 色标最小值 | 初始过滤下限 |
| `filterMax` | `number` | 色标最大值 | 初始过滤上限 |

### 公共方法

#### `setFilter(min: number, max: number)`
设置数据值过滤范围，超出范围的像素被 discard。自动触发重绘。

#### `setOpacity(opacity: number)`
动态修改全局透明度 [0, 1]。自动触发重绘。

#### `updateData(newData: GridData)`
使用 `texSubImage2D` 增量更新数据纹理。适用于时间动画场景。
- 行列数不变时：使用 `texSubImage2D`（高效）
- 行列数变化时：使用 `texImage2D` 重建纹理

#### `updateColorStops(newColorStops: ColorStop[])`
动态更换色标。会重建 256×1 的色带纹理，并重新计算数据归一化基准（因为 dataMin/dataMax 依赖色标范围）。
性能开销极低：重新生成 256 像素 + 重新归一化数据纹理。

#### `getBounds()`
获取格点数据的地理范围 `{ lonMin, lonMax, latMin, latMax }`。

#### `getFilter()`
获取当前过滤范围 `{ min, max }`。

---

## 使用示例

### 基础用法

```typescript
import { GridLayer2 } from '@/layers/GridLayer2'

const layer = new GridLayer2({
  gridData: myGridData,
  colorStops: myColorStops,
  opacity: 0.8,
  onClick: (info) => {
    console.log(`温度: ${info.value}°C, 位置: (${info.row}, ${info.col})`)
  }
})

map.addLayer(layer)
```

### 时间动画

```typescript
// 每秒更新一帧数据
setInterval(() => {
  const newData = fetchTemperatureData(currentTime++)
  layer.updateData(newData) // 内部用 texSubImage2D，高效！
}, 1000)
```

### 动态换色标

```typescript
// 切换到蓝绿色标（RGBA 范围 [0, 255]）
layer.updateColorStops([
  { value: -20, color: [0, 0, 128, 255] },
  { value: 40, color: [0, 255, 0, 255] }
])
```

---

## Demo 演示功能

`GridLayer2Demo.vue` 展示了所有核心能力：

1. **温度过滤**：双滑条控制显示范围，实时 discard 超出范围的像素
2. **透明度调整**：滑条控制全局 alpha
3. **时间动画**：播放/暂停/重置按钮，模拟 48 帧温度变化，每帧通过 `updateData()` + `texSubImage2D` 更新
4. **色标切换**：经典（蓝红）/ 生态（绿棕）/ 等离子（紫黄）三种色带方案，一键切换
5. **格点点击**：点击显示经纬度、行列索引和温度值

---

## 性能对比

以下是 100×200 网格的理论对比（实际性能取决于 GPU）：

| 指标 | V1 (GridLayer) | V2 (GridLayer2) | 提升 |
|------|---------------|-----------------|------|
| 顶点数 | 20,301 | 4 | **5075×** |
| 索引数 | 120,000 | 6 | **20000×** |
| CPU 缓冲构建 | ~10ms | ~0.1ms | **~100×** |
| GPU 三角形数 | 40,000 | 2 | **20000×** |
| 换色标 | 重建全部缓冲 | 更新 256 像素 | **显著** |
| 更新数据 | bufferData 重传 | texSubImage2D | **更省** |
| 显存占用 | positions + colors + values + indices | 2 张纹理 | **更省** |

## 关键实现细节

### `_computeDataRange` 中 Infinity 的用法

```typescript
let min = Infinity      // 任何有效数字都 < Infinity，自动成为新 min
let max = -Infinity     // 任何有效数字都 > -Infinity，自动成为新 max
```

这是 JavaScript 中求最小/最大值的**标准算法模式**。遍历结束后：
- 若 `min` 仍为 `Infinity` → 没有找到任何有效数据（全部为 `undefined`）
- 此时回退使用色标范围 `[colorMin, colorMax]`，避免着色器除零崩溃

为什么不用 `Math.min(...flatArray)`？因为格点数据可能包含 `undefined`（缺测值），需要逐个跳过。

### 像素对齐（UNPACK_ALIGNMENT）

LUMINANCE 纹理每行只有 `cols` 字节。WebGL 默认行对齐为 4 字节，若 `cols % 4 !== 0`，上传的像素数据会错位。

```
例：cols = 5，每行 5 字节
  WebGL 默认 UNPACK_ALIGNMENT=4 时期望每行 8 字节（5 → 对齐到 8）
  → 第 2 行开始就会读错位置！

解决：gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)  // 逐字节对齐
上传完成后恢复：gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
```

### UNPACK_FLIP_Y 状态管理

设置 `gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)` 会影响 **所有后续纹理上传**（包括 Mapbox 内部的纹理操作），因为自定义图层与 Mapbox 共享同一个 WebGL 上下文。必须在上传完成后立即恢复为 0。

---

## 局限性与注意事项

1. **精度**：数据归一化到 8 位 (0-255)，精度约 0.004。如需更高精度，可使用 RG 双通道拼接 16 位或启用 `OES_texture_float` 扩展使用 FLOAT 纹理
2. **纹理尺寸上限**：受 `gl.MAX_TEXTURE_SIZE` 限制（通常 4096 或 8192）。超大网格可能需要分块
3. **双线性插值**：纹理采样使用 `LINEAR` 模式，格点间颜色平滑过渡。如果需要格子边界清晰的效果，可改为 `NEAREST`
4. **非均匀格点**：当前实现假设等间距网格。如果格点不等距，需要在顶点着色器中进行坐标变换

---

## 文件结构

```
src/
  layers/
    GridLayer.ts         ← V1 传统逐格三角形方案
    GridLayer2.ts        ← V2 纹理采样优化方案（本文档）
  views/
    GridLayerDemo.vue    ← V1 演示
    GridLayer2Demo.vue   ← V2 演示（含动画、换色）
```
