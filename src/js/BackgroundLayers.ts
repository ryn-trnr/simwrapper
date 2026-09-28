import * as turf from '@turf/turf'
import * as d3ScaleChromatic from 'd3-scale-chromatic'
import { scaleSequential, scaleOrdinal } from 'd3-scale'
import { rgb } from 'd3-color'
import { GeoJsonLayer } from '@deck.gl/layers'

import Geotools from '@/js/geo-utils'
import ColorWidthSymbologizer, { buildRGBfromHexCodes } from '@/js/ColorsAndWidths'
import { streamShapefileFeatures } from '@/js/streamShapefile'

export interface BackgroundLayer {
  features: any[]
  opacity: number
  borderWidth: number
  borderColor: number[]
  visible: boolean
  onTop: boolean
}

export default class BackgroundLayers {
  bgLayers: { [id: string]: BackgroundLayer } = {}
  fileApi: any
  subfolder: string
  vizDetails: any

  /** after instantiation, user should call initialLoad() */
  constructor(props: { vizDetails: any; subfolder: string; fileApi: any }) {
    this.vizDetails = props.vizDetails
    this.subfolder = props.subfolder
    this.fileApi = props.fileApi
  }

  public layers() {
    const layersBelow = [] as any[]
    const layersOnTop = [] as any[]

    for (const name of Object.keys(this.bgLayers).reverse()) {
      const layerDetails = this.bgLayers[name]

      const bgLayer: any = new GeoJsonLayer({
        id: `background-layer-${name}`,
        beforeId: layerDetails.onTop ? undefined : 'water',
        data: layerDetails.features,
        getFillColor: (d: any) => d.properties.__fill__,
        getLineColor: layerDetails.borderColor,
        getLineWidth: layerDetails.borderWidth,
        getText: (d: any) => d.properties.label,
        getTextSize: 12,
        getTextColor: [255, 255, 255, 255],
        getTextBackgroundColor: [0, 0, 0, 255],
        pointType: 'circle+text',
        textFontWeight: 'bold',
        lineWidthUnits: 'pixels',
        autohighlight: false,
        opacity: layerDetails.opacity,
        pickable: false,
        stroked: layerDetails.borderWidth ? true : false,
        fp64: false,
        parameters: { depthTest: false },
        visible: layerDetails.visible,
      } as any)

      if (layerDetails.onTop) {
        layersOnTop.push(bgLayer)
      } else {
        layersBelow.push(bgLayer)
      }
    }
    return { layersBelow, layersOnTop }
  }

  async loadShapefileFeatures(filename: string) {
    console.log('loading', filename)

    // Stream the shapefile, keeping properties on the features (they are used
    // for labels / fills). No full-file buffer or FeatureCollection copy.
    const result = await streamShapefileFeatures({
      fileApi: this.fileApi,
      subfolder: this.subfolder,
      filename,
      projection: this.vizDetails.projection,
      keepProperties: true,
    })

    const features = result.boundaries

    function getFirstPoint(thing: any): any[] {
      if (Array.isArray(thing[0])) return getFirstPoint(thing[0])
      else return [thing[0], thing[1]]
    }

    // check if we have lon/lat
    if (features.length) {
      const firstPoint = getFirstPoint(features[0].geometry.coordinates)
      if (Math.abs(firstPoint[0]) > 180 || Math.abs(firstPoint[1]) > 90) {
        const msg = `Coordinates not lon/lat. Try adding projection to YAML, or provide a .prj file`
        throw Error(msg)
      }
    }

    return features as any[]
  }

  async loadGeoPackage(filename: string) {
    console.log('loading', filename)
    const url = `${this.subfolder}/${filename}`
    const blob = await this.fileApi.getFileBlob(url)
    const buffer = await blob.arrayBuffer()
    const geo = Geotools.loadGeoPackageFromBuffer(buffer)
    return geo
  }

  public async initialLoad() {
    this.bgLayers = {}

    if (!this.vizDetails.backgroundLayers) {
      this.vizDetails.backgroundLayers = {}
      return
    }

    for (const layerName of Object.keys(this.vizDetails.backgroundLayers)) {
      console.log('LOADING', layerName)
      const layerDetails = this.vizDetails.backgroundLayers[layerName]

      if (!layerDetails.shapes) continue

      let features = [] as any[]
      const filename = layerDetails.shapes
      if (filename.startsWith('http'))
        features = (await fetch(filename).then(async r => await r.json())).features
      else if (filename.toLocaleLowerCase().endsWith('.gpkg'))
        features = await this.loadGeoPackage(filename)
      else if (filename.toLocaleLowerCase().endsWith('.shp'))
        features = await this.loadShapefileFeatures(filename)
      else features = (await this.fileApi.getFileJson(`${this.subfolder}/${filename}`)).features

      // Fill colors ---
      let colors = null as any
      let scale: any
      if (layerDetails.fill && !layerDetails.fill.startsWith('#')) {
        let isCategorical = false
        if (layerDetails.fill.startsWith('scheme')) isCategorical = true
        // @ts-ignore
        scale = d3ScaleChromatic[layerDetails.fill]
        if (!scale) {
          // @ts-ignore
          scale = d3ScaleChromatic[`interpolate${layerDetails.fill}`]
        }
        if (!scale) {
          // @ts-ignore
          scale = d3ScaleChromatic[`scheme${layerDetails.fill}`]
          if (scale) isCategorical = true
        }
        if (scale) {
          let ramp: any = scaleSequential(scale)
          if (!ramp) {
            ramp = scaleOrdinal(scale)
          }

          colors = Array.from({ length: features.length }, (_, i) => {
            const c = isCategorical
              ? rgb(scale[i % scale.length])
              : rgb(ramp(i / (features.length - 1)))
            return [c.r, c.g, c.b]
          })
        }
      }

      let oneColor
      if (!scale) {
        oneColor = buildRGBfromHexCodes([layerDetails.fill])[0]
      }

      for (let i = 0; i < features.length; i++) {
        const feature = features[i]
        let __fill__ = [64, 64, 192, 64]
        if (layerDetails.fill) __fill__ = oneColor || colors[i]
        feature.properties.__fill__ = __fill__
      }

      // Text labels ---
      if (layerDetails.label) {
        const labels = [] as any
        for (const feature of features) {
          const centroid = turf.centerOfMass(feature)
          if (!centroid.properties) centroid.properties = {}
          centroid.properties.label = feature.properties[layerDetails.label]
          labels.push(centroid)
        }
        features = features.concat(labels)
      }

      // borders ---
      const borderColor = layerDetails.borderColor
        ? buildRGBfromHexCodes([layerDetails.borderColor])[0]
        : [255, 255, 255]
      let borderWidth = 'borderWidth' in layerDetails ? parseFloat(layerDetails.borderWidth) : 0

      const opacity = layerDetails.opacity || 1.0

      let visible = true
      if ('visible' in layerDetails) visible = layerDetails.visible

      let onTop = false
      if ('onTop' in layerDetails) onTop = !!layerDetails.onTop
      if ('ontop' in layerDetails) onTop = !!layerDetails.ontop

      // console.log('FINAL FEATURES', features)

      const details = {
        features,
        opacity,
        borderWidth,
        borderColor,
        visible,
        onTop,
      }
      this.bgLayers[layerName] = details
      this.bgLayers = { ...this.bgLayers }
      console.log('LOADED BG LAYERS')
    }
  }
}
