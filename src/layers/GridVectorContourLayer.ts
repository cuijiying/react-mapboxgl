/**
 * GridVectorContourLayer.ts
 *
 * 基于 GeoJSON 的矢量等值线 / 等值面及数值标注。
 * 图层使用 slot: 'top'，确保渲染在 Custom Layer（GPU 色斑图）之上。
 */

import mapboxgl from 'mapbox-gl'
import type { ColorStop, GridData } from '@/layers/GridLayer2'
import type { BandMeta } from '@/utils/gridContour'
import {
  generateContourBandsGeoJSON,
  generateContourLabelGeoJSON,
  generateContourLinesGeoJSON
} from '@/utils/gridContour'

export type VectorContourDisplayMode = 'none' | 'lines' | 'filled' | 'filled+lines'

export interface GridVectorContourOptions {
  layerId?: string
  gridData: GridData
  colorStops: ColorStop[]
  displayMode?: VectorContourDisplayMode
  filterMin?: number
  filterMax?: number
  lineWidth?: number
  fillOpacity?: number
  showLabels?: boolean
  formatLabel?: (value: number) => string
  /** 等值线/面平滑迭代次数，0 = 不平滑，默认 2 */
  smoothIterations?: number
  /** 等值面 Catmull-Rom 每段采样数，默认 8 */
  bandSmoothIterations?: number
  /** 等值面边界提取前的格点上采样倍数，默认 2 */
  bandUpsampleFactor?: number
}

export class GridVectorContourLayer {
  readonly id: string

  private map: mapboxgl.Map | null = null
  private gridData: GridData
  private colorStops: ColorStop[]
  private displayMode: VectorContourDisplayMode
  private filterMin: number
  private filterMax: number
  private lineWidth: number
  private fillOpacity: number
  private showLabels: boolean
  private formatLabel: (value: number) => string
  private smoothIterations: number
  private bandSmoothIterations: number
  private bandUpsampleFactor: number

  private readonly sourceFillId: string
  private readonly sourceLineId: string
  private readonly sourceLabelId: string
  private readonly layerFillId: string
  private readonly layerLineId: string
  private readonly layerLabelId: string

  private lineFeatures: GeoJSON.Feature[] = []
  private bandMetas: BandMeta[] = []

  constructor(options: GridVectorContourOptions) {
    const baseId = options.layerId ?? 'grid-vector-contour'
    this.id = baseId
    this.sourceFillId = `${baseId}-fill-source`
    this.sourceLineId = `${baseId}-line-source`
    this.sourceLabelId = `${baseId}-label-source`
    this.layerFillId = `${baseId}-fill`
    this.layerLineId = `${baseId}-line`
    this.layerLabelId = `${baseId}-label`

    this.gridData = options.gridData
    this.colorStops = [...options.colorStops].sort((a, b) => a.value - b.value)
    this.displayMode = options.displayMode ?? 'none'
    this.filterMin = options.filterMin ?? this.colorStops[0]!.value
    this.filterMax = options.filterMax ?? this.colorStops[this.colorStops.length - 1]!.value
    this.lineWidth = options.lineWidth ?? 2
    this.fillOpacity = options.fillOpacity ?? 0.45
    this.showLabels = options.showLabels ?? true
    this.formatLabel = options.formatLabel ?? ((v) => String(Math.round(v * 10) / 10))
    this.smoothIterations = options.smoothIterations ?? 2
    this.bandSmoothIterations = options.bandSmoothIterations ?? 0
    this.bandUpsampleFactor = options.bandUpsampleFactor ?? 4
  }

  addTo(map: mapboxgl.Map): void {
    this.map = map
    this._ensureSourcesAndLayers()
    this._rebuildGeoJSON()
  }

  remove(): void {
    if (!this.map) return
    const map = this.map

    for (const layerId of [this.layerLabelId, this.layerLineId, this.layerFillId]) {
      if (map.getLayer(layerId)) map.removeLayer(layerId)
    }
    for (const sourceId of [this.sourceLabelId, this.sourceLineId, this.sourceFillId]) {
      if (map.getSource(sourceId)) map.removeSource(sourceId)
    }

    this.map = null
  }

  setDisplayMode(mode: VectorContourDisplayMode): void {
    this.displayMode = mode
    this._rebuildGeoJSON()
  }

  getDisplayMode(): VectorContourDisplayMode {
    return this.displayMode
  }

  setFilter(min: number, max: number): void {
    this.filterMin = min
    this.filterMax = max
    this._rebuildGeoJSON()
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show
    this._updateLayerVisibility()
  }

  setFillOpacity(opacity: number): void {
    this.fillOpacity = Math.max(0, Math.min(1, opacity))
    if (this.map?.getLayer(this.layerFillId)) {
      this.map.setPaintProperty(this.layerFillId, 'fill-opacity', this.fillOpacity)
    }
  }

