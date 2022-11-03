/**
 * Load a *.xyt.csv file, parse it, and return a set of ArrayBuffers for display.
 */
import pako from 'pako'
import Papaparse from 'papaparse'

import { FileSystemConfig } from '@/Globals'
import { findMatchingGlobInFiles } from '@/js/util'
import Coords from '@/js/Coords'
import HTTPFileSystem from '@/js/HTTPFileSystem'

const LAYER_SIZE = 0.5 * 1024 * 1024

let _proj = 'EPSG:4326'
let _rangeOfValues = [Infinity, -Infinity]

// -----------------------------------------------------------
onmessage = function (e) {
  startLoading(e.data)
}
// -----------------------------------------------------------

async function startLoading(props: {
  filepath: string
  fileSystem: FileSystemConfig
  projection: string
}) {
  if (props.projection) _proj = props.projection

  const url = await step1PrepareFetch(props.filepath, props.fileSystem)
  step2fetchCSVdata(url)
  postMessage({ finished: true, range: _rangeOfValues })
}

interface PointData {
  time: Float32Array
  value: Float32Array
  coordinates: Float32Array
  timeRange: number[]
}

// --- helper functions ------------------------------------------------

// Return a chunk of results after processing is complete.
function postResults(layerData: PointData) {
  postMessage(layerData, [
    layerData.coordinates.buffer,
    layerData.time.buffer,
    layerData.value.buffer,
  ])
}

async function step1PrepareFetch(filepath: string, fileSystem: FileSystemConfig) {
  postMessage({ status: `Loading ${filepath}...` })

  try {
    const httpFileSystem = new HTTPFileSystem(fileSystem)

    // figure out which file to load with *? wildcards
    let expandedFilename = filepath

    if (filepath.indexOf('*') > -1 || filepath.indexOf('?') > -1) {
      const zDataset = filepath.substring(1 + filepath.lastIndexOf('/'))
      const zSubfolder = filepath.substring(0, filepath.lastIndexOf('/'))

      // fetch list of files in this folder
      const { files } = await httpFileSystem.getDirectory(zSubfolder)
      const matchingFiles = findMatchingGlobInFiles(files, zDataset)
      if (matchingFiles.length == 0) throw Error(`No files matched "${zDataset}"`)
      if (matchingFiles.length > 1)
        throw Error(`More than one file matched "${zDataset}": ${matchingFiles}`)
      expandedFilename = `${zSubfolder}/${matchingFiles[0]}`
    }

    // got true filename, add prefixes and away we go
    const url = `${fileSystem.baseURL}/${expandedFilename}`
    console.log(url)
    return url
  } catch (e) {
    console.error('' + e)
    postMessage({ error: 'Error loading: ' + filepath })
    throw Error('LOAD FAIL! ' + filepath)
  }
}

let layerData: PointData = {
  time: new Float32Array(LAYER_SIZE),
  value: new Float32Array(LAYER_SIZE),
  coordinates: new Float32Array(LAYER_SIZE * 2),
  timeRange: [Infinity, -Infinity],
}

let offset = 0
let totalRowsRead = 0

function appendResults(results: { data: any[]; comments: any[] }) {
  // set EPSG if we have it in CSV file
  for (const comment of results.comments) {
    const epsg = comment.indexOf('EPSG:')
    if (epsg > -1) {
      _proj = comment.slice(epsg)
      console.log(_proj, 'found in CSV comment')
      break
    }
  }

  const numRows = results.data.length
  const rowsToFill = Math.min(numRows, LAYER_SIZE - offset)
  const xy = [0, 0]

  // Fill the array as much as we can
  for (let i = 0; i < rowsToFill; i++) {
    const row = results.data[i] as any
    xy[0] = row.x
    xy[1] = row.y
    const wgs84 = Coords.toLngLat(_proj, xy)
    layerData.coordinates[(offset + i) * 2] = wgs84[0]
    layerData.coordinates[(offset + i) * 2 + 1] = wgs84[1]
    layerData.time[offset + i] = row.time || row.t || 0
    layerData.value[offset + i] = row.value
  }

  layerData.timeRange[0] = Math.min(layerData.time[0], layerData.timeRange[0])
  layerData.timeRange[1] = Math.max(layerData.time[offset + rowsToFill - 1], layerData.timeRange[1])

  _rangeOfValues = layerData.value.reduce((prev, value) => {
    prev[0] = Math.min(prev[0], value)
    prev[1] = Math.max(prev[1], value)
    return prev
  }, _rangeOfValues)

  offset += rowsToFill
  totalRowsRead += rowsToFill

  // Are we full?
  if (offset === LAYER_SIZE) {
    postResults(layerData)
    offset = 0

    layerData = {
      coordinates: new Float32Array(LAYER_SIZE * 2),
      time: new Float32Array(LAYER_SIZE),
      value: new Float32Array(LAYER_SIZE),
      timeRange: [Infinity, -Infinity],
    }
  }

  // is there more to load?
  if (rowsToFill < numRows) {
    const remainingData = { data: results.data.slice(rowsToFill), comments: [] }
    appendResults(remainingData)
  } else {
    postMessage({ status: `Loading rows: ${totalRowsRead}...` })
  }
}

function step2fetchCSVdata(url: any) {
  console.log('fetching chunks from:', url)
  try {
    Papaparse.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      comments: '#',
      chunk: appendResults,
    } as any)
    // }
  } catch (e) {
    console.log('' + e)
    postMessage({ error: 'ERROR projection coordinates' })
    return
  }

  // all done? post final arrays
  if (offset) {
    const subarray: PointData = {
      time: layerData.time.subarray(0, offset),
      coordinates: layerData.coordinates.subarray(0, offset * 2),
      value: layerData.value.subarray(0, offset),
      timeRange: layerData.timeRange,
    }
    // console.log('FINAL: Posting', offset)
    postResults(subarray)
  }
}