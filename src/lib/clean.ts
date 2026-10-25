import type { CsvDocument, CsvRow } from './csv'

export interface CleanRules {
  trim: boolean
  trimColumns: number[]
  caseMode: 'none' | 'upper' | 'lower'
  caseColumns: number[]
  removeEmpty: boolean
  removeDuplicates: boolean
  normalizeHeaders: boolean
}

export const EMPTY_RULES: CleanRules = {
  trim: false,
  trimColumns: [],
  caseMode: 'none',
  caseColumns: [],
  removeEmpty: false,
  removeDuplicates: false,
  normalizeHeaders: false,
}

export interface CleanResult {
  headers: string[]
  rows: CsvRow[]
  removedEmpty: number
  removedDuplicates: number
  changedCells: number
  changedHeaders: number
  removedRowIndexes: Set<number>
}

export interface CleanSearchRow {
  rowIndex: number
  original: CsvRow
  values: CsvRow
}

export interface CleanSearchResult {
  rows: CleanSearchRow[]
  totalMatches: number
  offset: number
  limit: number
}

export function isEmptyRow(row: CsvRow): boolean {
  return row.every((cell) => cell === '')
}

const COLLISION_BUCKET_LINEAR_LIMIT = 8

function compactRowHash(row: CsvRow): number {
  // A cheap bucket selector; every matching candidate is still checked cell by cell.
  let first = 0x811c9dc5
  first = Math.imul(first ^ row.length, 0x01000193)
  const firstCell = row[0] ?? ''
  first = Math.imul(first ^ firstCell.length, 0x01000193)
  for (let index = 0; index < firstCell.length; index++) first = Math.imul(first ^ firstCell.charCodeAt(index), 0x01000193)
  return first >>> 0
}

