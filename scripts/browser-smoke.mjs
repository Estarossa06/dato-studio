import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

const root = process.cwd()
const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edgePath = edgeCandidates.find(existsSync)
if (!edgePath) throw new Error('Microsoft Edge no está instalado en una ubicación conocida.')
const port = 9437
const temp = await mkdtemp(join(tmpdir(), 'dato-studio-edge-smoke-'))
const profile = join(temp, 'profile')
const downloads = join(temp, 'downloads')
await mkdir(downloads)
const csvPath = join(temp, 'browser.csv')
const xlsxPath = join(temp, 'browser.xlsx')
const unsupportedPath = join(temp, 'renamed.xls')
const wrongExtensionPath = join(temp, 'workbook-as-csv.csv')
const invalidXlsxPath = join(temp, 'invalid.xlsx')
const precisionXlsxPath = join(temp, 'precision.xlsx')
const largeCsvFiles = [10, 25, 50].map((size) => ({ size, path: join(temp, `browser-${size}mb.csv`), targetBytes: size * 1024 * 1024 - 1 }))
const oversizeCsvPath = join(temp, 'browser-100mb.csv')
const csvOverLimitPath = join(temp, 'browser-50mb-plus-one.csv')
const atLimitCsvPath = join(temp, 'browser-at-50mb.csv')
const xlsxOverLimitPath = join(temp, 'browser-10mb-plus-one.xlsx')
await writeFile(csvPath, 'id,nombre,riesgo\r\n000742," Muñoz ",=1+1\r\n000743,Ana,@nombre\r\n', 'utf8')
async function writeLargeCsv(path, targetBytes) {
  const output = createWriteStream(path)
  let bytes = Buffer.byteLength('id,codigo,nombre\r\n')
  output.write('id,codigo,nombre\r\n')
  let index = 0
  let batch = ''
  while (true) {
    const line = `${index},000742,Muñoz registro ${index}\r\n`
    const length = Buffer.byteLength(line)
    if (bytes + length > targetBytes) break
    batch += line
    bytes += length
    index++
    if (batch.length >= 512 * 1024) {
      if (!output.write(batch)) await once(output, 'drain')
      batch = ''
    }
  }
  const padding = targetBytes - bytes
  if (padding > 0) {
    batch += 'x'.repeat(padding)
    bytes += padding
    index++
  }
  if (batch && !output.write(batch)) await once(output, 'drain')
  output.end()
  await once(output, 'finish')
  return { bytes, rows: index }
}
async function writeSizedWorkbook(path, targetPayloadBytes) {
  const rows = [['payload']]
  let payloadBytes = 0
  while (payloadBytes < targetPayloadBytes) {
    const index = rows.length.toString().padStart(5, '0')
    const cellLength = Math.min(32000, targetPayloadBytes - payloadBytes)
    const value = index + 'A'.repeat(Math.max(0, cellLength - index.length))
    rows.push([value])
    payloadBytes += value.length
  }
  const sizedBook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(sizedBook, XLSX.utils.aoa_to_sheet(rows), 'Datos')
  const bytes = Buffer.from(XLSX.write(sizedBook, { bookType: 'xlsx', type: 'array' }))
  await writeFile(path, bytes)
  return { bytes: bytes.byteLength, rows: rows.length - 1 }
}
const generatedLarge = []
for (const item of largeCsvFiles) generatedLarge.push({ ...item, ...await writeLargeCsv(item.path, item.targetBytes) })
const atLimitCsv = await writeLargeCsv(atLimitCsvPath, 50 * 1024 * 1024)
const csvOverLimit = await writeLargeCsv(csvOverLimitPath, 50 * 1024 * 1024 + 1)
await writeFile(xlsxOverLimitPath, Buffer.alloc(10 * 1024 * 1024 + 1))
const sizedWorkbookFiles = [1, 5, 9.9].map((size) => ({ size, path: join(temp, `browser-${size}mb.xlsx`) }))
const generatedSizedWorkbooks = []
for (const item of sizedWorkbookFiles) generatedSizedWorkbooks.push({ ...item, ...await writeSizedWorkbook(item.path, Math.floor(item.size * 1024 * 1024)) })
const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['id', 'nombre'], ['000742', 'primera']]), 'Datos')
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['id', 'nombre'], ['000743', 'segunda']]), 'Otra')
await writeFile(xlsxPath, Buffer.from(XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true })))
const precisionWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(precisionWorkbook, XLSX.utils.aoa_to_sheet([
  ['ID textual', 'Entero numérico'],
  ['000742', 9007199254740992],
]), 'Precisión')
await writeFile(precisionXlsxPath, Buffer.from(XLSX.write(precisionWorkbook, { bookType: 'xlsx', type: 'array', compression: true })))
await writeFile(unsupportedPath, 'contenido')
await writeFile(wrongExtensionPath, await readFile(xlsxPath))
await writeFile(invalidXlsxPath, 'esto no es un libro Excel')

