# Windows Rust 42 项忽略用例复核（2026-11-11）

**冻结候选 26.11.1101。** 提交 `725862793ac435f77d2e8d9fbb24b4df31e88f7c` 的原生测试程序 SHA-256 为 `649f0ac7d0535c1531bee42ceb29de864c73eb24c9210ebace26f4654155785c`。该程序的全量库测试为 1,216 项通过、0 失败、41 项环境忽略。同一程序对下表在候选中存在的 21 项已补测用例显式重跑，21 项通过、0 失败，耗时 263.53 秒。下表的 `group_materialization_bounds_work_in_a_large_current_folder` 只在审查工作区出现。其余 20 项保留环境验收边界，已逐条核对相邻验证在本候选通过。收据对象是原生测试程序，安装包和安装机另行登记。[候选逐项收据](../.tmp/release-gates-20261111/candidate-649F0AC7D053/candidate-ignored-evidence.json) · [候选专项日志](../.tmp/release-gates-20261111/candidate-649F0AC7D053/candidate-selected.log) · [候选全量日志](../.tmp/release-windows-26.11.1101/native-72586279/native-suite.log)。

原始 Windows 库测试为 1,224 项通过、42 项按环境忽略。逐项核对后，在同批归档测试程序（SHA-256 `da1ca082759eb07e88af45a1cde9c1cbc474341355a9ba6f1620356c340dc77e`）上显式运行通过其中 22 项。余下 20 项的替代记录仅覆盖表中列出的行为，完整硬件、第三方环境或真实账号测试仍待相应环境。新 Windows 安装包的验收以最终 NSIS 的 SHA-256 另行绑定。

首轮受沙箱限制，FFmpeg 与临时目录返回拒绝访问。复跑使用相同的归档测试程序、项目内临时用户与库目录及系统已安装的 FFmpeg。Codex 用例首次缺少原生启动器，在临时配置目录补齐同批启动器后通过。合成文件、库与逐次日志在 [本地验证目录](../.tmp/release-gates-20261111/)。原全量通过记录在 [suite.log](../.tmp/audit-native-9ba81c98-6a78-414f-840a-3d86292acee6/verified-fd1b9c25b391484da7b7a9fd0988481b/suite.log)。