function rowsEqual(left: CsvRow, right: CsvRow): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function cleanRowHash(row: CsvRow): number {
  let hash = 0x811c9dc5
  hash = Math.imul(hash ^ row.length, 0x01000193)
  for (const cell of row) {
    hash = Math.imul(hash ^ cell.length, 0x01000193)
    for (let index = 0; index < cell.length; index++) hash = Math.imul(hash ^ cell.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

function compareRows(left: CsvRow, right: CsvRow): number {
  const sharedLength = Math.min(left.length, right.length)
  for (let index = 0; index < sharedLength; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return left.length - right.length
}

// Supplying a hasher is useful for collision tests; it cannot bypass exact row comparisons.
export function countDuplicateRows(rows: CsvRow[], hashRow: (row: CsvRow) => number = compactRowHash): number {
  const representatives = new Map<number, number | { indexes: number[]; overflowRows?: number[] }>()
  let duplicates = 0

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const key = hashRow(rows[rowIndex])
    const existing = representatives.get(key)
    if (existing === undefined) {
      representatives.set(key, rowIndex)
      continue
    }

    if (typeof existing === 'number') {
      if (rowsEqual(rows[existing], rows[rowIndex])) duplicates++
      else representatives.set(key, { indexes: [existing, rowIndex] })
      continue
    }

    if (existing.overflowRows) {
      existing.overflowRows.push(rowIndex)
      continue
    }

    let matched = false
    for (const representative of existing.indexes) {
      if (rowsEqual(rows[representative], rows[rowIndex])) { matched = true; break }
    }
    if (matched) duplicates++
    else if (existing.indexes.length < COLLISION_BUCKET_LINEAR_LIMIT) existing.indexes.push(rowIndex)
    else {
      existing.overflowRows = [...existing.indexes, rowIndex]
      existing.indexes = []
    }
  }

  for (const bucket of representatives.values()) {
    if (typeof bucket === 'number' || !bucket.overflowRows) continue
    bucket.overflowRows.sort((left, right) => compareRows(rows[left], rows[right]))
    for (let index = 1; index < bucket.overflowRows.length; index++) {
      if (rowsEqual(rows[bucket.overflowRows[index - 1]], rows[bucket.overflowRows[index]])) duplicates++
    }
  }
  return duplicates
}

export function analyzeDocument(document: CsvDocument) {
  const widthCounts = new Map<number, number>()
  for (const row of document.rows) widthCounts.set(row.length, (widthCounts.get(row.length) ?? 0) + 1)
  const byColumn = new Map<number, { emptyCells: number; edgeSpaces: number; ambiguousValues: number }>()
  const duplicateRows = countDuplicateRows(document.rows)
  let emptyCells = 0
  let emptyRows = 0
  let edgeSpaces = 0
  let ambiguousValues = 0
  for (const row of document.rows) {
    if (isEmptyRow(row)) emptyRows++
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      const cell = row[columnIndex]
      const isEmpty = cell === ''
      const hasEdgeSpaces = cell !== cell.trim()
      const isAmbiguous = /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(cell.trim()) || /^\d+[.,]\d+$/.test(cell.trim())
      if (isEmpty) emptyCells++
      if (hasEdgeSpaces) edgeSpaces++
      if (isAmbiguous) ambiguousValues++
      if (isEmpty || hasEdgeSpaces || isAmbiguous) {
        let column = byColumn.get(columnIndex)
        if (!column) { column = { emptyCells: 0, edgeSpaces: 0, ambiguousValues: 0 }; byColumn.set(columnIndex, column) }
        if (isEmpty) column.emptyCells++
        if (hasEdgeSpaces) column.edgeSpaces++
        if (isAmbiguous) column.ambiguousValues++
      }
    }
  }
  const headerCounts = new Map<string, number>()
  for (const header of document.originalHeaders) {
    const normalized = header.trim()
    headerCounts.set(normalized, (headerCounts.get(normalized) ?? 0) + 1)
  }
  return {
    rowCount: document.rows.length,
    columnCount: document.expectedWidth,
    emptyCells,
    emptyRows,
    duplicateRows,
    edgeSpaces,
    emptyHeaders: document.originalHeaders.filter((header) => header === '').length,
    duplicateHeaders: [...headerCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    irregularRows: document.rows.reduce((count, row) => count + (row.length !== document.expectedWidth ? 1 : 0), 0),
    ambiguousValues,
    byColumn: [...byColumn].map(([index, counts]) => ({ index, ...counts })).sort((a, b) => a.index - b.index),
    widthCounts,
  }
}

export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, '_').toLocaleLowerCase()
}

export function applyRules(document: CsvDocument, rules: CleanRules): CleanResult {
  const headers = normalizedHeaders(document, rules)
  const removedRowIndexes = new Set<number>()
  const rows: CsvRow[] = []
  let removedEmpty = 0
  let removedDuplicates = 0
  let changedCells = 0
  for (const item of iterateCleanRows(document, rules)) {
    if (item.removed === 'empty') { removedEmpty++; removedRowIndexes.add(item.rowIndex); continue }
    if (item.removed === 'duplicate') { removedDuplicates++; removedRowIndexes.add(item.rowIndex); continue }
    changedCells += item.changedCells
    rows.push(item.values!)
  }
  return {
    headers,
    rows,
    removedEmpty,
    removedDuplicates,
    changedCells,
    changedHeaders: headers.reduce((count, header, index) => count + (header !== document.originalHeaders[index] ? 1 : 0), 0),
    removedRowIndexes,
  }
}

export function previewRules(document: CsvDocument, rules: CleanRules, limit = 30): CleanResult {
  const headers = normalizedHeaders(document, rules)
  const removedRowIndexes = new Set<number>()
  const rows: CsvRow[] = []
  let removedEmpty = 0
  let removedDuplicates = 0
  let changedCells = 0
  for (const item of iterateCleanRows(document, rules, (rowIndex) => rowIndex < limit)) {
    if (item.removed === 'empty') { removedEmpty++; if (item.rowIndex < limit) removedRowIndexes.add(item.rowIndex); continue }
    if (item.removed === 'duplicate') { removedDuplicates++; if (item.rowIndex < limit) removedRowIndexes.add(item.rowIndex); continue }
    changedCells += item.changedCells
    if (item.values) rows.push(item.values)
  }
  return {
    headers,
    rows,
    removedEmpty,
    removedDuplicates,
    changedCells,
    changedHeaders: headers.reduce((count, header, index) => count + (header !== document.originalHeaders[index] ? 1 : 0), 0),
    removedRowIndexes,
  }
}

function normalizedHeaders(document: CsvDocument, rules: CleanRules) {
  return document.originalHeaders.map((header) => rules.normalizeHeaders ? normalizeHeader(header) : header)
}

function transformCell(source: string, columnIndex: number, rules: CleanRules): string {
  let value = source
  if (rules.trim && rules.trimColumns.includes(columnIndex)) value = value.trim()
  if (rules.caseMode !== 'none' && rules.caseColumns.includes(columnIndex)) value = rules.caseMode === 'upper' ? value.toLocaleUpperCase() : value.toLocaleLowerCase()
  return value
}

function rememberUniqueSearchRow(seen: Map<number, CsvRow[] | Set<string>>, row: CsvRow, hashRow: (row: CsvRow) => number): boolean {
  const key = hashRow(row)
  const bucket = seen.get(key)
  if (!bucket) {
    seen.set(key, [row])
    return true
  }
  if (bucket instanceof Set) {
    const exactKey = JSON.stringify(row)
    if (bucket.has(exactKey)) return false
    bucket.add(exactKey)
    return true
  }
  for (const candidate of bucket) if (rowsEqual(candidate, row)) return false
  if (bucket.length < COLLISION_BUCKET_LINEAR_LIMIT) bucket.push(row)
  else seen.set(key, new Set([...bucket, row].map((candidate) => JSON.stringify(candidate))))
  return true
}

export function searchCleanRows(document: CsvDocument, rules: CleanRules, query: string, columnIndex: number | null, offset = 0, limit = 30, caseSensitive = false, hashRow: (row: CsvRow) => number = cleanRowHash): CleanSearchResult {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(0, Math.floor(limit))) : 30
  const rows: CleanSearchRow[] = []
  if (!query || safeLimit === 0 || (columnIndex !== null && (!Number.isInteger(columnIndex) || columnIndex < 0))) {
    return { rows, totalMatches: 0, offset: safeOffset, limit: safeLimit }
  }

  const normalizedQuery = caseSensitive ? query : query.toLowerCase()
  const searchRules = rules.removeDuplicates ? { ...rules, removeDuplicates: false } : rules
  const seenMatches = rules.removeDuplicates ? new Map<number, CsvRow[] | Set<string>>() : null
  let totalMatches = 0
  for (const item of iterateCleanRows(document, searchRules, (_rowIndex, sourceRow) => {
    const firstColumn = columnIndex ?? 0
    const lastColumn = columnIndex === null ? sourceRow.length : Math.min(sourceRow.length, columnIndex + 1)
    for (let index = firstColumn; index < lastColumn; index++) {
      const value = transformCell(sourceRow[index], index, rules)
      if ((caseSensitive ? value : value.toLowerCase()).includes(normalizedQuery)) {
        if (seenMatches && !rememberUniqueSearchRow(seenMatches, sourceRow, hashRow)) return false
        const matchIndex = totalMatches++
        return matchIndex >= safeOffset && matchIndex < safeOffset + safeLimit
      }
    }
    return false
  }, undefined, false)) {
    if (item.values) rows.push({ rowIndex: item.rowIndex, original: document.rows[item.rowIndex], values: item.values })
  }
  return { rows, totalMatches, offset: safeOffset, limit: safeLimit }
}

