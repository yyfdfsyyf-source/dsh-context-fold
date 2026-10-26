/**
 * spill：把被折叠的原文落盘，并按 id 读回。
 *
 * 目录布局：`<DSH_HOME>/context-fold/spill/<id>.txt`
 * 文件内容就是**完整原文**，不加任何头部，保证 `recall` 拿到的字节与原文一致。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureDir, listDir, readTextSafe, removeFile } from './store.js'
import { byteLength, slugId } from './core/tokens.js'

/**
 * spill 目录。
 * @param {string} root `<DSH_HOME>/context-fold`
 * @returns {string}
 */
export function spillDir(root) {
  return path.join(root, 'spill')
}

/**
 * 由任意 id 得到安全的落盘文件名。
 * @param {string} id
 * @returns {string}
 */
export function spillFileName(id) {
  return `${slugId(id)}.txt`
}

/**
 * 落盘一段原文。
 * @param {string} dir spill 目录
 * @param {string} id
 * @param {string} text
 * @returns {Promise<{ id: string, path: string, bytes: number }>}
 */
export async function saveSpill(dir, id, text) {
  const safeId = slugId(id)
  await ensureDir(dir)
  const file = path.join(dir, `${safeId}.txt`)
  await fs.writeFile(file, typeof text === 'string' ? text : '', 'utf8')
  return { id: safeId, path: file, bytes: byteLength(text) }
}

/**
 * 读回 spill。
 * @param {string} dir
 * @param {string} id
 * @returns {Promise<string | undefined>} 不存在返回 undefined。
 */
export async function readSpill(dir, id) {
  return readTextSafe(path.join(dir, `${slugId(id)}.txt`))
}

/**
 * 列出所有 spill id（不含扩展名）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listSpills(dir) {
  const names = await listDir(dir)
  return names.filter((name) => name.endsWith('.txt')).map((name) => name.slice(0, -4)).sort()
}

/**
 * 清理 spill。
 *
 * @param {string} dir
 * @param {{ maxAgeDays?: number, maxFiles?: number, keep?: string[] }} [options]
 *   `maxAgeDays` 按 mtime 删除过旧文件；`maxFiles` 超出时删最旧的（`keep` 里的除外）。
 * @returns {Promise<{ removed: number, kept: number }>}
 */
export async function cleanSpills(dir, options = {}) {
  const keep = new Set((Array.isArray(options.keep) ? options.keep : []).map((id) => slugId(id)))
  const names = (await listDir(dir)).filter((name) => name.endsWith('.txt'))

  const entries = []
  for (const name of names) {
    const id = name.slice(0, -4)
    if (keep.has(id)) continue
    const file = path.join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs
    } catch {
      continue
    }
    entries.push({ id, file, mtimeMs })
  }

  let removed = 0
  const now = Date.now()
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : 0

  const survivors = []
  for (const entry of entries) {
    if (maxAgeDays > 0 && now - entry.mtimeMs > maxAgeDays * 86_400_000) {
      if (await removeFile(entry.file)) removed += 1
      continue
    }
    survivors.push(entry)
  }

  const maxFiles = Number.isFinite(options.maxFiles) ? Math.floor(options.maxFiles) : 0
  if (maxFiles > 0 && survivors.length > maxFiles) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of survivors.slice(0, survivors.length - maxFiles)) {
      if (await removeFile(entry.file)) removed += 1
    }
  }

  return { removed, kept: names.length - removed }
}
