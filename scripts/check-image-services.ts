// Read-only real-account verification. Only image caches and protected image
// keys are written, through the same services used by the GUI.
import { app, BrowserWindow } from 'electron'
import { basename, join } from 'path'
import { readFileSync } from 'fs'
import sharp from 'sharp'
import { wcdbService } from '../electron/services/wcdbService'
import { ImageDecryptService } from '../electron/services/imageDecryptService'
import { ConfigService } from '../electron/services/config'
import { KeyProviderService } from '../electron/services/keyProviderService'

const account = process.env.WEFLOW_IMAGE_ACCOUNT
const profile = process.env.WEFLOW_USER_DATA_PATH
if (!account || !profile) throw new Error('Set WEFLOW_IMAGE_ACCOUNT and WEFLOW_USER_DATA_PATH explicitly.')
app.setPath('userData', profile)
const resources = process.env.WEFLOW_IMAGE_RESOURCES || ''
if (resources) {
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
  Object.defineProperty(app, 'isPackaged', { value: true })
}
app.whenReady().then(async () => {
  let code = 1
  try {
    wcdbService.setPaths(resources, profile)
    const config = new ConfigService()
    const keyCheck = await new KeyProviderService().autoGetImageKey(join(config.get('dbPath'), config.get('myAccountId')), undefined, config.get('myAccountId'))
    if (!keyCheck.success || !keyCheck.verified) throw new Error('Settings image-key lookup failed')
    if (!await wcdbService.open(account, config.get('decryptKey'), 'live')) throw new Error('Database open failed')
    const limit = Math.max(1, Math.min(1000, Number(process.env.WEFLOW_IMAGE_LIMIT) || 20))
    const order = process.env.WEFLOW_IMAGE_SAMPLE === 'spread' ? 'md5' : 'changed DESC'
    const selectedFiles: string[] = process.env.WEFLOW_IMAGE_FILES
      ? JSON.parse(readFileSync(process.env.WEFLOW_IMAGE_FILES, 'utf8')).map((file: string) => basename(file)) : []
    if (selectedFiles.some(file => !/^[a-f0-9]{32}(?:_[ht])?\.dat$/i.test(file))) throw new Error('Invalid sample filename')
    const selection = selectedFiles.length ? `WHERE file_name IN (${selectedFiles.map(file => `'${file}'`).join(',')})` : ''
    const rows = await wcdbService.execQuery('hardlink', join(account, 'db_storage/hardlink/hardlink.db'),
      `SELECT md5, MAX(modify_time) AS changed FROM image_hardlink_info_v4 ${selection} GROUP BY md5 ORDER BY ${order} LIMIT ${limit * 3}`)
    if (!rows.success) throw new Error(rows.error)
    const service = new ImageDecryptService()
    if (process.env.WEFLOW_IMAGE_FRESH === '1') {
      // Exercise the decoder even when an earlier run generated a disk cache.
      Object.defineProperty(service, 'findCachedOutputByDatPath', { value: () => null })
    }
    let located = 0, decrypted = 0, decoded = 0, rendered = 0
    const preview = selectedFiles.length ? new BrowserWindow({ show: false }) : undefined
    if (preview) await preview.loadURL('about:blank')
    const failures: string[] = []
    for (const row of rows.rows || []) {
      if (located >= limit) break
      const link = await wcdbService.resolveImageHardlink(row.md5, account)
      if (!link.success) continue
      located++
      const result = await service.decryptImage({ imageMd5: row.md5, force: true, hardlinkOnly: true,
        preferFilePath: true, suppressEvents: true })
      if (!result.success || !result.localPath) { failures.push(result.error || 'decrypt failed'); continue }
      decrypted++
      try {
        const pixels = await sharp(result.localPath).raw().toBuffer({ resolveWithObject: true })
        decoded++
        if (preview) {
          const image = `data:image/jpeg;base64,${readFileSync(result.localPath).toString('base64')}`
          const size = await preview.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
            img.onerror = () => reject(new Error('Renderer rejected image')); img.src = ${JSON.stringify(image)};
          })`)
          if (size[0] !== pixels.info.width || size[1] !== pixels.info.height) throw new Error('Renderer dimensions differ')
          rendered++
        }
      } catch { failures.push('Image decoder rejected output') }
      if (located % 50 === 0) console.log('IMAGE CHECK PROGRESS', JSON.stringify({ located, decrypted, decoded }))
    }
    preview?.destroy()
    console.log('REAL IMAGE RESULT', JSON.stringify({ settingsKeyLookup: true, located, decrypted, decoded, rendered, failures }))
    if (located > 0 && decoded === located && (!selectedFiles.length || rendered === located)) code = 0
  } catch (error) { console.error(String(error)) }
  finally { await wcdbService.shutdown(); app.exit(code) }
})
