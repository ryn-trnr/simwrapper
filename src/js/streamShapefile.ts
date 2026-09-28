/**
 * streamShapefile: memory-friendly shapefile loader.
 *
 * Instead of buffering the whole .shp/.dbf into Blobs/ArrayBuffers and then
 * materialising a full GeoJSON FeatureCollection (plus a duplicate
 * featureProperties array that gets structured-cloned into a worker), this
 * streams the .shp/.dbf directly from the file store and builds the geometry
 * list + columnar DataTable in a single pass.
 *
 * The npm `shapefile` package accepts WhatWG ReadableStreams, so the browser
 * downloads and the parser consume the file incrementally.
 */

import * as shapefile from 'shapefile'

import HTTPFileSystem from '@/js/HTTPFileSystem'
import Coords from '@/js/Coords'
import { DataTable, DataTableColumn, DataType, DEFAULT_PROJECTION } from '@/Globals'

export interface StreamShapefileOptions {
  fileApi: HTTPFileSystem
  subfolder: string
  filename: string
  /** projection override from YAML, if any */
  projection?: string
  /** store numbers as Float64Array instead of Float32Array */
  highPrecision?: boolean
  /** progress callback for status text */
  onProgress?: (status: string) => void
  /** keep feature properties on the returned boundaries (no DataTable built) */
  keepProperties?: boolean
  /** keep/drop columns (from viz config) */
  drop?: string[] | string
  keep?: string[] | string
}

export interface StreamShapefileResult {
  boundaries: any[]
  dataTable: DataTable
  /** the CRS inferred from .prj/YAML; '' if none */
  crs: string
}

/** replace the extension of a filename, preserving upper/lower-case style */
export function sidecarName(filename: string, ext: 'dbf' | 'prj'): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > -1 ? filename.substring(0, dot) : filename
  const originalExt = dot > -1 ? filename.substring(dot + 1) : 'shp'

  if (originalExt === originalExt.toUpperCase()) return `${base}.${ext.toUpperCase()}`
  if (originalExt.charAt(0) === originalExt.charAt(0).toUpperCase())
    return `${base}.${ext.charAt(0).toUpperCase()}${ext.slice(1)}`
  return `${base}.${ext}`
}

function splitColumns(value: string[] | string | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : value.split(',')
}

/** mutate a geometry's coordinates to WGS84 in place (no clone) */
function projectGeometry(geometry: any, transformer: any) {
  if (!geometry || !transformer) return

  const walk = (coords: any) => {
    if (typeof coords[0] === 'number') {
      const lnglat = transformer.forward([coords[0], coords[1]]) as number[]
      coords[0] = lnglat[0]
      coords[1] = lnglat[1]
      // preserve Z if the projection handled it
      if (coords.length > 2 && typeof lnglat[2] === 'number') coords[2] = lnglat[2]
      return
    }
    for (let i = 0; i < coords.length; i++) walk(coords[i])
  }

  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) projectGeometry(g, transformer)
  } else if (geometry.coordinates) {
    walk(geometry.coordinates)
  }
}

/**
 * Stream a shapefile into a list of GeoJSON geometries plus a columnar
 * DataTable of the feature properties.
 */