export function* iterateCleanRows(document: CsvDocument, rules: CleanRules, includeValuesForRow: (rowIndex: number, sourceRow: CsvRow) => boolean = () => true, hashRow: (row: CsvRow) => number = cleanRowHash, trackChangedCells = true): Generator<{ rowIndex: number; removed?: 'empty' | 'duplicate'; values?: CsvRow; changedCells: number }> {
  const seen = rules.removeDuplicates ? new Map<number, CsvRow>() : null
  let collisionBuckets: Map<number, CsvRow[] | Set<string>> | null = null
  const hasCellTransforms = (rules.trim && rules.trimColumns.length > 0) || (rules.caseMode !== 'none' && rules.caseColumns.length > 0)
  for (let rowIndex = 0; rowIndex < document.rows.length; rowIndex++) {
    const sourceRow = document.rows[rowIndex]
    if (rules.removeEmpty && isEmptyRow(sourceRow)) {
      yield { rowIndex, removed: 'empty', changedCells: 0 }
      continue
    }
    if (seen) {
      const key = hashRow(sourceRow)
      const bucket = collisionBuckets?.get(key)
      if (bucket) {
        if (bucket instanceof Set) {
          const exactKey = JSON.stringify(sourceRow)
          if (bucket.has(exactKey)) {
            yield { rowIndex, removed: 'duplicate', changedCells: 0 }
            continue
          }
          bucket.add(exactKey)
        } else {
          let duplicate = false
          for (const candidate of bucket) {
            if (rowsEqual(candidate, sourceRow)) { duplicate = true; break }
          }
          if (duplicate) {
            yield { rowIndex, removed: 'duplicate', changedCells: 0 }
            continue
          }
          if (bucket.length < COLLISION_BUCKET_LINEAR_LIMIT) bucket.push(sourceRow)
          else collisionBuckets!.set(key, new Set([...bucket, sourceRow].map((row) => JSON.stringify(row))))
        }
      } else {
        const existing = seen.get(key)
        if (existing === undefined) seen.set(key, sourceRow)
        else if (rowsEqual(existing, sourceRow)) {
          yield { rowIndex, removed: 'duplicate', changedCells: 0 }
          continue
        } else {
          collisionBuckets ??= new Map()
          collisionBuckets.set(key, [existing, sourceRow])
        }
      }
    }
    const includeValues = includeValuesForRow(rowIndex, sourceRow)
    if (!includeValues && (!hasCellTransforms || !trackChangedCells)) {
      yield { rowIndex, values: undefined, changedCells: 0 }
      continue
    }
    let changedCells = 0
    const values = includeValues ? [] as CsvRow : undefined
    for (let columnIndex = 0; columnIndex < sourceRow.length; columnIndex++) {
      const source = sourceRow[columnIndex]
      const value = transformCell(source, columnIndex, rules)
      if (value !== source) changedCells++
      values?.push(value)
    }
    yield { rowIndex, values, changedCells }
  }
}

export function initialRulesForDocument(document: CsvDocument): CleanRules {
  let width = document.expectedWidth
  for (const row of document.rows) if (row.length > width) width = row.length
  const columns = Array.from({ length: width }, (_, index) => index)
  return { ...EMPTY_RULES, trimColumns: columns, caseColumns: columns }
}