  updateData(gridData: GridData): void {
    this.gridData = gridData
    this._rebuildGeoJSON()
  }

  updateColorStops(colorStops: ColorStop[]): void {
    this.colorStops = [...colorStops].sort((a, b) => a.value - b.value)
    this._rebuildGeoJSON()
  }

  /** 矢量层是否处于可见模式 */
  isActive(): boolean {
    return this.displayMode !== 'none'
  }

  private _layerSpec(base: mapboxgl.LayerSpecification): mapboxgl.LayerSpecification {
    // slot: 'top' 使矢量层渲染在 Custom Layer 之上（Mapbox GL v3）
    return { ...base, slot: 'top' } as mapboxgl.LayerSpecification
  }

  private _ensureSourcesAndLayers(): void {
    if (!this.map) return
    const map = this.map
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

    if (!map.getSource(this.sourceFillId)) {
      map.addSource(this.sourceFillId, { type: 'geojson', data: empty })
    }
    if (!map.getSource(this.sourceLineId)) {
      map.addSource(this.sourceLineId, { type: 'geojson', data: empty })
    }
    if (!map.getSource(this.sourceLabelId)) {
      map.addSource(this.sourceLabelId, { type: 'geojson', data: empty })
    }

    if (!map.getLayer(this.layerFillId)) {
      map.addLayer(
        this._layerSpec({
          id: this.layerFillId,
          type: 'fill',
          source: this.sourceFillId,
          paint: {
            'fill-color': ['get', 'fillColor'],
            'fill-opacity': this.fillOpacity,
            'fill-antialias': true
          },
          layout: {
            visibility: 'none',
            'fill-sort-key': ['get', 'bandIndex']
          }
        })
      )
    }

    if (!map.getLayer(this.layerLineId)) {
      map.addLayer(
        this._layerSpec({
          id: this.layerLineId,
          type: 'line',
          source: this.sourceLineId,
          paint: {
            'line-color': ['get', 'lineColor'],
            'line-width': this.lineWidth,
            'line-opacity': 1
          },
          layout: {
            visibility: 'none',
            'line-join': 'round',
            'line-cap': 'round'
          }
        })
      )
    }

    // 标注层最后添加，确保在等值线之上
    if (!map.getLayer(this.layerLabelId)) {
      map.addLayer(
        this._layerSpec({
          id: this.layerLabelId,
          type: 'symbol',
          source: this.sourceLabelId,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 12,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            visibility: 'none'
          },
          paint: {
            'text-color': '#111111',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
          }
        })
      )
    }
  }

  private _rebuildGeoJSON(): void {
    if (!this.map) return

    const filterOpts = {
      filterMin: this.filterMin,
      filterMax: this.filterMax,
      smoothIterations: this.smoothIterations,
      bandSmoothIterations: this.bandSmoothIterations,
      bandUpsampleFactor: this.bandUpsampleFactor
    }

    this.lineFeatures = generateContourLinesGeoJSON(
      this.gridData,
      this.colorStops,
      filterOpts
    ).features

    const bandResult = generateContourBandsGeoJSON(
      this.gridData,
      this.colorStops,
      filterOpts
    )
    this.bandMetas = bandResult.bandMetas

    const showFill = this.displayMode === 'filled' || this.displayMode === 'filled+lines'
    const showLine = this.displayMode === 'lines' || this.displayMode === 'filled+lines'

    const labelData = generateContourLabelGeoJSON({
      lineFeatures: showLine ? this.lineFeatures : [],
      bandMetas: showFill ? this.bandMetas : [],
      formatValue: this.formatLabel
    })

    const fillSource = this.map.getSource(this.sourceFillId) as mapboxgl.GeoJSONSource
    const lineSource = this.map.getSource(this.sourceLineId) as mapboxgl.GeoJSONSource
    const labelSource = this.map.getSource(this.sourceLabelId) as mapboxgl.GeoJSONSource

    fillSource?.setData(bandResult.collection)
    lineSource?.setData({ type: 'FeatureCollection', features: this.lineFeatures })
    labelSource?.setData(labelData)

    this._updateLayerVisibility()
  }

  private _updateLayerVisibility(): void {
    if (!this.map) return
    const map = this.map

    const showFill = this.displayMode === 'filled' || this.displayMode === 'filled+lines'
    const showLine = this.displayMode === 'lines' || this.displayMode === 'filled+lines'
    const showLabel = this.showLabels && this.displayMode !== 'none'

    map.setLayoutProperty(this.layerFillId, 'visibility', showFill ? 'visible' : 'none')
    map.setLayoutProperty(this.layerLineId, 'visibility', showLine ? 'visible' : 'none')
    map.setLayoutProperty(this.layerLabelId, 'visibility', showLabel ? 'visible' : 'none')
  }
}