const browser = spawn(edgePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  'http://127.0.0.1:5173/',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
let browserStderr = ''
browser.stderr.on('data', (data) => { browserStderr += data.toString() })

let socket
try {
  let version
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) { version = await response.json(); break }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!version) throw new Error(`Edge no abrió su endpoint de automatización. ${browserStderr.trim()}`)
  let targets = []
  for (let attempt = 0; attempt < 40; attempt++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    if (targets.some((target) => target.type === 'page')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('Edge no creó una pestaña para la aplicación.')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let commandId = 0
  const waiting = new Map()
  const consoleErrors = []
  const externalRequests = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && waiting.has(message.id)) {
      const callbacks = waiting.get(message.id)
      waiting.delete(message.id)
      if (message.error) callbacks.reject(new Error(`${callbacks.method}: ${message.error.message}`))
      else callbacks.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text)
    } else if (message.method === 'Network.requestWillBeSent') {
      const url = new URL(message.params.request.url)
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(message.params.request.url)
    }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId
    waiting.set(id, { resolve, reject, method })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    let response
    try { response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) }
    catch (error) { throw new Error(`${error.message}; expresión: ${expression}`) }
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
    return response.result?.value
  }
  const waitFor = async (expression, timeoutMs = 15000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const pageState = await evaluate("document.body.innerText.slice(-1800)")
    throw new Error(`Timeout esperando: ${expression}. Estado de página: ${pageState}`)
  }
  const upload = async (path) => {
    const tree = await cdp('DOM.getDocument', { depth: 1, pierce: true })
    const input = await cdp('DOM.querySelector', { nodeId: tree.root.nodeId, selector: 'input[type="file"]' })
    if (!input.nodeId) throw new Error('No se encontró el selector de archivos.')
    await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] })
  }
  const clickByText = async (selector, text) => evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.innerText.includes(${JSON.stringify(text)})); if (!node) throw new Error('No se encontró control: ' + ${JSON.stringify(text)}); node.click(); return true })()`)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Log.enable')
  await cdp('Network.enable')
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true; Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 8 })' })
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await waitFor("document.querySelector('h1')?.innerText.includes('Limpia archivos')")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  const keyboardFocus = await evaluate("({element:document.activeElement?.tagName,outline:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})")
  if (keyboardFocus.outline === 'none' || keyboardFocus.width === '0px') throw new Error(`El foco de teclado no es visible: ${JSON.stringify(keyboardFocus)}`)

  await upload(unsupportedPath)
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('Este flujo admite CSV')")
  await upload(wrongExtensionPath)
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('la extensión no coincide')")
  await upload(invalidXlsxPath)
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('no parece ser un libro XLSX válido')")

  await upload(largeCsvFiles[2].path)
  await waitFor("[...document.querySelectorAll('button')].some(button => button.innerText === 'Cancelar')")
  await clickByText('button', 'Cancelar')
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('Se canceló el procesamiento')")
  const cancellationState = await evaluate("({fileStrip:!!document.querySelector('.file-strip'), progress:!!document.querySelector('progress'), pickerDisabled:document.querySelector('.upload-card button:not(.cancel-button)')?.disabled})")
  if (cancellationState.fileStrip || cancellationState.progress || cancellationState.pickerDisabled) throw new Error(`El estado no se restableció al cancelar: ${JSON.stringify(cancellationState)}`)

  await upload(csvPath)
  await waitFor("document.body.innerText.includes('browser.csv') && document.body.innerText.includes('2 filas')")
  const csvPreview = await evaluate("document.querySelector('.data-table tbody')?.innerText || ''")
  if (!csvPreview.includes('000742') || !csvPreview.includes('Muñoz')) throw new Error(`La vista previa CSV no coincide: ${csvPreview}`)
  await clickByText('label.rule-row', 'Recortar espacios')
  await waitFor("document.querySelector('.data-table .after-value')?.innerText === 'Muñoz'")
  const trimmed = await evaluate("document.querySelector('.data-table .after-value')?.innerText || ''")
  if (trimmed !== 'Muñoz') throw new Error('La vista previa no muestra el recorte esperado.')
  await clickByText('button', 'Deshacer último cambio')
  await waitFor("document.querySelector('.data-table tbody')?.innerText.includes(' Muñoz ')")
  await evaluate("document.querySelector('.safe-option input')?.click()")
  await waitFor("document.querySelector('.safe-option input')?.checked === true")
  await clickByText('button', 'Descargar CSV')
  let downloaded = []
  for (let attempt = 0; attempt < 100; attempt++) {
    downloaded = await readdir(downloads)
    if (downloaded.some((name) => name.endsWith('.csv') && !name.endsWith('.crdownload'))) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const csvDownload = downloaded.find((name) => name.endsWith('.csv') && !name.endsWith('.crdownload'))
  await waitFor("document.querySelector('.success-banner')?.innerText.includes('Descarga iniciada')")
  if (!csvDownload) throw new Error('No se descargó el CSV exportado.')
  const csvOutput = await readFile(join(downloads, csvDownload), 'utf8')
  if (!csvOutput.includes('000742') || !csvOutput.includes('Muñoz') || !csvOutput.includes("'=1+1") || !csvOutput.includes("'@nombre")) throw new Error('El CSV exportado no conservó valores originales o no neutralizó los riesgos esperados.')

  const browserLargeResults = []
  for (const item of generatedLarge) {
    await clickByText('button', 'Abrir otro archivo')
    await waitFor("!!document.querySelector('input[type=file]')")
    const started = Date.now()
    await upload(item.path)
    const fileName = item.path.split(/[\\/]/).at(-1)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(fileName)}) && !!document.querySelector('.file-strip small')`, 60000)
    const summary = await evaluate("document.querySelector('.file-strip small')?.innerText || ''")
    const actualRows = Number(summary.match(/([\d.,]+) filas/)?.[1]?.replace(/\D/g, ''))
    if (actualRows !== item.rows) throw new Error(`El CSV de ${item.size} MB perdió filas: esperado ${item.rows}, obtenido ${actualRows}. Resumen: ${summary}`)
    browserLargeResults.push({ sizeMB: +(item.bytes / 1024 / 1024).toFixed(2), rows: item.rows, processSeconds: +((Date.now() - started) / 1000).toFixed(2) })
  }

  const oversizeCsv = await writeLargeCsv(oversizeCsvPath, 100 * 1024 * 1024)
  await clickByText('button', 'Abrir otro archivo')
  await waitFor("!!document.querySelector('input[type=file]')")
  await upload(oversizeCsvPath)
  await waitFor("document.body.innerText.includes('supera el límite actual de 50.0 MB')")

  if (atLimitCsv.bytes !== 50 * 1024 * 1024) throw new Error(`El CSV de límite no tiene el tamaño exacto: ${atLimitCsv.bytes}`)
  await upload(atLimitCsvPath)
  await waitFor("document.body.innerText.includes('browser-at-50mb.csv') && !!document.querySelector('.file-strip small')", 60000)
  const atLimitSummary = await evaluate("document.querySelector('.file-strip small')?.innerText || ''")
  if (!atLimitSummary.includes(`${atLimitCsv.rows} filas`)) throw new Error(`El CSV justo en el límite no se procesó: ${atLimitSummary}`)
  await clickByText('button', 'Abrir otro archivo')
  await waitFor("!!document.querySelector('input[type=file]')")
  await upload(csvOverLimitPath)
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('supera el límite actual de 50.0 MB')")
  await upload(xlsxOverLimitPath)
  await waitFor("document.querySelector('[role=alert]')?.innerText.includes('XLSX supera el límite actual de 10.0 MB')")

  const xlsxSizeResults = []
  for (const item of generatedSizedWorkbooks) {
    if (item.bytes > 10 * 1024 * 1024) throw new Error(`Fixture XLSX supera el límite: ${item.bytes} bytes`)
    await upload(item.path)
    const fileName = item.path.split(/[\\/]/).at(-1)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(fileName)}) && !!document.querySelector('.file-strip small')`, 60000)
    const summary = await evaluate("document.querySelector('.file-strip small')?.innerText || ''")
    if (!summary.includes(`${item.rows} filas`)) throw new Error(`El XLSX de ${item.size} MB no cargó todas las filas: ${summary}`)
    xlsxSizeResults.push({ targetMB: item.size, actualMB: +(item.bytes / 1024 / 1024).toFixed(2), rows: item.rows })
    await clickByText('button', 'Abrir otro archivo')
    await waitFor("!!document.querySelector('input[type=file]')")
  }

  await upload(precisionXlsxPath)
  await waitFor("document.body.innerText.includes('precision.xlsx') && !!document.querySelector('.cell-warning')")
  const numericPrecisionWarning = await evaluate("document.querySelector('.cell-warning')?.innerText || ''")
  const textualIdentifier = await evaluate("document.querySelector('.data-table tbody tr td .before-value')?.innerText || ''")
  if (!numericPrecisionWarning.includes('Precisión numérica limitada') || textualIdentifier !== '000742') throw new Error('No se mostró la advertencia numérica junto al dato o se alteró el identificador textual.')
  await clickByText('button', 'Abrir otro archivo')
  await waitFor("!!document.querySelector('input[type=file]')")

  await upload(xlsxPath)
  await waitFor("document.body.innerText.includes('browser.xlsx') && !!document.querySelector('.import-options select')")
  await evaluate("(() => { const select = document.querySelector('.import-options select'); select.value = 'Otra'; select.dispatchEvent(new Event('change', { bubbles:true })); return true })()")
  await waitFor("document.querySelector('.data-table tbody')?.innerText.includes('segunda')")
  const xlsxPreview = await evaluate("document.querySelector('.data-table tbody')?.innerText || ''")
  if (!xlsxPreview.includes('000743') || !xlsxPreview.includes('segunda')) throw new Error(`La hoja XLSX seleccionada no coincide: ${xlsxPreview}`)
  await evaluate("(() => { const select = [...document.querySelectorAll('.export-options select')].find(el => [...el.options].some(option => option.value === 'xlsx')); select.value = 'xlsx'; select.dispatchEvent(new Event('change', { bubbles:true })); return true })()")
  await clickByText('button', 'Descargar XLSX')
  let xlsxDownload
  for (let attempt = 0; attempt < 100; attempt++) {
    const names = await readdir(downloads)
    xlsxDownload = names.find((name) => name.endsWith('.xlsx') && !name.endsWith('.crdownload'))
    if (xlsxDownload) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!xlsxDownload) throw new Error(`No se descargó el XLSX exportado. Página: ${await evaluate('document.body.innerText')}. Consola: ${consoleErrors.join(' | ')}`)
  await waitFor("document.querySelector('.success-banner')?.innerText.includes('Descarga iniciada')")
  const exportedWorkbook = XLSX.read(new Uint8Array(await readFile(join(downloads, xlsxDownload))), { type: 'array' })
  const exportedRows = XLSX.utils.sheet_to_json(exportedWorkbook.Sheets[exportedWorkbook.SheetNames[0]], { header: 1, raw: true })
  if (exportedRows[1]?.[0] !== '000743' || exportedRows[1]?.[1] !== 'segunda') throw new Error(`El XLSX exportado no coincide: ${JSON.stringify(exportedRows)}`)

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const mobile = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth})")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true })
  const narrow = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth})")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false })
  const desktop = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,viewport:document.documentElement.clientWidth})")
  if (mobile.scrollWidth > mobile.viewport) throw new Error(`La página móvil desborda el viewport: ${JSON.stringify(mobile)}`)
  if (narrow.scrollWidth > narrow.viewport) throw new Error(`La página estrecha desborda el viewport: ${JSON.stringify(narrow)}`)
  if (desktop.scrollWidth > desktop.viewport) throw new Error(`La página de escritorio desborda el viewport: ${JSON.stringify(desktop)}`)
  if (externalRequests.length) throw new Error(`Se detectaron solicitudes externas: ${externalRequests.join(', ')}`)
  if (consoleErrors.length) throw new Error(`Errores en consola: ${consoleErrors.join(' | ')}`)
  console.log(JSON.stringify({ browser: version.Browser, keyboardFocus, invalidExtension: 'ok', extensionMismatch: 'ok', malformedXlsx: 'ok', cancellation: cancellationState, csvPreview: 'ok', trimUndo: 'ok', safeCsvExport: 'ok', largeCsv: browserLargeResults, csvAtLimit: { bytes: atLimitCsv.bytes, rows: atLimitCsv.rows, processed: atLimitSummary.includes(`${atLimitCsv.rows} filas`) }, csvOverLimit: { bytes: csvOverLimit.bytes, rejected: 'ok' }, oversized100mbRejected: { bytes: oversizeCsv.bytes, message: 'ok' }, xlsxSizes: xlsxSizeResults, xlsxOverLimit: { bytes: 10 * 1024 * 1024 + 1, rejected: 'ok' }, numericPrecisionWarning: numericPrecisionWarning, textIdentifier: textualIdentifier, xlsxSheetSelection: 'ok', xlsxExportRoundTrip: 'ok', mobile, narrow, desktop, externalRequests, consoleErrors }, null, 2))
} finally {
  socket?.close()
  if (browser.exitCode === null) {
    browser.kill()
    await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))])
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  try { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }) }
  catch (error) { console.warn(`No se pudo limpiar por completo el perfil temporal de Edge: ${error.message}`) }
}
