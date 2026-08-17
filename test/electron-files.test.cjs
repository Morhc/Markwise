'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const {
  atomicWrite,
  defaultPdfPath,
  documentBaseUrl,
  externalUrl,
  normalizeImageSource,
} = require('../electron/files.cjs')

test('externalUrl accepts only explicitly supported protocols', () => {
  assert.equal(externalUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(externalUrl('mailto:person@example.com'), 'mailto:person@example.com')
  assert.equal(externalUrl('file:///etc/passwd'), null)
  assert.equal(externalUrl('javascript:alert(1)'), null)
  assert.equal(externalUrl('not a URL'), null)
})

test('normalizeImageSource preserves URLs and converts absolute paths', () => {
  assert.equal(normalizeImageSource('data:image/png;base64,AA==', '/home/test'), 'data:image/png;base64,AA==')
  assert.equal(normalizeImageSource('images/chart.png', '/home/test'), 'images/chart.png')
  assert.equal(normalizeImageSource('~/chart.png', '/home/test'), 'file:///home/test/chart.png')
  assert.equal(normalizeImageSource('/tmp/chart.png', '/home/test'), pathToFileURL('/tmp/chart.png').toString())
  assert.equal(normalizeImageSource('javascript:alert(1)', '/home/test'), '')
})

test('documentBaseUrl returns an encoded trailing-slash directory URL', () => {
  assert.equal(
    documentBaseUrl('/tmp/Markdown Project/guide.md'),
    'file:///tmp/Markdown%20Project/',
  )
  assert.equal(documentBaseUrl('/guide.md'), 'file:///')
})

test('defaultPdfPath follows the document name and handles untitled documents', () => {
  assert.equal(defaultPdfPath('/tmp/notes/Guide.markdown'), '/tmp/notes/Guide.pdf')
  assert.equal(defaultPdfPath(null), 'Untitled.pdf')
})

test('atomicWrite replaces contents without leaving temporary files', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'markwise-test-'))
  const filePath = path.join(directory, 'document.md')

  try {
    await fs.promises.writeFile(filePath, 'old contents', 'utf8')
    await atomicWrite(filePath, '# New contents\n')
    assert.equal(await fs.promises.readFile(filePath, 'utf8'), '# New contents\n')
    assert.deepEqual(await fs.promises.readdir(directory), ['document.md'])
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})

test('atomicWrite preserves binary contents', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'markwise-binary-test-'))
  const destination = path.join(directory, 'output.pdf')
  const contents = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff])

  try {
    await atomicWrite(destination, contents)
    assert.deepEqual(await fs.promises.readFile(destination), contents)
    assert.deepEqual(await fs.promises.readdir(directory), ['output.pdf'])
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true })
  }
})
