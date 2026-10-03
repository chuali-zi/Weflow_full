# 第三方可插拔组件接口说明

本文保留上游的外部组件协议，下文“全部由用户配置”“留空无替代”等描述属于上游组件路径。当前分支在密钥 / WCDB / 原始导出路径留空时已有内置 wxtext 后端，详见 [本地接入说明](integrated-backend.md)。新的内置在线方案见 [在线架构](live-architecture.md)；显式配置外部组件时仍沿用本文协议。

内置在线引擎使用 sqlcipher3 0.6.2 的 Windows wheel，包含 SQLCipher / SQLite；冻结后端显式收集扩展与驱动发行元数据，不需要用户配置 DLL。驱动发行包原许可保存于 [sqlcipher3 许可](licenses/sqlcipher3.txt)，随 PyInstaller 元数据保留。感谢 sqlcipher3、SQLCipher 和 SQLite 提供在线数据库读取能力。项目整体仍沿用仓库 LICENSE，第三方组件适用其自身许可。

WeFlow 不再内置任何用于读取/解密本地数据的原生组件。以下四类能力全部由用户在
「设置 -> 数据库 -> 第三方组件路径」中自行配置一个可执行文件/动态库/插件路径，
应用只按下述协议与其交互，不对其来源、签名或实现方式做任何校验。

留空或指向的文件不存在时，对应功能会直接返回"未配置"错误，不会有任何降级或替代实现。

## 1. WCDB 实现（`wcdbLibPath`）

