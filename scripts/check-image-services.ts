// Read-only real-account verification. Only image caches and protected image
// keys are written, through the same services used by the GUI.
import { app } from 'electron'
import { join } from 'path'
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
    const rows = await wcdbService.execQuery('hardlink', join(account, 'db_storage/hardlink/hardlink.db'),
      'SELECT md5, MAX(modify_time) AS changed FROM image_hardlink_info_v4 GROUP BY md5 ORDER BY changed DESC LIMIT 40')
    if (!rows.success) throw new Error(rows.error)
    const service = new ImageDecryptService()
    let located = 0, decrypted = 0, decoded = 0
    const failures: string[] = []
    for (const row of rows.rows || []) {
      if (located >= 20) break
      const link = await wcdbService.resolveImageHardlink(row.md5, account)
      if (!link.success) continue
      located++
      const result = await service.decryptImage({ imageMd5: row.md5, force: true, hardlinkOnly: true,
        preferFilePath: true, suppressEvents: true })
      if (!result.success || !result.localPath) { failures.push(result.error || 'decrypt failed'); continue }
      decrypted++
      try {
        await sharp(result.localPath).raw().toBuffer()
        decoded++
      } catch { failures.push('Image decoder rejected output') }
    }
    console.log('REAL IMAGE RESULT', JSON.stringify({ settingsKeyLookup: true, located, decrypted, decoded, failures }))
    if (located > 0 && decoded === located) code = 0
  } catch (error) { console.error(String(error)) }
  finally { await wcdbService.shutdown(); app.exit(code) }
})
