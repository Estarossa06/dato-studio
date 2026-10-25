/// <reference lib="webworker" />

import Papa from 'papaparse'
import { countFormulaRisks, exportCsvChunks, hasParserTerminalRow, isFormulaRisk, neutralizeFormulaValue, guessDelimiter, type CsvDocument, type Delimiter } from '../lib/csv'
import { analyzeDocument, initialRulesForDocument, iterateCleanRows, previewRules, searchCleanRows, type CleanRules } from '../lib/clean'
import { csvLimitForDevice, MAX_XLSX_BYTES } from '../lib/limits'

interface ParseRequest {
  type: 'parse'
  requestId: number
  file: File
  delimiter?: Delimiter
  hasHeader?: boolean
  sheetName?: string
}

interface ExportRequest {
  type: 'export'
  requestId: number
  format: 'csv' | 'xlsx'
  delimiter?: ',' | ';' | '\t'
  safe?: boolean
}

interface SearchRequest {
  type: 'search'
  requestId: number
  query: string
  columnIndex: number | null
  offset: number
  limit: number
  caseSensitive?: boolean
}

interface ComputeRequest {
  type: 'set-rules'
  requestId: number
  rules: CleanRules
}

type Request = ParseRequest | ExportRequest | SearchRequest | ComputeRequest

let activeDocument: CsvDocument | null = null
let activeRules: CleanRules | null = null
let activeAnalysis: ReturnType<typeof analyzeDocument> | null = null
let activeFormulaRiskCount = 0

function createPayload(requestId: number, document: CsvDocument, rules: CleanRules) {
  const analysis = activeAnalysis ?? analyzeDocument(document)
  const result = previewRules(document, rules, 30)
  let maxColumnCount = document.expectedWidth
  for (const row of document.rows) if (row.length > maxColumnCount) maxColumnCount = row.length
  const viewDocument: CsvDocument = {
    ...document,
    expectedWidth: maxColumnCount,
    rows: document.rows.slice(0, 30),
    xlsxCells: document.xlsxCells?.slice(0, 30),
  }
  return {
    type: 'ready', requestId, document: viewDocument,
    analysis: { ...analysis, widthCounts: undefined },
    result,
    rules,
    formulaRiskCount: activeFormulaRiskCount + result.headers.filter(isFormulaRisk).length,
  }
}

