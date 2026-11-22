# dsh-plugin-todo

一个 DeepSeek Harness 的待办插件：侧栏「任务」旁边多一格入口，点开是**待办清单 + 日历 + 常驻 AI 助手**。

粘贴一张会议截图，它会拆成带日期、标签、优先级的草案；缺的字段标出来，你补完再一键落库。

## 安装

在 DSH 里：**Plugins → Add plugin → 选择本地目录 `bundle/`**。

或命令行：

```sh
dsh plugin install ./bundle
```

安装后侧栏会出现「待办」图标（排在「任务」之后）。

## 特性

- **列表视图**：逾期 / 今天 / 本周 / 以后 / 未排期 分组，标签筛选，乐观更新 + 5 秒撤销
- **日历视图**：7×6 网格，农历日、二十四节气、传统节日；滚轮翻月、年月选择器、本月回跳
- **AI 助手**：截图或一句话 → 待办草案 → 补全 → 落库；顺带给时间安排和状态建议
- **零配置模型**：默认跟随 DSH 的默认模型，不需要任何 API Key；也可以单独选模型并持久保存

## 数据与隐私

- 待办、对话、设置全部存在 DSH 的存储域里（`ctx.storageDomain`），不写工作区文件
- 插件代码里**不含任何密钥**
- 只有你要识别的内容会发给模型，不经过任何第三方中转

## 结构

```
bundle/
├─ index.js          Host 半：存储域 + HTTP 路由（Node 原生 handler）+ SSE
├─ client.js         Client 半：**构建产物**（单文件，esbuild 打包压缩）
├─ src/
│  ├─ index.js       Client 源码：组件、状态、交互
│  └─ styles.css     Client 样式（独立文件，构建时内联成字符串）
├─ lib/
│  ├─ domain.js      todo / settings / conversation / events 四张表
│  ├─ channel.js     路由封装：JSON、SSE、同源校验
│  ├─ calendar.js    农历查表 + 节气天文算法 + 节日映射
│  └─ chat.js        助手人格、上下文拼装、结构化块解析
├─ data/lunar-table.json   1900–2100 农历表（4 KB）
└─ docs/DETAIL.md    插件详情页
```

**为什么 client 要构建**：DSH 的 client 半只有一个产物文件（`__ModuleLoader__.load({factory})`，
工厂里的 `require` 只解析浏览器模块表，加载不到同目录其它文件）。所以源码拆开写，构建成单文件。

## 开发

```sh
cd bundle && pnpm i && pnpm build     # 源码 → client.js
cd tools/lunar-gen && node gen.mjs    # 重新生成并自校验农历表

# 本地预览面板（假数据，渲染同一份 bundle/client.js）
# 直接双击 design/harness/index.html
```

## 已知限制

- 农历覆盖 1900–2100
- 法定节假日与调休目前不标注（需要一个按年维护的数据文件）
- 不做医疗诊断；涉及健康问题只建议寻求专业帮助

## License

MIT。农历表由 [lunar-javascript](https://github.com/6tail/lunar-javascript)（MIT）生成并逐日校验。
