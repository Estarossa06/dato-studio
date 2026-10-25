import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { EMPTY_RULES, type CleanResult, type CleanRules, type CleanSearchResult } from './lib/clean'
import { DELIMITERS, type CsvDocument, type Delimiter } from './lib/csv'
import { csvLimitForDevice, fileLimitForDevice } from './lib/limits'

const PREVIEW_ROWS = 30
const SEARCH_PAGE_SIZE = 30
const MB = 1024 * 1024

type Analysis = { rowCount: number; columnCount: number; emptyCells: number; emptyRows: number; duplicateRows: number; edgeSpaces: number; emptyHeaders: number; duplicateHeaders: number; irregularRows: number; ambiguousValues: number; byColumn: { index: number; emptyCells: number; edgeSpaces: number; ambiguousValues: number }[] }
type SearchResponse = Omit<CleanSearchResult, 'rows'> & { rows: Array<CleanSearchResult['rows'][number] & { precisionWarnings: boolean[] }> }
type SearchView = { query: string; columnIndex: number | null; caseSensitive: boolean; offset: number; result: SearchResponse }
type WorkerPayload = { type: string; requestId: number; document?: CsvDocument; analysis?: Analysis; result?: CleanResult; search?: SearchResponse; rules?: CleanRules; formulaRiskCount?: number; delimiterAmbiguous?: boolean; blob?: Blob; buffer?: ArrayBuffer; message?: string; progress?: number; label?: string }