self.addEventListener('message', async (event: MessageEvent<Request>) => {
  const message = event.data
  try {
    if (message.type === 'parse') {
      activeDocument = null
      activeRules = null
      activeAnalysis = null
      activeFormulaRiskCount = 0
      const extension = message.file.name.toLowerCase().split('.').pop()
      const isWorkbook = extension === 'xlsx'
      if (!isWorkbook && !['csv', 'txt', 'tsv'].includes(extension ?? '')) throw new Error('Este flujo admite CSV, TXT, TSV y XLSX.')
      if (!isWorkbook) {
        const signature = new Uint8Array(await message.file.slice(0, 4).arrayBuffer())
        if (signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04) {
          throw new Error('El contenido parece ser un libro XLSX, pero la extensión no coincide. Selecciona el archivo .xlsx original.')
        }
      }
      const deviceMemory = (self.navigator as WorkerNavigator & { deviceMemory?: number }).deviceMemory
      const sizeLimit = isWorkbook ? MAX_XLSX_BYTES : csvLimitForDevice(deviceMemory)
      if (message.file.size > sizeLimit) throw new Error(`${isWorkbook ? 'XLSX' : 'CSV'} supera el límite actual de ${(sizeLimit / (1024 * 1024)).toFixed(1)} MB.`)
      if (isWorkbook) {
        self.postMessage({ type: 'progress', requestId: message.requestId, progress: 4, label: 'Validando la estructura comprimida del libro…' })
        const bytes = await message.file.arrayBuffer()
        self.postMessage({ type: 'progress', requestId: message.requestId, progress: 12, label: 'Comprobando tamaños y contenido ZIP antes de abrir el libro…' })
        const { parseWorkbook } = await import('../lib/workbook')
        const document = await parseWorkbook(bytes, {
          name: message.file.name, size: message.file.size, sheetName: message.sheetName, hasHeader: message.hasHeader,
          onZipValidated(summary) {
            self.postMessage({ type: 'progress', requestId: message.requestId, progress: 35, label: `ZIP validado · ${summary.entries} entradas · ${Math.ceil(summary.uncompressedBytes / (1024 * 1024))} MiB descomprimidos · leyendo hojas…` })
          },
        })
        activeDocument = document
        activeRules = initialRulesForDocument(document)
        activeAnalysis = analyzeDocument(document)
        activeFormulaRiskCount = countFormulaRisks(document.rows)
        self.postMessage({ type: 'progress', requestId: message.requestId, progress: 90, label: 'Calculando el diagnóstico…' })
        self.postMessage({ ...createPayload(message.requestId, document, activeRules), delimiterAmbiguous: false })
        return
      }
      const sample = await message.file.slice(0, 64 * 1024).text()
      const ending = await message.file.slice(Math.max(0, message.file.size - 2)).text()
      const endsWithNewline = /[\r\n]$/.test(ending)
      const guess = guessDelimiter(sample)
      const delimiter = message.delimiter ?? guess.delimiter
      const hasHeader = message.hasHeader ?? true
      const rows: string[][] = []
      const parseErrors: string[] = []
      let headers: string[] = []
      let firstRow = true
      let expectedWidth = 0
      let encodingWarning = false
      let hasContent = false
      Papa.parse<string[]>(message.file, {
        delimiter,
        skipEmptyLines: false,
        dynamicTyping: false,
        chunkSize: 1024 * 1024,
        beforeFirstChunk(chunk) { return chunk.replace(/^\uFEFF/, '') },
        chunk(results) {
          for (const row of results.data) {
            if (row.some((cell) => cell.trim().length > 0)) hasContent = true
            if (row.some((cell) => cell.includes('\uFFFD') || /(?:Ã.|Â.|â€|ï»¿)/.test(cell))) encodingWarning = true
            if (firstRow && hasHeader) {
              headers = [...row]
              expectedWidth = headers.length
              firstRow = false
              continue
            }
            if (firstRow) {
              expectedWidth = row.length
              firstRow = false
            }
            rows.push([...row])
          }
          for (const error of results.errors) parseErrors.push(`${error.row === undefined ? '' : `Fila ${error.row + 1}: `}${error.message}`)
          self.postMessage({ type: 'progress', requestId: message.requestId, progress: Math.min(99, Math.floor((results.meta.cursor / Math.max(message.file.size, 1)) * 100)), label: `Leyendo CSV… ${Math.min(99, Math.floor((results.meta.cursor / Math.max(message.file.size, 1)) * 100))}%` })
        },
        complete() {
          if (hasParserTerminalRow(rows, endsWithNewline)) rows.pop()
          if (!hasContent) {
            self.postMessage({ type: 'failure', requestId: message.requestId, message: 'El archivo está vacío o solo contiene espacios y saltos de línea.' })
            return
          }
          const document: CsvDocument = {
            name: message.file.name,
            size: message.file.size,
            delimiter,
            hasHeader,
            originalHeaders: headers,
            rows,
            expectedWidth,
            parseErrors,
            encodingWarning,
            format: 'csv',
          }
          activeDocument = document
          activeRules = initialRulesForDocument(document)
          activeAnalysis = analyzeDocument(document)
          activeFormulaRiskCount = countFormulaRisks(document.rows)
          self.postMessage({ type: 'progress', requestId: message.requestId, progress: 99, label: 'Calculando el diagnóstico…' })
          self.postMessage({ ...createPayload(message.requestId, document, activeRules), delimiterAmbiguous: message.delimiter === undefined && guess.ambiguous })
        },
        error(error) {
          self.postMessage({ type: 'failure', requestId: message.requestId, message: error.message || 'No se pudo leer el CSV.' })
        },
      })
      return
    }

    if (message.type === 'search') {
      if (!activeDocument || !activeRules) throw new Error('La sesión de archivo ya no está disponible. Impórtalo de nuevo.')
      self.postMessage({ type: 'progress', requestId: message.requestId, progress: 1, label: 'Buscando en todas las filas…' })
      const result = searchCleanRows(activeDocument, activeRules, message.query, message.columnIndex, message.offset, message.limit, message.caseSensitive)
      self.postMessage({
        type: 'search-results',
        requestId: message.requestId,
        search: {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            precisionWarnings: activeDocument!.xlsxCells?.[row.rowIndex]?.map((cell) => Boolean(cell.precisionWarning)) ?? [],
          })),
        },
      })
      return
    }

    if (message.type === 'export') {
      if (!activeDocument || !activeRules) throw new Error('La sesión de archivo ya no está disponible. Impórtalo de nuevo.')
      self.postMessage({ type: 'progress', requestId: message.requestId, progress: 4, label: 'Preparando el archivo…' })
      if (message.format === 'xlsx') {
        const { exportWorkbook } = await import('../lib/workbook')
        const { applyRules } = await import('../lib/clean')
        const result = applyRules(activeDocument, activeRules)
        const rows = message.safe ? result.rows.map((row) => row.map(neutralizeFormulaValue)) : result.rows
        const headers = message.safe ? result.headers.map(neutralizeFormulaValue) : result.headers
        const sourceRowIndexes = activeDocument.rows.map((_, index) => index).filter((index) => !result.removedRowIndexes.has(index))
        const buffer = exportWorkbook(activeDocument, rows, headers, sourceRowIndexes)
        self.postMessage({ type: 'exported', requestId: message.requestId, buffer }, [buffer])
      } else {
        const headers = activeRules.normalizeHeaders ? activeDocument.originalHeaders.map((header) => header.trim().replace(/\s+/g, '_').toLocaleLowerCase()) : activeDocument.originalHeaders
        function* exportRows() {
          for (const item of iterateCleanRows(activeDocument!, activeRules!)) if (item.values) yield item.values
        }
        const blob = await exportCsvChunks(exportRows(), activeDocument.hasHeader ? headers : [], message.delimiter ?? ',', {
          safe: message.safe,
          onProgress(processed) {
            const percent = Math.min(99, Math.floor((processed / Math.max(activeDocument!.rows.length, 1)) * 100))
            self.postMessage({ type: 'progress', requestId: message.requestId, progress: percent, label: `Preparando CSV… ${percent}%` })
          },
        })
        self.postMessage({ type: 'exported', requestId: message.requestId, blob })
      }
      return
    }

    if (message.type === 'set-rules') {
      if (!activeDocument) throw new Error('La sesión de archivo ya no está disponible. Impórtalo de nuevo.')
      activeRules = message.rules
      self.postMessage({ type: 'progress', requestId: message.requestId, progress: 1, label: 'Actualizando la vista previa…' })
      self.postMessage(createPayload(message.requestId, activeDocument, activeRules))
    }
  } catch (error) {
    self.postMessage({ type: 'failure', requestId: message.requestId, message: error instanceof Error ? error.message : 'No se pudo procesar el archivo.' })
  }
})

export {}
