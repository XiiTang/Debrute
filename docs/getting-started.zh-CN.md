# 快速开始

本指南覆盖一次完整的 Debrute 工作流：打开真实 Project，让外部 Agent 使用它已有的工具工作，在 Canvas 上查看多种文件，留下结构化 Feedback，再让 Agent 根据这些 Feedback 继续推进。

## 启动开发 Workbench

源码开发目前支持 macOS 和 Windows，并需要通过 `pnpm doctor` 检查的仓库工具链。

```sh
git clone https://github.com/XiiTang/Debrute.git
cd Debrute
pnpm install
pnpm doctor
pnpm dev
```

`pnpm dev` 会启动或复用本地 Rust Runtime，启动 Web 开发前端，并打印准确的 Workbench URL，但不会自动打开浏览器。请在你希望使用的浏览器中打开该地址。

需要通过 Electron Desktop host 开发时，改用 `pnpm dev:electron`。

## 打开真实项目

选择**打开项目**并选取一个现有文件夹。这个文件夹就是 Project 的事实来源；Debrute 不会把其中内容复制到另一个工作区。

每个普通文件和目录都属于 Canvas。展开或折叠 Project 文件夹以控制当前可见的后代，再把相关文件排列在一起进行比较。

## 让 Agent 正常工作

在你已经使用的 Agent harness 中打开同一个文件夹。Agent 可以使用它已有的文件、终端、浏览器、生成与编辑工具创建、修改、移动或删除文件。打开的 Project 下发生的变化会反映到 Project Tree 和 Canvas。

例如：

> 根据这份需求在 `concepts/` 下创建三个视觉方向，把提示词和简短设计理由放在每个结果旁边。

Debrute Model Requests 和官方 Skills 是可选能力。在它们的图片、视频、音频、来源记录或 Project 语义有帮助时使用即可；其他工具创建的文件仍然是普通 Project 文件，并会以同样方式出现在 Canvas 上。

## 在 Canvas 上查看项目

使用 Canvas 让来源上下文与输出结果保持在一起：

- 同时比较大量图片候选；
- 预览和播放视频，并保留选定的播放位置；
- 在提示词、说明或相关媒体旁直接播放音频；
- 预览和编辑需求、提示词、Markdown、结构化数据、配置、日志、代码、脚本、补丁、表格、字幕及其他已注册文本格式；
- 让陌生格式或不能丰富预览的普通文件继续作为 Project 结构的一部分保持可见。

对于后缀陌生、但属于普通文件、有效 UTF-8 文本且不包含二进制 NUL 的内容，文本编辑器仍然可以打开；Canvas 的丰富自动文本分类仍然以格式注册表为准。

Canvas 渲染系统使用空间索引、视口裁剪、增量 DOM 呈现和感知交互状态的预览调度来处理大型工作集。准确技术契约见 [Canvas 渲染](./canvas-rendering.md)。

## 留下结构化 Feedback

使用 Feedback Marks 对整个文件分类，或通过评论记录选择背后的原因。图片支持编号点位和区域，视频支持精确时刻上的评论、点位和区域。

已经接受的 Feedback 保存在：

```text
.debrute/feedback/feedback.json
```

外部 Agent 可以使用普通文件工具读取该文档。用户明确要求时，Agent 也可以在保留有效 Feedback Schema、避免与其他写入者竞争的前提下修改它。`.debrute/feedback/artifacts/` 下的文件是 Runtime 派生的视觉辅助产物，Agent 不应编辑。

可以尝试以下工作流：

1. 把多个图片输出标记为**喜欢**。
2. 为仍需局部修正的输出添加区域评论。
3. 告诉 Agent：

   > 查看项目 Feedback。把所有标记为“喜欢”的图片合成一张九宫格，再分别根据区域评论生成修改版本。保留原文件。

4. 新文件出现在 Canvas 后继续查看。

Feedback 是当前审阅状态，不是工作流历史或审批系统。除非用户明确要求，否则 Agent 不应清除或重写用户的主观 Feedback。

## 继续在 Photoshop 中工作

仓库包含一个 Photoshop UXP 插件。它通过 Runtime 管理的集成传输 Project 资产，同时保留真实 Project 文件和路径身份。支持格式、安装方式与准确行为见 [Photoshop 文件传输](./photoshop.md)。

## 深入了解

- [产品模型](./product-model.md)
- [Canvas 架构](./canvas.md)
- [Canvas 媒体呈现](./canvas-media.md)
- [文本文件与 Canvas 预览](./text-files.md)
- [Canvas Feedback](./canvas-feedback.md)
- [CLI 与官方 Skills](./cli.md)
- [开发](./development.md)
