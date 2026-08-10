<p align="center">
  <img src="./assets/brand/debrute-mascot.svg" width="128" alt="Debrute 完整吉祥物">
</p>

<h1 align="center">Debrute</h1>

<p align="center"><a href="./README.md">English</a></p>

Debrute 是一个面向你和 AI Agent 的项目级本地视觉工作台。

打开真实项目文件夹，在一个流畅的 Canvas 上同时查看图片、视频、音频和文本。排列和比较大量项目文件，在上下文中编辑文字、留下精确 Feedback，再让 Agent 使用它已有的任何工具继续工作。

## 看见整个项目

一个 Debrute Project 就是一个现有的本地文件夹。文件仍然是普通文件，文件夹层级会成为 Canvas 层级；无论改动来自 Agent、脚本、创意软件还是用户，都会出现在同一个项目视图中。

每个普通文件和目录都属于 Canvas。支持的媒体与文本格式会获得丰富的预览和控件；其他文件也会继续作为项目上下文的一部分保持可见。

## 在项目规模下流畅工作

在 Canvas 上同时铺开参考资料、提示词、草稿、候选方案和最终资产。在项目整体形状与单个细节之间快速切换，不必逐个打开文件。

Canvas 渲染系统面向大型工作集设计。空间索引、视口裁剪、增量呈现更新和感知交互状态的预览调度，使平移、缩放、排列与比较在项目不断增长时仍然保持响应。

## 让各种项目上下文同时可见

- **图片**：查看和比较常见的位图与矢量格式。
- **视频**：预览、播放、跳转，并将选定画面保留在 Canvas 上。
- **音频**：在相关项目文件旁直接播放音频。
- **文本**：预览和编辑需求、提示词、Markdown、结构化数据、配置、日志、代码、脚本、补丁、表格、字幕及其他面向文档的文本格式。

文字会留在它所描述的视觉工作旁边。Debrute 支持内联与浮动编辑、语言感知呈现、大型文本文件、自动换行，以及受管理的拉丁文字与中日韩字体。

## 留下 Agent 可以使用的 Feedback

标记整个文件、添加评论、指出精确图片区域，并批注精确视频时刻。Feedback 会作为结构化、可直接理解的数据留在 Project 中，外部 Agent 可以使用普通文件工具读取。

例如，在 Canvas 上把多个结果标记为**喜欢**，然后告诉 Agent：

> 查看项目 Feedback，把所有标记为“喜欢”的图片合成一张九宫格。

Agent 可以读取对应的 Project 路径，使用它已有的任何图像工具，并把新结果保存回同一个文件夹以便立即查看。

## 使用你自己的 Agent 和工具

Agent 使用自己已有的文件、终端、浏览器、生成和编辑工具完成普通 Project 工作。Debrute 不依赖某一款特定的 Agent harness。

随产品提供的 `debrute` CLI 和官方 Skills 是可选能力，用于补充 Project 语义、图片、视频和音频 Model Requests、Workbench 访问与生成文件来源记录。其他工具创建的文件也会以同样方式出现在 Canvas 上。

## 继续使用专业工具完成工作

Debrute 位于完成工作所需的专业工具旁边。随项目提供的 Photoshop UXP 和 CEP 插件可以在 Debrute 与 Photoshop 之间移动 Project 资产，同时保留同一份文件和 Project 身份。

## 开发版本快速开始

Debrute 源码开发目前支持 macOS 和 Windows。在已经检出的仓库中运行：

```sh
pnpm install
pnpm doctor
pnpm dev
```

`pnpm dev` 会启动或复用本地 Runtime，并打印准确的 Workbench URL。打开该地址，选择**打开项目**，然后选择一个现有文件夹。

完整的首次 Agent 与 Feedback 工作流见[快速开始](./docs/getting-started.zh-CN.md)。打包产品和发布细节见[发布](./docs/releases.md)。

## 文档

- [快速开始](./docs/getting-started.zh-CN.md)
- [技术文档索引](./docs/README.md)
- [产品模型](./docs/product-model.md)
- [Canvas 渲染](./docs/canvas-rendering.md)
- [Canvas Feedback](./docs/canvas-feedback.md)
- [开发](./docs/development.md)

## License

Debrute 使用 Apache License, Version 2.0 授权。详见 [LICENSE](./LICENSE)。
