# ”数学“公式与“Markdown”公式输入增强

DSH 输入框支持 Markdown 样式预览和数学公式排版。原始文本保留为可编辑内容。

[npm 1.0.0 页面](https://www.npmjs.com/package/dsh-live-markdown-math/v/1.0.0) · [npm 安装包](https://registry.npmjs.org/dsh-live-markdown-math/-/dsh-live-markdown-math-1.0.0.tgz) · [GitHub 仓库](https://github.com/lyufeng000/dsh-live-markdown-math)

## 安装

在 DSH 中打开「插件管理器」，选择「添加插件」。

输入下面的包名并安装：

```text
dsh-live-markdown-math@1.0.0
```

此版本支持 DSH `>=0.2.1-rc.2 <0.3.0`。安装不需要本地构建或单独安装依赖。

## 功能

### Markdown

标题、粗体、斜体、删除线、引用、行内代码、代码块和列表会显示格式预览。光标进入标记时，编辑器显示对应源码。

任务列表、表格、链接和图片保留为可编辑文本。插件不把 Markdown 转成发送用 HTML，也不加载 Markdown 图片。

### 数学公式

支持 `$…$`、`$$…$$`、`\(…\)` 和 `\[…\]`。公式闭合且光标离开后，输入框显示排版预览。点击公式可以回到原生公式源码编辑。

数学公式渲染使用随包提供的 KaTeX。插件也会为符合结构的已发送用户消息渲染公式。

## 兼容范围与限制

<details>
<summary>宿主兼容</summary>

插件适配 DSH 原生编辑器，并使用宿主提供的 React。运行时检查不匹配时，插件会停止增强并保留原生输入。

插件依赖 DSH 私有编辑器接口。升级 DSH 后，请重新检查插件兼容性。

</details>

<details>
<summary>公式范围</summary>

多行公式、跨原生文本节点的公式和跨引用内容的公式保留源码，不显示公式排版。

公式长度、文档长度和公式数量有上限。超过上限时，插件保留原生输入。

</details>

<details>
<summary>Markdown 范围</summary>

插件提供编辑期样式预览，不是完整的富文本编辑器。列表、任务列表和表格不提供交互控件，链接不提供跳转行为。

</details>

## 维护与检查

开发环境需要 Node.js `>=22`。在仓库目录安装锁定的开发依赖：

```sh
npm ci --ignore-scripts
```

原生回归需要一个通过 `test/native-runtime.mjs` 摘要审查的 DSH 运行时副本。将路径赋给 `DSH_NATIVE_RUNTIME` 后运行检查：

```sh
DSH_NATIVE_RUNTIME='/absolute/path/to/reviewed/client.js' npm run check
```

如需运行独立 Chrome 检查：

```sh
DSH_NATIVE_RUNTIME='/absolute/path/to/reviewed/client.js' npm run check:browser
```

生成发布候选包时，命令会在系统临时目录构建，并保留仓库中的 `lib/`：

```sh
DSH_NATIVE_RUNTIME='/absolute/path/to/reviewed/client.js' npm run pack:release -- --browser
```

脚本会生成当前版本的 `.tgz` 文件，并检查候选包内容。源码目录禁止直接运行 `npm publish`。发布时请使用检查通过的归档文件。

## 许可证

插件使用 MIT 许可证。第三方组件的许可信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
