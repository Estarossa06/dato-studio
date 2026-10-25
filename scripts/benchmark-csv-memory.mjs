import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Papa from 'papaparse'

const sizes = process.argv.slice(2).map(Number).filter((size) => Number.isFinite(size) && size > 0)
if (!sizes.length) sizes.push(10, 25, 50)
const directory = await mkdtemp(join(tmpdir(), 'dato-studio-csv-bench-'))

async function writeFixture(path, targetBytes) {
  const output = createWriteStream(path)
  output.write('id,codigo,nombre\r\n')
  let written = Buffer.byteLength('id,codigo,nombre\r\n')
  let index = 0
  let lines = ''
  while (written < targetBytes) {
    const line = `${index},000742,Muñoz registro ${index}\r\n`
    lines += line
    written += Buffer.byteLength(line)
    index++
    if (lines.length >= 1024 * 512) {
      if (!output.write(lines)) await once(output, 'drain')
      lines = ''
    }
  }
  if (lines && !output.write(lines)) await once(output, 'drain')
  output.end()
  await once(output, 'finish')
  return { rows: index, bytes: written }
}

try {
  for (const sizeMb of sizes) {
    if (globalThis.gc) globalThis.gc()
    const path = join(directory, `sample-${sizeMb}mb.csv`)
    const start = performance.now()
    const fixture = await writeFixture(path, sizeMb * 1024 * 1024)
    const text = await readFile(path, 'utf8')
    const parseStart = performance.now()
    const rows = []
    const seen = new Set()
    let duplicates = 0
    let peakRss = process.memoryUsage().rss
    Papa.parse(text, {
      chunkSize: 1024 * 1024,
      dynamicTyping: false,
      skipEmptyLines: false,
      chunk(result) {
        for (const row of result.data) {
          if (row.length === 3 && row[0] === 'id') continue
          rows.push(row)
        }
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      },
    })
    if (/[\r\n]$/.test(text) && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === '') rows.pop()
    const parsedCount = rows.length
    const parseDoneActual = performance.now()
    let emptyRows = 0
    let emptyCells = 0
    let edgeSpaces = 0
    let ambiguousValues = 0
    let formulaLike = 0
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]
      if (row.every((cell) => cell === '')) emptyRows++
      const key = JSON.stringify(row)
      if (seen.has(key)) duplicates++
      else seen.add(key)
      for (const cell of row) {
        if (cell === '') emptyCells++
        if (cell !== cell.trim()) edgeSpaces++
        if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(cell.trim()) || /^\d+[.,]\d+$/.test(cell.trim())) ambiguousValues++
        if (/^[\t\r\n ]*[=+\-@]/.test(cell)) formulaLike++
      }
      if (rowIndex < 30) row.map((cell) => cell)
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const done = performance.now()
    console.log(JSON.stringify({
      targetMB: sizeMb,
      fileMB: +(fixture.bytes / 1024 / 1024).toFixed(2),
      rowsWritten: fixture.rows,
      rowsParsed: parsedCount,
      duplicates,
      emptyRows,
      emptyCells,
      edgeSpaces,
      ambiguousValues,
      formulaLike,
      fixtureAndReadSeconds: +((parseStart - start) / 1000).toFixed(2),
      parseSeconds: +((parseDoneActual - parseStart) / 1000).toFixed(2),
      diagnosticsSeconds: +((done - parseDoneActual) / 1000).toFixed(2),
      peakRssMB: +(peakRss / 1024 / 1024).toFixed(0),
    }))
    rows.length = 0
    seen.clear()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
