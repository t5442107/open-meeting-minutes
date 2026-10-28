# 第三方组件与许可证

本项目使用下列开源组件。随具体组件分发的许可证文本和版权声明也适用。

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [OpenAI Whisper](https://github.com/openai/whisper) | 本地语音识别 | MIT |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 本地语音处理与说话人区分 | Apache-2.0 |
| [opencc-python-reimplemented](https://github.com/yichen0831/opencc-python) | 本地转写简繁转换 | Apache-2.0；上游 OpenCC 字典与配置声明见 `licenses/OPENCC-PYTHON-NOTICE.txt` |
| [opencc-js](https://github.com/nk2028/opencc-js) | 本地 AI 纪要简繁转换 | MIT（代码）和 Apache-2.0（内置 opencc-data 字典）；第三方声明与许可证见 `licenses/OPENCC-JS-THIRD-PARTY-LICENSES.md` |
| [uv](https://github.com/astral-sh/uv) | 安装包中的 Python 运行环境与依赖管理 | MIT 或 Apache-2.0，双许可证；wheel 的许可证文本随 runtime 保留 |
| [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) | FFmpeg 二进制的 wheel 分发 | BSD-2-Clause；随 runtime 保留 wheel 许可证 |
| [FFmpeg](https://ffmpeg.org/) | 音频解码与处理 | GPL，取决于具体构建；随 runtime 提供 `ffmpeg -L` 输出 |
| [Electron](https://github.com/electron/electron) | 桌面应用运行时 | MIT（其依赖另有各自许可证） |

FFmpeg 不是 imageio-ffmpeg Python 封装的许可证所覆盖的同一组件；`imageio-ffmpeg` wheel 中包含的 FFmpeg 二进制适用其自身许可证。macOS arm64 的当前二进制执行 `ffmpeg -L` 已确认未启用 `--enable-nonfree`，并显示 GPLv2 或更高版本声明以及构建配置。Windows x64 二进制从同一 PyPI 项目的 Windows wheel 提取；本机无法执行 Windows PE 文件，资源准备脚本会检查其中是否含显式 `--enable-nonfree` 标记，Windows 原生运行时应继续核验 `ffmpeg -L` 输出。

运行时目录会保留 `FFMPEG-LICENSE.txt`、wheel 自带 BSD 许可证和 wheel 元数据。上游 FFmpeg 法律说明见 [FFmpeg Legal](https://ffmpeg.org/legal.html)。

本项目参考了 Meet2Notes 和 MeetingBro 的开源项目架构思路；没有复制其源代码，也不构成代码合并。项目地址：[Meet2Notes](https://github.com/estebanstifli/Meet2Notes)、[MeetingBro](https://github.com/armpro24-blip/MeetingBro)。

随包模型：pyannote segmentation-3.0 ONNX（MIT）、3D-Speaker ERes2Net base（Apache-2.0）、中英双语流式 Paraformer（Apache-2.0）及 CT-Transformer 中英标点模型（Apache-2.0）。来源与 SHA-256 见 backend/models/SOURCES.json。

FFmpeg二进制来源与构建说明：https://github.com/imageio/imageio-binaries/tree/master/ffmpeg 。FFmpeg 7.1上游源码：https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz 。本程序通过独立子进程使用FFmpeg，不静态链接FFmpeg库。完整GPL文本见licenses目录。