function formatBytes(bytes: number) {
  return bytes < MB ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / MB).toFixed(1)} MB`
}

function getDeviceMemory() {
  const deviceMemory = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return deviceMemory
}

function delimiterName(delimiter: Delimiter) {
  return delimiter === '\t' ? 'Tabulación' : delimiter === '|' ? 'Barra vertical (|)' : delimiter === ';' ? 'Punto y coma (;)' : 'Coma (,)'
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestNumber = useRef(0)
  const cancelRef = useRef<(() => void) | null>(null)
  const [document, setDocument] = useState<CsvDocument | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [cleaned, setCleaned] = useState<CleanResult | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchColumnIndex, setSearchColumnIndex] = useState<number | null>(null)
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchOffset, setSearchOffset] = useState(0)
  const [searchPending, setSearchPending] = useState(false)
  const [searchView, setSearchView] = useState<SearchView | null>(null)
  const [searchError, setSearchError] = useState('')
  const [formulaRiskCount, setFormulaRiskCount] = useState(0)
  const [delimiterAmbiguous, setDelimiterAmbiguous] = useState(false)
  const [delimiter, setDelimiter] = useState<Delimiter>(',')
  const [hasHeader, setHasHeader] = useState(true)
  const [selectedSheet, setSelectedSheet] = useState('')
  const [rules, setRules] = useState<CleanRules>(EMPTY_RULES)
  const [pastRules, setPastRules] = useState<CleanRules[]>([])
  const [outputFormat, setOutputFormat] = useState<'csv' | 'xlsx'>('csv')
  const [outputDelimiter, setOutputDelimiter] = useState<',' | ';' | '\t'>(',')
  const [safeExport, setSafeExport] = useState(false)
  const [error, setError] = useState('')
  const [downloadStatus, setDownloadStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [progressLabel, setProgressLabel] = useState('')
  const [dragging, setDragging] = useState(false)
  const [deviceMemory, setDeviceMemory] = useState<number | undefined>(undefined)
  const csvLimitBytes = csvLimitForDevice(deviceMemory)

  useEffect(() => {
    setDeviceMemory(getDeviceMemory())
  }, [])

  useEffect(() => () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  useEffect(() => {
    if (!searchPending || busy || !document || searchQuery === '') return
    const timeout = window.setTimeout(() => {
      setSearchPending(false)
      void runSearch(searchQuery, searchColumnIndex, searchOffset, searchCaseSensitive)
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [busy, document, rules, searchCaseSensitive, searchColumnIndex, searchOffset, searchPending, searchQuery])

  function ensureWorker() {
    if (!workerRef.current) workerRef.current = new Worker(new URL('./workers/file.worker.ts', import.meta.url), { type: 'module' })
    return workerRef.current
  }

  function requestWorker(payload: Record<string, unknown>): Promise<WorkerPayload> {
    const worker = ensureWorker()
    const requestId = ++requestNumber.current
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        cancelRef.current = null
        callback()
      }
      cancelRef.current = () => {
        finish(() => {
          worker.terminate()
          workerRef.current = null
          reject(new Error('Procesamiento cancelado.'))
        })
      }
      worker.onmessage = (event: MessageEvent<WorkerPayload>) => {
        const message = event.data
        if (message.requestId !== requestId) return
        if (message.type === 'progress') {
          setProgress(message.progress ?? null)
          setProgressLabel(message.label ?? 'Procesando archivo…')
          return
        }
        if (message.type === 'failure') {
          finish(() => reject(new Error(message.message ?? 'No se pudo procesar el archivo.')))
          return
        }
        if (['ready', 'exported', 'search-results'].includes(message.type)) finish(() => resolve(message))
      }
      worker.onerror = (event) => finish(() => reject(new Error(event.message || 'El proceso en segundo plano se detuvo inesperadamente.')))
      worker.postMessage({ ...payload, requestId })
    })
  }

  function resetWorker() {
    cancelRef.current?.()
    workerRef.current?.terminate()
    workerRef.current = null
  }

  async function runSearch(query: string, columnIndex: number | null, offset: number, caseSensitive: boolean) {
    if (!query || !document) return
    setBusy(true)
    setProgress(null)
    setProgressLabel('Buscando en todas las filas…')
    setSearchError('')
    try {
      const response = await requestWorker({ type: 'search', query, columnIndex, offset, limit: SEARCH_PAGE_SIZE, caseSensitive })
      if (!response.search) throw new Error('El buscador no devolvió una página válida.')
      setSearchView({ query, columnIndex, caseSensitive, offset, result: response.search })
      if (offset > 0 && offset >= response.search.totalMatches) {
        const lastOffset = Math.max(0, Math.floor((response.search.totalMatches - 1) / SEARCH_PAGE_SIZE) * SEARCH_PAGE_SIZE)
        if (lastOffset !== offset) {
          setSearchOffset(lastOffset)
          setSearchPending(query !== '')
        }
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.message === 'Procesamiento cancelado.')) setSearchError(cause instanceof Error ? cause.message : 'No se pudo buscar en el archivo.')
    } finally {
      setBusy(false)
      setProgress(null)
      setProgressLabel('')
    }
  }

  function clearSearch() {
    setSearchQuery('')
    setSearchOffset(0)
    setSearchPending(false)
    setSearchView(null)
    setSearchError('')
  }

  async function parseFile(nextFile: File, options: { delimiter?: Delimiter; hasHeader?: boolean; sheetName?: string; fresh?: boolean } = {}) {
    setDownloadStatus('')
    const limit = fileLimitForDevice(nextFile.name, deviceMemory)
    if (limit === null) {
      setError('Este flujo admite CSV, TXT, TSV y XLSX. No se admiten libros XLS, XLSM o protegidos con contraseña.')
      return
    }
    const isWorkbook = nextFile.name.toLowerCase().endsWith('.xlsx')
    if (nextFile.size > limit) {
      setError(`${isWorkbook ? 'XLSX' : 'CSV'} supera el límite actual de ${formatBytes(limit)}. Los libros comprimidos pueden expandirse mucho al abrirse.`)
      return
    }
    if (nextFile.size === 0) {
      setError('El archivo está vacío. Elige un archivo con contenido.')
      return
    }
    if (options.fresh) {
      resetWorker()
      clearSearch()
      setSearchColumnIndex(null)
      setSearchCaseSensitive(false)
    }
    setBusy(true)
    setProgress(0)
    setProgressLabel(isWorkbook ? 'Preparando el libro…' : 'Preparando el CSV…')
    setError('')
    try {
      const response = await requestWorker({
        type: 'parse', file: nextFile,
        delimiter: options.delimiter,
        hasHeader: options.hasHeader ?? true,
        sheetName: options.sheetName,
      })
      if (!response.document || !response.analysis || !response.result) throw new Error('El lector no devolvió una vista previa válida.')
      setFile(nextFile)
      setDocument(response.document)
      setAnalysis(response.analysis)
      setCleaned(response.result)
      clearSearch()
      setFormulaRiskCount(response.formulaRiskCount ?? 0)
      setDelimiterAmbiguous(response.delimiterAmbiguous ?? false)
      setDelimiter(response.document.delimiter)
      setHasHeader(response.document.hasHeader)
      setSelectedSheet(response.document.sheetName ?? '')
      setRules(response.rules ?? EMPTY_RULES)
      setPastRules([])
      setSafeExport(false)
      setOutputFormat(isWorkbook ? 'xlsx' : 'csv')
      setProgress(100)
    } catch (cause) {
      resetWorker()
      setDocument(null)
      setFile(null)
      setAnalysis(null)
      setCleaned(null)
      clearSearch()
      if (!(cause instanceof Error && cause.message === 'Procesamiento cancelado.')) setError(cause instanceof Error ? cause.message : 'No se pudo procesar el archivo.')
    } finally {
      setBusy(false)
      setProgress(null)
      setProgressLabel('')
    }
  }

  function onChoose(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    if (selected) void parseFile(selected, { fresh: true })
    event.target.value = ''
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const selected = event.dataTransfer.files[0]
    if (selected) void parseFile(selected, { fresh: true })
  }

  async function reparse(next: { delimiter?: Delimiter; hasHeader?: boolean; sheetName?: string }) {
    if (!file || busy) return
    const nextDelimiter = next.delimiter ?? delimiter
    const nextHeader = next.hasHeader ?? hasHeader
    const nextSheet = next.sheetName ?? selectedSheet
    if (pastRules.length && !window.confirm('Cambiar la lectura del archivo reiniciará las reglas de limpieza seleccionadas. ¿Continuar?')) return
    await parseFile(file, { delimiter: nextDelimiter, hasHeader: nextHeader, sheetName: nextSheet, fresh: true })
  }

  async function updateRules(update: (current: CleanRules) => CleanRules) {
    if (busy) return
    const next = update(rules)
    if (JSON.stringify(next) === JSON.stringify(rules)) return
    setDownloadStatus('')
    setPastRules([...pastRules, rules])
    setRules(next)
    setSearchView(null)
    setSearchOffset(0)
    setSearchPending(searchQuery !== '')
    setBusy(true)
    setProgressLabel('Actualizando la vista previa…')
    try {
      const response = await requestWorker({ type: 'set-rules', rules: next })
      if (response.result) setCleaned(response.result)
      setFormulaRiskCount(response.formulaRiskCount ?? 0)
    } catch (cause) {
      if (!(cause instanceof Error && cause.message === 'Procesamiento cancelado.')) setError(cause instanceof Error ? cause.message : 'No se pudo actualizar la vista previa.')
    } finally {
      setBusy(false)
      setProgressLabel('')
    }
  }

  async function undo() {
    const previous = pastRules[pastRules.length - 1]
    if (!previous || busy) return
    setDownloadStatus('')
    setRules(previous)
    setPastRules(pastRules.slice(0, -1))
    setSearchView(null)
    setSearchOffset(0)
    setSearchPending(searchQuery !== '')
    setBusy(true)
    setProgressLabel('Deshaciendo el último cambio…')
    try {
      const response = await requestWorker({ type: 'set-rules', rules: previous })
      if (response.result) setCleaned(response.result)
      setFormulaRiskCount(response.formulaRiskCount ?? 0)
    } catch (cause) {
      if (!(cause instanceof Error && cause.message === 'Procesamiento cancelado.')) setError(cause instanceof Error ? cause.message : 'No se pudo deshacer el cambio.')
    } finally {
      setBusy(false)
      setProgressLabel('')
    }
  }

  function cancelOperation() {
    cancelRef.current?.()
    setBusy(false)
    setDocument(null)
    setFile(null)
    setAnalysis(null)
    setCleaned(null)
    clearSearch()
    setError('Se canceló el procesamiento. El archivo no se guardó.')
    setDownloadStatus('')
    setProgress(null)
    setProgressLabel('')
  }

  async function exportResult() {
    if (!document || !analysis || !cleaned || busy) return
    const unresolved = analysis.irregularRows > 0 || document.parseErrors.length > 0 || document.encodingWarning || analysis.emptyRows > 0 || analysis.duplicateRows > 0 || analysis.ambiguousValues > 0 || analysis.emptyCells > 0 || analysis.edgeSpaces > 0 || analysis.emptyHeaders > 0 || analysis.duplicateHeaders > 0
    if (unresolved && !window.confirm('El archivo tiene avisos sobre celdas vacías, espacios, encabezados, filas o valores ambiguos. ¿Quieres descargarlo de todas formas?')) return
    if (outputFormat === 'xlsx' && (document.workbookWarnings?.length ?? 0) > 0 && !window.confirm(`${document.workbookWarnings?.join('\n\n')}\n\nSe descargará un libro nuevo. ¿Continuar?`)) return
    if (outputFormat === 'csv' && formulaRiskCount && !safeExport && !window.confirm(`Se encontraron ${formulaRiskCount} valores que una hoja de cálculo podría interpretar como fórmulas. Puedes activar “Neutralizar” para anteponer un apóstrofo. ¿Descargar sin modificar esos campos?`)) return
    setBusy(true)
    setProgressLabel('Preparando la descarga…')
    setDownloadStatus('')
    try {
      const response = await requestWorker({ type: 'export', format: outputFormat, delimiter: outputDelimiter, safe: safeExport })
      const blob = outputFormat === 'xlsx'
        ? new Blob([response.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        : response.blob!
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `${document.name.replace(/\.(csv|txt|tsv|xlsx)$/i, '')}-limpio.${outputFormat}`
      anchor.click()
      setDownloadStatus(`Descarga iniciada: ${anchor.download}. Revisa la carpeta de descargas del navegador.`)
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (cause) {
      if (!(cause instanceof Error && cause.message === 'Procesamiento cancelado.')) setError(cause instanceof Error ? cause.message : 'No se pudo crear el archivo de salida.')
    } finally {
      setBusy(false)
      setProgressLabel('')
    }
  }

  const sourceIndexes = document ? document.rows.map((_, index) => index) : []
  const keptSourceIndexes = document && cleaned ? sourceIndexes.filter((index) => !cleaned.removedRowIndexes.has(index)) : []
  const displayHeaders = document ? Array.from({ length: document.expectedWidth }, (_, index) => {
    const header = document.hasHeader ? (cleaned?.headers[index] ?? document.originalHeaders[index] ?? '') : ''
    return header || `Columna ${index + 1}`
  }) : []
  const visibleSearch = searchView && searchView.query === searchQuery && searchView.columnIndex === searchColumnIndex && searchView.caseSensitive === searchCaseSensitive && searchView.offset === searchOffset ? searchView.result : null
  const displayRows = searchQuery === ''
    ? sourceIndexes.map((sourceIndex) => {
      const outputIndex = keptSourceIndexes.indexOf(sourceIndex)
      const removed = outputIndex === -1
      return {
        sourceIndex,
        original: document!.rows[sourceIndex],
        result: removed ? null : cleaned!.rows[outputIndex],
        removed,
        precisionWarnings: document!.xlsxCells?.[sourceIndex]?.map((cell) => Boolean(cell.precisionWarning)) ?? [],
      }
    })
    : (visibleSearch?.rows ?? []).map((row) => ({
      sourceIndex: row.rowIndex,
      original: row.original,
      result: row.values,
      removed: false,
      precisionWarnings: row.precisionWarnings,
    }))
  const totalSearchPages = visibleSearch ? Math.ceil(visibleSearch.totalMatches / SEARCH_PAGE_SIZE) : 0

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Dato Studio, inicio"><span className="wordmark-icon" aria-hidden="true">d.</span><span>dato<span className="wordmark-light">studio</span></span></a>
        <span className="privacy-note"><span className="privacy-dot" /> Procesamiento local</span>
      </header>

      {!document && <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">DATOS MÁS CLAROS, DECISIONES MÁS SEGURAS</p>
        <h1 id="hero-title">Limpia archivos<br /><span>CSV y Excel.</span></h1>
        <p className="intro">Importa un archivo, revisa el diagnóstico y elige qué limpiar. Tus datos originales se mantienen intactos mientras trabajas.</p>
        <div className={`upload-card ${dragging ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <div className="upload-symbol" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 21V5m0 0-6 6m6-6 6 6M6 19v7h20v-7" /></svg></div>
          <h2>{busy ? progressLabel || 'Leyendo el archivo…' : 'Empieza con un archivo'}</h2>
          <p>CSV, TXT o TSV: hasta {formatBytes(csvLimitBytes)} · XLSX: hasta 10 MB</p>
          {busy && <progress className="progress-bar" max={100} value={progress ?? undefined} aria-label="Progreso del procesamiento" />}
          <input ref={inputRef} className="visually-hidden" type="file" aria-label="Seleccionar archivo CSV, TXT, TSV o XLSX" tabIndex={-1} accept=".csv,.txt,.tsv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onChoose} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>Seleccionar archivo <span aria-hidden="true">↗</span></button>
          {busy && <button className="cancel-button" type="button" onClick={cancelOperation}>Cancelar</button>}
          <span className="coming-soon">También puedes arrastrarlo aquí. No se admiten XLS, XLSM ni libros protegidos.</span>
        </div>
        {error && <p className="error-banner" role="alert">{error}</p>}
        <p className="reassurance"><span aria-hidden="true">✳</span> No subimos tus archivos&nbsp; · &nbsp;Sin registro&nbsp; · &nbsp;Tú decides qué cambia</p>
      </section>}

      {document && analysis && cleaned && <section className="workspace">
        <div className="workspace-heading"><div><p className="eyebrow">REVISIÓN DE ARCHIVO</p><h1 className="workspace-title">Entiende tus datos,<br /><span>paso a paso.</span></h1></div><div className="heading-actions">{busy && progressLabel !== 'Buscando en todas las filas…' && <button className="button-secondary" onClick={cancelOperation}>Cancelar operación</button>}<button className="button-secondary" disabled={busy} onClick={() => { resetWorker(); setDocument(null); setFile(null); setAnalysis(null); setCleaned(null); clearSearch(); setSearchColumnIndex(null); setSearchCaseSensitive(false); setRules(EMPTY_RULES); setPastRules([]); setError(''); setDownloadStatus('') }}>Abrir otro archivo</button></div></div>
        <div className="file-strip"><span className="file-icon">{document.format === 'xlsx' ? 'XLSX' : 'CSV'}</span><div><strong>{document.name}</strong><small>{formatBytes(document.size)} · {analysis.rowCount} filas · {analysis.columnCount} columnas</small></div><span className="local-badge">Procesado en este navegador</span></div>
        {busy && <div className="notice processing" role="status"><span>{progressLabel || 'Procesando archivo…'}</span><progress className="progress-bar" max={100} value={progress ?? undefined} /></div>}

        {(delimiterAmbiguous || document.parseErrors.length > 0 || document.encodingWarning) && <div className="notice warning" role="status"><strong>Revisa la lectura antes de continuar.</strong>
          {delimiterAmbiguous && <p>No pudimos elegir con seguridad el separador. Selecciona el que corresponda a tu archivo.</p>}
          {document.parseErrors.length > 0 && <p>El lector encontró {document.parseErrors.length} aviso(s): {document.parseErrors.slice(0, 3).join(' · ')}{document.parseErrors.length > 3 ? ' …' : ''}</p>}
          {document.encodingWarning && <p>Algunos caracteres no parecen decodificarse como UTF-8. Comprueba acentos y símbolos; no podemos detectar perfectamente la codificación.</p>}
        </div>}
        {document.workbookWarnings && document.workbookWarnings.length > 0 && <div className="notice warning"><strong>Limitaciones del libro de Excel</strong>{document.workbookWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        {(document.xlsxPrecisionCount ?? 0) > 0 && <div className="notice warning" role="status"><strong>Revisa identificadores numéricos largos</strong><p>{document.xlsxPrecisionCount} valores numéricos pueden exceder la precisión segura. {document.xlsxPrecisionCells?.length ? `Referencias: ${document.xlsxPrecisionCells.join(', ')}${(document.xlsxPrecisionCount ?? 0) > document.xlsxPrecisionCells.length ? ', y otras celdas' : ''}.` : ''} Las celdas visibles están marcadas; si Excel ya redondeó el valor, Dato Studio no puede recuperar los dígitos originales.</p></div>}
        {document.format === 'xlsx' && document.sheets && <div className="import-options"><label>Hoja del libro <select disabled={busy} value={selectedSheet} onChange={(event) => { setSelectedSheet(event.target.value); void reparse({ sheetName: event.target.value }) }}>{document.sheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name} — {sheet.rows} filas × {sheet.columns} columnas</option>)}</select></label><label className="check-label"><input type="checkbox" disabled={busy} checked={hasHeader} onChange={(event) => void reparse({ hasHeader: event.target.checked })} /> La primera fila contiene encabezados</label></div>}
        {document.format !== 'xlsx' && <div className="import-options"><label>Separador <select disabled={busy} value={delimiter} onChange={(event) => void reparse({ delimiter: event.target.value as Delimiter })}>{DELIMITERS.map((value) => <option key={value} value={value}>{delimiterName(value)}</option>)}</select></label><label className="check-label"><input type="checkbox" disabled={busy} checked={hasHeader} onChange={(event) => void reparse({ hasHeader: event.target.checked })} /> La primera fila contiene encabezados</label></div>}

        <section className="panel" aria-labelledby="summary-title"><div className="panel-heading"><div><p className="eyebrow">SIN CAMBIAR EL ARCHIVO</p><h2 id="summary-title">Resumen del diagnóstico</h2></div></div>
          <div className="stat-grid"><Stat value={analysis.rowCount} label="filas de datos" /><Stat value={analysis.columnCount} label="columnas" /><Stat value={analysis.emptyCells} label="celdas vacías" /><Stat value={analysis.emptyRows} label="filas vacías" /><Stat value={analysis.duplicateRows} label="filas duplicadas" /><Stat value={analysis.edgeSpaces} label="celdas con espacios" /><Stat value={analysis.irregularRows} label="filas irregulares" /><Stat value={analysis.ambiguousValues} label="valores por revisar" /></div>
          {analysis.byColumn.length > 0 && <div className="diagnostic-table-wrap"><table className="diagnostic-table"><caption>Hallazgos por columna</caption><thead><tr><th scope="col">Columna</th><th scope="col">Celdas vacías</th><th scope="col">Con espacios al borde</th><th scope="col">Valores por revisar</th></tr></thead><tbody>{analysis.byColumn.map((column) => <tr key={column.index}><th scope="row">{displayHeaders[column.index] ?? `Columna ${column.index + 1}`}</th><td>{column.emptyCells}</td><td>{column.edgeSpaces}</td><td>{column.ambiguousValues}</td></tr>)}</tbody></table></div>}
          {(analysis.emptyHeaders > 0 || analysis.duplicateHeaders > 0) && <p className="inline-warning">Encabezados: {analysis.emptyHeaders} vacíos y {analysis.duplicateHeaders} repetidos. Se conserva su orden y contenido original.</p>}
          {document.format === 'xlsx' && <p className="definition-note">Las fechas y los números se muestran según su valor y formato de celda; no se convierten. Las fórmulas no se ejecutan.</p>}
          <p className="definition-note">“Vacía” significa que cada celda tiene longitud cero; espacios no cuentan como vacío. “Duplicada” significa que todos sus campos coinciden exactamente, en el mismo orden. Los avisos no modifican los datos.</p>
        </section>

        <section className="panel" aria-labelledby="clean-title"><div className="panel-heading"><div><p className="eyebrow">CAMBIOS REVERSIBLES</p><h2 id="clean-title">Elige qué quieres limpiar</h2><p className="section-copy">Los originales se mantienen en el worker durante esta sesión. La vista previa no carga todas las filas a la página.</p></div><button className="button-secondary" onClick={() => void undo()} disabled={!pastRules.length || busy}>Deshacer último cambio</button></div>
          <div className="rule-list" aria-busy={busy}>
            <RuleRow title="Recortar espacios" detail="Quita espacios al principio y al final del texto en las columnas elegidas." checked={rules.trim} disabled={busy} onChange={(checked) => void updateRules((current) => ({ ...current, trim: checked }))} />
            {rules.trim && <ColumnPicker columns={displayHeaders} selected={rules.trimColumns} disabled={busy} onChange={(selected) => void updateRules((current) => ({ ...current, trimColumns: selected }))} label="Columnas donde recortar" />}
            <RuleRow title="Eliminar filas completamente vacías" detail={`Coinciden ${analysis.emptyRows} filas. Solo se quitarán si confirmas aquí y puedes deshacerlo.`} checked={rules.removeEmpty} disabled={busy} onChange={(checked) => { if (checked && analysis.emptyRows && !window.confirm(`Se quitarán ${analysis.emptyRows} filas donde todas las celdas están vacías. ¿Continuar?`)) return; void updateRules((current) => ({ ...current, removeEmpty: checked })) }} />
            <RuleRow title="Eliminar filas duplicadas exactas" detail={`Coinciden ${analysis.duplicateRows} filas repetidas. Se conserva la primera y no se comparan coincidencias aproximadas.`} checked={rules.removeDuplicates} disabled={busy} onChange={(checked) => { if (checked && analysis.duplicateRows && !window.confirm(`Se quitarán ${analysis.duplicateRows} filas duplicadas exactas. Se conserva la primera. ¿Continuar?`)) return; void updateRules((current) => ({ ...current, removeDuplicates: checked })) }} />
            <div className="rule-row"><div><strong>Mayúsculas o minúsculas</strong><p>Cambia el texto solo en las columnas que elijas.</p></div><select disabled={busy} aria-label="Conversión de mayúsculas y minúsculas" value={rules.caseMode} onChange={(event) => void updateRules((current) => ({ ...current, caseMode: event.target.value as CleanRules['caseMode'] }))}><option value="none">Sin cambio</option><option value="upper">MAYÚSCULAS</option><option value="lower">minúsculas</option></select></div>
            {rules.caseMode !== 'none' && <ColumnPicker columns={displayHeaders} selected={rules.caseColumns} disabled={busy} onChange={(selected) => void updateRules((current) => ({ ...current, caseColumns: selected }))} label="Columnas para cambiar texto" />}
            {document.hasHeader && <RuleRow title="Normalizar encabezados" detail="Quita espacios sobrantes, cambia espacios interiores por _ y convierte a minúsculas. Solo los encabezados; solicita esto explícitamente." checked={rules.normalizeHeaders} disabled={busy} onChange={(checked) => void updateRules((current) => ({ ...current, normalizeHeaders: checked }))} />}
          </div>
          {analysis.ambiguousValues > 0 && <p className="inline-warning">Hay {analysis.ambiguousValues} valores con aspecto de fecha o número. No los convertimos automáticamente porque su significado puede depender de la región o del contexto.</p>}
        </section>

        <section className="panel" aria-labelledby="preview-title"><div className="panel-heading"><div><p className="eyebrow">COMPARACIÓN</p><h2 id="preview-title">Antes y después</h2><p className="section-copy">{cleaned.changedCells} celdas cambian · {cleaned.removedEmpty + cleaned.removedDuplicates} filas se quitarían · Se muestran hasta {PREVIEW_ROWS} filas.</p></div></div>
          <div className="search-controls">
            <label className="search-input-label">Buscar en todas las filas<input type="search" aria-label="Buscar en todas las filas" value={searchQuery} disabled={busy} placeholder="Buscar texto…" onChange={(event) => { const query = event.target.value; setSearchQuery(query); setSearchOffset(0); setSearchView(null); setSearchError(''); setSearchPending(query !== '') }} /></label>
            <label>Columna<select aria-label="Columna de búsqueda" disabled={busy} value={searchColumnIndex === null ? 'all' : String(searchColumnIndex)} onChange={(event) => { const value = event.target.value; setSearchColumnIndex(value === 'all' ? null : Number(value)); setSearchOffset(0); setSearchView(null); setSearchError(''); setSearchPending(searchQuery !== '') }}><option value="all">Todas las columnas</option>{displayHeaders.map((header, index) => <option key={index} value={index}>{header}</option>)}</select></label>
            <label className="search-case-toggle"><input type="checkbox" disabled={busy} checked={searchCaseSensitive} onChange={(event) => { setSearchCaseSensitive(event.target.checked); setSearchView(null); setSearchError(''); setSearchPending(searchQuery !== '') }} /> Distinguir mayúsculas</label>
            {searchQuery !== '' && <button className="button-secondary search-clear" type="button" onClick={clearSearch}>Limpiar búsqueda</button>}
          </div>
          {searchQuery !== '' && <div className="search-status" aria-live="polite"><p role={searchError ? 'alert' : 'status'}>{searchError || (visibleSearch ? visibleSearch.totalMatches === 0 ? 'Sin coincidencias.' : `Coincidencias ${visibleSearch.offset + 1}–${visibleSearch.offset + visibleSearch.rows.length} de ${visibleSearch.totalMatches.toLocaleString('es')} · Página ${Math.floor(visibleSearch.offset / SEARCH_PAGE_SIZE) + 1} de ${totalSearchPages}` : searchPending || progressLabel === 'Buscando en todas las filas…' ? 'Buscando en todas las filas…' : 'Preparando búsqueda…')}</p>
            {visibleSearch && visibleSearch.totalMatches > 0 && <div className="search-pagination"><button className="button-secondary search-page-button" type="button" aria-label="Página anterior de resultados" title="Página anterior" disabled={busy || searchPending || searchOffset === 0} onClick={() => { setSearchOffset(Math.max(0, searchOffset - SEARCH_PAGE_SIZE)); setSearchView(null); setSearchPending(true) }}>←</button><button className="button-secondary search-page-button" type="button" aria-label="Página siguiente de resultados" title="Página siguiente" disabled={busy || searchPending || searchOffset + SEARCH_PAGE_SIZE >= visibleSearch.totalMatches} onClick={() => { setSearchOffset(searchOffset + SEARCH_PAGE_SIZE); setSearchView(null); setSearchPending(true) }}>→</button></div>}
          </div>}
          <div className="table-scroll"><table className="data-table"><thead><tr><th className="row-index">Fila</th>{displayHeaders.map((_, index) => { const originalHeader = document.originalHeaders[index] ?? ''; const resultHeader = cleaned.headers[index] ?? originalHeader; return <th key={index}>{originalHeader || `Columna ${index + 1}`}{originalHeader !== resultHeader && <small>Resultado: {resultHeader || '(vacío)'}</small>}</th> })}</tr></thead><tbody>
            {displayRows.map(({ sourceIndex, original, result, removed, precisionWarnings }) => <tr key={sourceIndex} className={removed ? 'removed-row' : ''}><th className="row-index">{sourceIndex + 1}</th>{displayHeaders.map((_, columnIndex) => { const before = original[columnIndex] ?? ''; const after = result?.[columnIndex] ?? ''; const changed = !removed && result !== null && before !== after; const precisionWarning = precisionWarnings[columnIndex]; return <td key={columnIndex} className={removed ? 'removed-cell' : changed ? 'changed-cell' : ''}><span className="before-value">{before || <i>vacío</i>}</span>{precisionWarning && <small className="cell-warning" role="note">Precisión numérica limitada; revisa el original.</small>}{removed ? <span className="after-value">Se quitaría</span> : changed && <span className="after-value">{after || <i>vacío</i>}</span>}</td> })}</tr>)}
          </tbody></table></div>
          {searchQuery === '' && analysis.rowCount > PREVIEW_ROWS && <p className="table-footnote">La vista previa está limitada a {PREVIEW_ROWS} filas; la exportación procesará todas las filas.</p>}{searchQuery === '' && analysis.rowCount > 0 && keptSourceIndexes.length === 0 && <p className="empty-state">Todas las filas visibles quedarían fuera con las reglas actuales. Desactiva alguna regla para continuar.</p>}
        </section>

        <section className="panel export-panel" aria-labelledby="export-title"><div className="panel-heading"><div><p className="eyebrow">ARCHIVO NUEVO</p><h2 id="export-title">Exporta el resultado</h2><p className="section-copy">El archivo original no se reemplaza. Se exportarán todas las filas, no solo la vista previa.</p></div></div>
          <div className="export-options"><label>Formato de salida <select disabled={busy} value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as 'csv' | 'xlsx')}><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label>
            {outputFormat === 'csv' && <label>Separador <select disabled={busy} value={outputDelimiter} onChange={(event) => setOutputDelimiter(event.target.value as ',' | ';' | '\t')}><option value=",">Coma (,)</option><option value=";">Punto y coma (;)</option><option value="\t">Tabulación</option></select></label>}
            {outputFormat === 'csv' && formulaRiskCount > 0 && <label className="safe-option"><input type="checkbox" disabled={busy} checked={safeExport} onChange={(event) => setSafeExport(event.target.checked)} /> Neutralizar {formulaRiskCount} valores que podrían ejecutarse como fórmulas</label>}
            {outputFormat === 'csv' && formulaRiskCount > 0 && <p className="inline-warning">La opción segura antepone un apóstrofo y cambia esos campos para que se importen como texto. Si la dejas desmarcada, tendrás que confirmar antes de exportar sin modificarlos.</p>}
            {outputFormat === 'xlsx' && <p className="inline-warning">El archivo Excel se reconstruirá como un único libro tabular. Las características avanzadas del original no se conservan necesariamente.</p>}
            <button className="button-primary" onClick={() => void exportResult()} disabled={busy || (cleaned.rows.length === 0 && cleaned.headers.length === 0)}>{busy ? progressLabel || 'Procesando…' : `Descargar ${outputFormat.toUpperCase()}`}</button>
            {downloadStatus && <p className="success-banner" role="status">{downloadStatus}</p>}
          </div>
        </section>
        {error && <p className="error-banner" role="alert">{error}</p>}
      </section>}

      <footer className="footer"><span>Dato Studio</span><span>Una forma más cuidadosa de trabajar con datos.</span></footer>
    </main>
  )
}

function Stat({ value, label }: { value: number; label: string }) { return <div className="stat-card"><strong>{value.toLocaleString('es')}</strong><span>{label}</span></div> }
function RuleRow({ title, detail, checked, disabled, onChange }: { title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) { return <label className="rule-row"><span className="rule-copy"><strong>{title}</strong><span>{detail}</span></span><input type="checkbox" disabled={disabled} checked={checked} onChange={(event) => onChange(event.target.checked)} /></label> }
function ColumnPicker({ columns, selected, disabled, onChange, label }: { columns: string[]; selected: number[]; disabled?: boolean; onChange: (selected: number[]) => void; label: string }) { return <fieldset className="column-picker" disabled={disabled}><legend>{label}</legend>{columns.map((column, index) => <label key={index}><input type="checkbox" checked={selected.includes(index)} onChange={(event) => onChange(event.target.checked ? [...selected, index] : selected.filter((item) => item !== index))} />{column}</label>)}</fieldset> }

export default App
