# GitHub 仓库发布信息

## 推荐仓库设置

- 仓库名称：`huiyi-jiyao`
- 可见性：Public
- 仓库简介：`跨平台本地会议录音与实时转写工具，支持说话人区分、AI 纪要、待办和本地搜索。`
- Topics：`electron`、`meeting-minutes`、`speech-to-text`、`whisper`、`sherpa-onnx`、`speaker-diarization`、`deepseek`、`macos`、`windows`
- 网站：暂时留空，等有项目主页后再填写

## 首次上传前

当前工作目录尚未初始化为 Git 仓库。创建 GitHub 远程仓库时，选择空仓库，不要让 GitHub 预先创建 README、许可证或 `.gitignore`，避免首次推送时产生无关合并冲突。

本项目的 ONNX 模型合计约 342 MB，其中 `encoder.int8.onnx` 单个文件超过 GitHub 普通 Git 单文件限制；`.gitattributes` 已将 `*.onnx` 配置为 Git LFS。首次 `git add` 前先安装 Git LFS 并运行：

```sh
git lfs install
git lfs track '*.onnx'
```

GitHub 网页上传不能替代此步骤；普通 Git 仓库会拒绝超过 100 MiB 的文件。Git LFS 能管理这些文件，但会增加仓库存储和下载流量。若不想使用 LFS，应先调整模型获取流程，再发布仓库。[GitHub 大文件限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

在发布前检查并排除：

- `.env`、API 密钥、个人令牌和私有证书；
- 个人录音、逐字稿和应用数据目录；
- `node_modules/`、`dist/`、`runtime/` 和 `work/`；
- 你没有权利公开的第三方内容。

本目录当前没有 Git 历史，因此无需迁移旧提交中的大文件。添加所有文件前，请检查 LFS 状态，确认 ONNX 文件被记录为 LFS 对象而不是直接 Git blob。

## 发布建议

1. 检查 README、许可证、第三方声明和模型来源。
2. 安装 Git LFS 后检查 `.onnx` 文件均由 LFS 跟踪。
3. 运行 README 中的测试与构建检查。
4. 首次推送后在 GitHub Actions 检查 macOS 和 Windows 构建结果。
5. 在 Windows 真机和 macOS Apple Silicon 上验证安装、录音、模型下载、AI 配置和卸载数据保留行为。
6. 确认许可证权利人、模型和 FFmpeg 的分发义务后，再创建正式 Release。

## 许可证提示

根目录 `LICENSE` 采用 MIT 模板，当前版权行写为 `Huiyi Jiyao contributors`。请在公开前确认代码的版权归属，并按实际权利人修改版权行。该文件仅适用于本项目自有代码；第三方依赖、模型、图标、FFmpeg 和 Electron 组件仍受各自许可证约束。这里不是法律意见，公开发行二进制前应核对全部第三方许可。