| 原忽略用例 | 本次处置 | 证据或替代覆盖 |
|---|---|---|
| `live_existing_task_diagnostic` | 待 已有真实即梦任务及登录 | 已验证相邻行为 `log_scan_matches_exact_task_and_keeps_history_error_fields` |
| `installed_codex_windows_sandbox_writes_protocol_files_without_a_model` | 原用例通过 | [ignored-launcher.log](../.tmp/release-gates-20261111/ignored-launcher.log) |
| `local_dsh_authenticated_session_discovery` | 待 已有授权 DSH 会话和仓库上下文 | 已验证相邻行为 `dsh_login_cookie_authenticates_both_rpc_calls` |
| `hyperframes_chat_engine_checks_previews_renders_and_cancels` | 待 带浏览器缓存的固定渲染运行时、合成工程 | 已验证相邻行为 `video_tools_are_scoped_to_fixed_commands_and_artifacts` |
| `hyperframes_prepares_versioned_skills_and_wrapper` | 待 固定渲染运行时及浏览器缓存 | 已验证相邻行为 `video_engineering_identity_is_stable_and_scoped` |
| `hyperframes_rendered_video_is_ingested_once` | 原用例通过 | [ignored-fixtures.log](../.tmp/release-gates-20261111/ignored-fixtures.log) |
| `hyperframes_tool_bridge_renders_inside_codex_sandbox` | 待 固定渲染运行时、合成工程及 Codex 沙箱 | 已验证相邻行为 `installed_codex_windows_sandbox_writes_protocol_files_without_a_model` |
| `claude_tui_e2e` | 待 已登录 Claude 及真实终端、一次模型调用 | 已验证相邻行为 `rpc_requests_drain_and_respond_roundtrip` |
| `console_injection_probe` | 待 交互式 Windows 终端 | 已验证相邻行为 `key_records_map_cjk_and_return` |
| `canvas_preview_cold_cache_benchmark` | 原用例通过 | [ignored-safe.log](../.tmp/release-gates-20261111/ignored-safe.log) |
| `h3_discovery_local_desktop_read_only` | 待 具有完整 H3 模型的实际桌面注册信息 | 已验证相邻行为 `h3_discovery_desktop_shared_models_selected_parent_and_custom_port` |
| `h3_nvidia_live_driver_lookup` | 待 实时 NVIDIA 驱动目录 | 已验证相邻行为 `h3_gpu_driver_detection_and_exact_product_match` |
| `h3_setup_local_environment_read_only` | 待 真实 H3 安装与本地服务 | 已验证相邻行为 `h3_setup_run_prepares_installed_environment_without_implicit_download` |
| `h3_setup_modelscope_pinned_downloads_read_only` | 待 在线 ModelScope 各固定模型的分段下载 | 已验证相邻行为 `h3_setup_modelscope_preferred_fallback_resume_hash_and_cancel` |
| `h3_mock_upload_submit_recover_download_and_idempotent_import` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `native_adobe_export_smoke` | 待 授权 Illustrator 与隔离导出夹具 | 已验证相邻行为 `validates_destination_and_replaces_only_complete_files` |
| `dsh_managed_runtime_probe_uses_bundled_bridge_without_model_credentials` | 原用例通过 | [ignored-cli.log](../.tmp/release-gates-20261111/ignored-cli.log) |
| `local_chat_managed_cli_handshake_and_effective_config` | 原用例通过 | [ignored-cli.log](../.tmp/release-gates-20261111/ignored-cli.log) |
| `benchmark_capture_encoding` | 原用例通过 | [ignored-safe.log](../.tmp/release-gates-20261111/ignored-safe.log) |
| `real_hls_and_dash_preserve_video_audio_and_decode` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `audio_extract_preserves_source_retries_and_rejects_silent_video` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `real_caption_render_handles_silent_portrait_and_quoted_directory` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `real_scene_detection_prepares_contiguous_verified_clips` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `real_media_keeps_audio_and_builds_local_frames` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `trim_real_video_copy_overwrite_and_failure_preservation` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `real_runner_generates_and_publishes_in_temporary_library` | 待 隔离语音模型、Python 及 GPU 推理 | 已验证相邻行为 `durable_publish_is_idempotent_and_rolls_back_failed_import` |
| `real_managed_installation_verifies_python_and_cuda` | 待 隔离 Python/CUDA 环境及安装资源 | 已验证相邻行为 `download_resumes_checks_hash_and_keeps_partial_on_pause` |
| `audio_production_service_fixture_performance` | 原用例通过 | [ignored-fixtures.log](../.tmp/release-gates-20261111/ignored-fixtures.log) |
| `benchmark_300k_catalog` | 原用例通过 | [ignored-safe.log](../.tmp/release-gates-20261111/ignored-safe.log) |
| `benchmark_connected_preview_stages` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `reads_real_windows_shared_thumbnail_cache` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `external_video_reference_relink_and_join_keep_original` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `compare_small_folder_reads_with_large_other_roots` | 原用例通过 | [ignored-safe.log](../.tmp/release-gates-20261111/ignored-safe.log) |
| `group_materialization_bounds_work_in_a_large_current_folder` | 原用例通过 | [ignored-safe.log](../.tmp/release-gates-20261111/ignored-safe.log) |
| `generated_video_ingest_probes_short_clip_and_real_poster` | 原用例通过 | [ignored-media.log](../.tmp/release-gates-20261111/ignored-media.log) |
| `local_chat_cards_export_review_fixtures` | 原用例通过 | [ignored-fixtures.log](../.tmp/release-gates-20261111/ignored-fixtures.log) |
| `real_cpu_fallback` | 待 只有 CPU 执行器的固定模型目录 | 已验证相邻行为 `platform_packs_keep_windows_compatible_and_mac_architectures_separate` |
| `real_gpu_batch_matching` | 待 固定分类模型、CUDA 硬件及运行日志 | 已验证相邻行为 `device_probe_uses_only_enumerated_cuda_devices` |
| `real_model_download_uses_system_network_settings` | 待 隔离模型目录与完整联网下载 | 已验证相邻行为 `corrupt_download_is_never_promoted_to_installed_file` |
| `real_local_model_batch_persists_completed_assets` | 待 隔离本地分类模型与真实批处理 | 已验证相邻行为 `invalid_jev_or_cloud_never_commit_partial_results` |
| `real_local_model_smoke` | 待 固定本地模型环境 | 已验证相邻行为 `matching_grammar_binds_every_position_to_one_label` |
| `real_model_orders_labels_correctly` | 待 向量包和标注图 asset-007.png；未指定包时用例直接返回 | 已验证相邻行为 `decide_requires_threshold_and_respects_counter_evidence` |