export async function streamShapefileFeatures(
  options: StreamShapefileOptions
): Promise<StreamShapefileResult> {
  const { fileApi, subfolder, filename, highPrecision, onProgress } = options
  const keepProperties = !!options.keepProperties

  const relPath = subfolder ? `${subfolder}/${filename}`.replace(/\/+/g, '/') : filename
  const dbfPath = sidecarName(relPath, 'dbf')
  const prjPath = sidecarName(relPath, 'prj')

  onProgress?.('Loading projection...')

  // 1. Figure out the projection BEFORE we start parsing, so we can reproject
  //    each feature as it streams in rather than cloning the whole collection.
  let projection = DEFAULT_PROJECTION
  try {
    projection = await fileApi.getFileText(prjPath)
  } catch (e) {
    // no .prj: we can live without a projection
  }
  const crs = options.projection || Coords.guessProjection(projection) || ''
  const needsProjection = !!crs && crs !== 'EPSG:4326' && crs !== 'WGS84'
  // build ONE converter and reuse it for every coordinate (calling proj4 per
  // point re-parses the projection and explodes memory/CPU on large files)
  const project = needsProjection ? Coords.getTransformer(crs, 'WGS84') : null

  onProgress?.('Loading shapefile...')

  const shpStream = await fileApi.getFileStream(relPath)
  if (!shpStream) throw Error(`Could not stream ${relPath}`)

  let dbfStream: ReadableStream | undefined
  try {
    dbfStream = await fileApi.getFileStream(dbfPath)
  } catch (e) {
    // no DBF: geometry only
  }

  // shapefile's TS types don't know about ReadableStream sources
  const source: any = await (shapefile as any).open(shpStream, dbfStream)

  const boundaries: any[] = []

  // columnar property storage; we fill plain arrays and convert numeric
  // columns to typed arrays once at the end (geometry dominates memory).
  const dataTable: DataTable = {}
  let columnNames: string[] | null = null
  const columns: { [name: string]: any[] } = {}
  const numeric: { [name: string]: boolean } = {}

  const dropColumns = splitColumns(options.drop)
  const keepColumns = splitColumns(options.keep)

  let featureCount = 0

  try {
    while (true) {
      const result = await source.read()
      if (result.done) break

      const feature = result.value
      if (!feature || !feature.geometry) continue

      // reproject in place before we keep it
      if (project) projectGeometry(feature.geometry, project)

      // properties (from dbf) + optional top-level geojson id
      const props = feature.properties || {}
      if (feature.id !== undefined && props.id === undefined) props.id = feature.id

      if (keepProperties) {
        // keep properties on the feature (e.g. background layers / labels)
        boundaries.push({
          type: 'Feature',
          properties: props,
          geometry: feature.geometry,
        })
      } else {
        if (!columnNames) {
          let headers = Object.keys(props).sort()
          if (dropColumns.length) headers = headers.filter(h => dropColumns.indexOf(h) === -1)
          if (keepColumns.length) headers = headers.filter(h => keepColumns.indexOf(h) > -1)

          columnNames = headers
          for (const name of headers) {
            columns[name] = []
            numeric[name] = typeof props[name] === 'number'
          }
        }

        for (const name of columnNames) {
          columns[name].push(props[name])
        }

        // discard original properties; the DataTable owns the data now
        boundaries.push({
          type: 'Feature',
          properties: {},
          geometry: feature.geometry,
        })
      }

      featureCount++
      if (onProgress && featureCount % 50000 === 0) {
        onProgress(`Loading shapefile... ${featureCount} features`)
      }
    }
  } finally {
    try {
      await source.cancel()
    } catch (e) {
      // stream already closed
    }
  }

  // convert numeric columns to typed arrays and compute max values
  if (columnNames) {
    for (const name of columnNames) {
      const values = columns[name]
      if (numeric[name]) {
        const column: DataTableColumn = {
          name,
          type: DataType.NUMBER,
          values: highPrecision ? Float64Array.from(values) : Float32Array.from(values),
        }
        let max = -Infinity
        for (const v of column.values) max = Math.max(max, v as number)
        column.max = max
        dataTable[name] = column
        // release the intermediate
        columns[name] = []
      } else {
        // Normalise sentinel "empty" strings for categorical colouring. The
        // 02-pipeline writes "" for unedited links so the shapefile map can
        // colour them grey; 'None'/'nan'/'No' are the same idea from other
        // producers. Deck's categorical colour logic greys-out `undefined`.
        dataTable[name] = {
          name,
          type: DataType.STRING,
          values: columns[name].map((v: any) =>
            v === '' || v == null || v === 'None' || v === 'No' || v === 'nan'
              ? undefined
              : v
          ),
        }
        columns[name] = []
      }
    }
  }

  return { boundaries, dataTable, crs }
}