一个动态库（Windows `*.dll` / macOS `*.dylib` / Linux `*.so`），通过 [koffi](https://koffi.dev/)
以 C ABI 方式加载，用于读取本地 SQLCipher 数据库并提供会话/消息/联系人/朋友圈等查询。

加载流程（见 `electron/services/wcdbCore.ts` 的 `initialize()`）：
1. `koffi.load(wcdbLibPath)`。
2. 依次尝试绑定下列导出函数；某个符号不存在时该功能会被跳过（返回 `null`），不影响其余功能。
   第一个必须存在的函数是 `wcdb_open_account`，其余按需实现即可。

完整函数签名列表（`int32` 返回值均为状态码，`0` 表示成功；`_Out_ void** outJson` 类参数
通过 `wcdb_free_string` 释放调用方分配的字符串内存）：

```
int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)
int32 wcdb_close_account(int64 handle)
int32 wcdb_init()
int32 wcdb_shutdown()
int32 wcdb_purge_memory()
void  wcdb_free_string(void* ptr)
int32 wcdb_set_my_account_id(int64 handle, const char* accountId)
int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)
int32 wcdb_mark_all_sessions_read(int64 handle, _Out_ void** outError)
int32 wcdb_reorder_sessions_by_time(int64 handle, _Out_ void** outJson)
int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)
int32 wcdb_get_messages_by_type(int64 handle, const char* sessionId, int64 localType, int32 ascending, int32 limit, int32 offset, _Out_ void** outJson)
int32 wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)
int32 wcdb_get_message_by_id(int64 handle, const char* sessionId, int32 localId, _Out_ void** outJson)
int32 wcdb_get_message_by_svrid(int64 handle, const char* sessionId, const char* svrid, _Out_ void** outJson)
int32 wcdb_get_session_message_counts(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)
int32 wcdb_get_session_message_type_stats(int64 handle, const char* sessionId, int32 beginTimestamp, int32 endTimestamp, _Out_ void** outJson)
int32 wcdb_get_session_message_type_stats_batch(int64 handle, const char* sessionIdsJson, const char* optionsJson, _Out_ void** outJson)
int32 wcdb_get_session_message_date_counts(int64 handle, const char* sessionId, _Out_ void** outJson)
int32 wcdb_get_session_message_date_counts_batch(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)
int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)
int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)
int32 wcdb_close_message_cursor(int64 handle, int64 cursor)
int32 wcdb_set_message_cursor_projection(int64 handle, int64 cursor, int32 projection)
int32 wcdb_search_messages(int64 handle, const char* sessionId, const char* keyword, int32 limit, int32 offset, int32 beginTimestamp, int32 endTimestamp, _Out_ void** outJson)
int32 wcdb_ai_query_session_candidates(int64 handle, const char* optionsJson, _Out_ void** outJson)
int32 wcdb_update_message(int64 handle, const char* sessionId, int64 localId, int32 createTime, const char* newContent, _Out_ void** outError)
int32 wcdb_insert_text_message(int64 handle, const char* sessionId, const char* content, int64 status, int64 createTime, _Out_ void** outJson)
int32 wcdb_delete_message(int64 handle, const char* sessionId, int64 localId, int32 createTime, const char* dbPathHint, _Out_ void** outError)
int32 wcdb_check_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ int32* outInstalled)
int32 wcdb_install_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ void** outError)
int32 wcdb_uninstall_message_anti_revoke_trigger(int64 handle, const char* sessionId, _Out_ void** outError)
int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)
int32 wcdb_get_contact_status(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_contact_type_counts(int64 handle, _Out_ void** outJson)
int32 wcdb_get_contacts_compact(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_contact_alias_map(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_contact_friend_flags(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_chat_room_ext_buffer(int64 handle, const char* chatroomId, _Out_ void** outJson)
int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_head_image_buffers(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_get_group_member_count(int64 handle, const char* chatroomId, _Out_ int32* outCount)
int32 wcdb_get_group_member_counts(int64 handle, const char* chatroomIdsJson, _Out_ void** outJson)
int32 wcdb_get_group_members(int64 handle, const char* chatroomId, _Out_ void** outJson)
int32 wcdb_get_group_nicknames(int64 handle, const char* chatroomId, _Out_ void** outJson)
int32 wcdb_get_group_stats(int64 handle, const char* chatroomId, int32 begin, int32 end, _Out_ void** outJson)
int32 wcdb_get_aggregate_stats(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, _Out_ void** outJson)
int32 wcdb_get_available_years(int64 handle, const char* sessionIdsJson, _Out_ void** outJson)
int32 wcdb_get_annual_report_stats(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, _Out_ void** outJson)
int32 wcdb_get_annual_report_extras(int64 handle, const char* sessionIdsJson, int32 begin, int32 end, int32 peakBegin, int32 peakEnd, _Out_ void** outJson)
int32 wcdb_get_dual_report_stats(int64 handle, const char* sessionId, int32 begin, int32 end, _Out_ void** outJson)
int32 wcdb_get_my_footprint_stats(int64 handle, const char* optionsJson, _Out_ void** outJson)
int32 wcdb_get_message_tables(int64 handle, const char* sessionId, _Out_ void** outJson)
int32 wcdb_get_message_table_stats(int64 handle, const char* sessionId, _Out_ void** outJson)
int32 wcdb_get_message_dates(int64 handle, const char* sessionId, _Out_ void** outJson)
int32 wcdb_get_message_meta(int64 handle, const char* dbPath, const char* tableName, int32 limit, int32 offset, _Out_ void** outJson)
int32 wcdb_get_message_table_columns(int64 handle, const char* dbPath, const char* tableName, _Out_ void** outJson)
int32 wcdb_get_message_table_time_range(int64 handle, const char* dbPath, const char* tableName, _Out_ void** outJson)
int32 wcdb_list_tables(int64 handle, const char* kind, const char* dbPath, _Out_ void** outJson)
int32 wcdb_get_table_schema(int64 handle, const char* kind, const char* dbPath, const char* tableName, _Out_ void** outJson)
int32 wcdb_export_table_snapshot(int64 handle, const char* kind, const char* dbPath, const char* tableName, const char* outputPath, _Out_ void** outJson)
int32 wcdb_import_table_snapshot(int64 handle, const char* kind, const char* dbPath, const char* tableName, const char* inputPath, _Out_ void** outJson)
int32 wcdb_import_table_snapshot_with_schema(int64 handle, const char* kind, const char* dbPath, const char* tableName, const char* inputPath, const char* createTableSql, _Out_ void** outJson)
int32 wcdb_list_message_dbs(int64 handle, _Out_ void** outJson)
int32 wcdb_list_media_dbs(int64 handle, _Out_ void** outJson)
int32 wcdb_get_media_schema_summary(int64 handle, const char* dbPath, _Out_ void** outJson)
int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)
int32 wcdb_get_emoticon_cdn_url(int64 handle, const char* dbPath, const char* md5, _Out_ void** outUrl)
int32 wcdb_get_emoticon_caption(int64 handle, const char* dbPath, const char* md5, _Out_ void** outCaption)
int32 wcdb_get_emoticon_caption_strict(int64 handle, const char* md5, _Out_ void** outCaption)
int32 wcdb_get_voice_data(int64 handle, const char* sessionId, int32 createTime, int32 localId, int64 svrId, const char* candidatesJson, _Out_ void** outHex)
int32 wcdb_get_voice_data_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)
int32 wcdb_resolve_image_hardlink(int64 handle, const char* md5, const char* accountDir, _Out_ void** outJson)
int32 wcdb_resolve_image_hardlink_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)
int32 wcdb_resolve_video_hardlink_md5(int64 handle, const char* md5, const char* dbPath, _Out_ void** outJson)
int32 wcdb_resolve_video_hardlink_md5_batch(int64 handle, const char* requestsJson, _Out_ void** outJson)
int32 wcdb_scan_media_stream(int64 handle, const char* sessionIdsJson, int32 mediaType, int32 beginTimestamp, int32 endTimestamp, int32 limit, int32 offset, _Out_ void** outJson, _Out_ int32* outHasMore)
int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)
int32 wcdb_get_sns_annual_stats(int64 handle, int32 begin, int32 end, _Out_ void** outJson)
int32 wcdb_get_sns_usernames(int64 handle, _Out_ void** outJson)
int32 wcdb_get_sns_export_stats(int64 handle, const char* myAccountId, _Out_ void** outJson)
int32 wcdb_check_sns_block_delete_trigger(int64 handle, _Out_ int32* outInstalled)
int32 wcdb_install_sns_block_delete_trigger(int64 handle, _Out_ void** outError)
int32 wcdb_uninstall_sns_block_delete_trigger(int64 handle, _Out_ void** outError)
int32 wcdb_delete_sns_post(int64 handle, const char* postId, _Out_ void** outError)
int32 wcdb_start_monitor_pipe()
void  wcdb_stop_monitor_pipe()
int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)
int32 wcdb_get_db_status(int64 handle, _Out_ void** outJson)
int32 wcdb_get_logs(_Out_ void** outJson)
int32 wcdb_cloud_init(int32 intervalSeconds)
int32 wcdb_cloud_report(const char* statsJson)
void  wcdb_cloud_stop()
void  VerifyUser(int64 hwnd, const char* message, _Out_ char* outResult, int maxLen)
```

`wcdb_open_account` 之外全部可选：缺失的符号对应功能会在应用里表现为"不可用"，不影响
其他已实现的功能。JSON 载荷/出参的字段命名可参照 `electron/services/wcdbCore.ts` 里
每个函数调用点前后对返回值的解析逻辑。

## 2. 媒体解密插件（`imageNativeAddonPath`）

一个 Node 原生插件（`.node`，通过 `require()` 加载），对应 `electron/services/nativeImageDecrypt.ts`
里的 `NativeAddon` 接口：

```ts
{
  decryptDatNative(inputPath: string, xorKey: number, aesKey?: string): {
    data: Buffer
    ext: string          // 如 'jpg'/'png'/'mp4'，不含点号也可
    isWxgf?: boolean      // 是否为 WXGF 容器格式，是则会再走一层 unwrap
    version?: number
    aesSize?: number
    xorSize?: number
    rawSize?: number
    flag?: number
  }
  // 可选：编辑/重新加密场景使用
  encryptDatNative?(inputPath: string, xorKey: number, aesKey?: string, meta?: object): Buffer
}
```

参照原始 `Wedecrypt/` Rust 工程（`napi`/`napi-derive` + `cdylib`）实现即可复用其思路。

## 3. WeLive 批量导出引擎（`welivePath`）

一个可执行文件，由 `electron/services/weliveBridge.ts` 的 `runWeliveExport()` 拉起，
用于会话的批量原始导出（文本 + 媒体）。协议：

- 请求：完整的 `WeliveExportRequest`（见 `weliveBridge.ts` 内类型定义，包含账号信息、
  `sessionIds`、输出目录、媒体类型等）序列化为 JSON，写入子进程 stdin 后关闭。
- 响应：子进程通过 stdout 按行输出 `WeliveExportEvent` 的 NDJSON（`ready`/`progress`/
  `created_file`/`created_dir`/`session_error`/`result` 等类型），最终以一条 `result` 事件
  （含 `success`/`success_count`/`fail_count`/`session_output_paths`/`raw_export_manifests`
  等字段）结束。进程以退出码 `0` 且最后一条事件为 `result` 且 `success !== false` 视为成功。
- 支持通过关闭 stdin/发送信号来响应取消（`AbortSignal`），进程应能在收到终止信号后尽快退出。
