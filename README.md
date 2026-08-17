# DSH GitHub Publisher

一个可安装到 DeepSeek Harness 的 GitHub 仓库管理与“一键代发布”插件。

## 能做什么

插件包含一个 Web 发布入口：重启 `dsh web` 后，左侧栏底部显示 **“🚀 GitHub 发布”**。点击后可以填写项目目录、仓库名、可见性、版本和 Release 说明，先预检，再明确确认发布。

插件也可以通过用户 Agent Preset 向模型提供 6 个工具：

- `github_status`：检查 `git`、GitHub CLI (`gh`) 和当前登录账号。
- `github_repo_list`：只读列出当前账号可见的仓库。
- `github_publish_preview`：对一键发布做只读预检。
- `github_publish_confirm`：确认后初始化/提交 Git 项目、创建或连接仓库、推送、设置可见性并创建 GitHub Release。
- `github_release_preview`：预检单独创建 Release。
- `github_release_confirm`：确认后创建 Release。

“一键代发布”采用两步安全流程：预检返回一次性令牌和精确确认短语，确认工具才执行外部写入。令牌默认 10 分钟过期且只能使用一次。

## 安全边界

- 插件参数不接受 GitHub Token，也不读取或保存 Token；认证完全交给 GitHub CLI 的凭据存储。
- 所有 `git`/`gh` 调用都使用参数数组，不经过 shell 字符串拼接。
- 发布前扫描项目，发现 `.env`、SSH 私钥、`.pem`/`.key`、云凭据等敏感路径会直接阻止。
- `node_modules`、`.git`、构建输出和缓存目录不参与扫描/发布文件指纹。
- 执行前会重新扫描；文件清单改变后旧预检作废。
- 已有 `origin` 指向其他 GitHub 仓库时拒绝替换。
- 发布确认短语绑定仓库、可见性和版本标签，例如 `PUBLISH alice/demo public v1.0.0`。
- 插件会真实地执行 `git add -A` 和 `git commit`。请先检查项目的 `.gitignore`，并只对你有权发布的内容执行确认。

> 路径扫描是防误操作护栏，不是完整的秘密扫描器。它不能识别任意源代码中的硬编码密钥；发布者仍需负责最终内容审查。

## 前置条件

1. Node.js 22 或更高版本（DSH 自带运行时可满足）。
2. `git` 在 DSH 进程的 `PATH` 中。
3. 安装 [GitHub CLI](https://cli.github.com/) 并在终端完成登录：

   ```powershell
   gh auth login
   gh auth status
   ```

   创建公开仓库和 Release 通常需要 GitHub CLI 登录令牌具备对应仓库权限。

## 安装到 DSH Web Profile

DSH Web 把模型工具放在 **Agent Preset** 中，而 `subprocess`、安全策略等共享能力在 Host 中。因此安装分两步：安装 bundle，再将工具行加入一个**用户复制的** preset。不要编辑安装目录里的 shipped `standard` preset。

### 1. 安装 bundle

从 GitHub 安装：

```powershell
dsh plugin --profile web add github:zjj206/dsh-github-publisher
```

从本地源码安装时，在本插件目录的父级执行（Windows PowerShell）：

```powershell
# 需要 pnpm 可用；dsh plugin 会把相对路径锚定到当前目录
dsh plugin --profile web add .\dsh-github-publisher
```

Windows 上若绝对路径含空格且 CLI 将参数拆分，可创建一个不含空格的目录联接，再从该联接安装。

### 2. 创建自己的 preset 并添加工具行

在 DSH Web 中复制 `standard` 为一个用户 preset（例如 `github-publisher`）。然后将本包的 [`preset/github-publisher.row.yml`](preset/github-publisher.row.yml) 中完整行追加到该副本的 `agent.cordis.yml` 末尾。

这行只消费 Host 提供的 `tools` 和 `subprocess` 服务，因此**不要**将它包进 `isolate` group。最后在 Web 的 Agent Preset 选择器切换到该副本，并开始一个新会话。

安装 bundle 后需重启 `dsh web`；preset 改动通过 preset 的实际加载路径生效。Web 入口由插件自带的 Client bundle 提供，不需要修改 DSH Web 源码。

若当前 DSH 安装的 `pnpm` 临时路径损坏，可先安装/修复 pnpm，再重新运行安装命令。不要手工编辑 profile 的 `package.json` 或 bundle 列表。

## 使用示例

对模型说：

> 检查 GitHub 登录状态，然后预检把当前项目发布到我的 `demo-project` 公开仓库，标签为 `v1.0.0`，Release 标题为“首次发布”。

模型应先调用 `github_publish_preview` 并向你展示：

- 解析后的本地路径；
- 目标 `owner/repository`；
- 文件数量、分支、公开/私有状态和标签；
- 一次性预检令牌；
- 精确确认短语。

只有在你明确同意该摘要后，才把令牌和原样确认短语交给 `github_publish_confirm`。

## 配置

`cordis.patch.yml` 中包含安全默认值：

```yaml
config:
  defaultVisibility: public
  previewTtlSeconds: 600
  commandTimeoutMs: 120000
  maxOutputBytes: 262144
  maxScanFiles: 20000
```

如需覆盖，请在 profile 自己的后置 patch 层中重述该行的完整 `config`；Cordis patch 对行配置是整体替换，不是深合并。

## 本地验证与打包

```powershell
npm test
npm run check
npm pack --dry-run
```

DSH 插件开发技能提供的只读 bundle 预检：

```powershell
node <dsh-plugin-development-skill>\scripts\check-artifact.mjs bundle .\dsh-github-publisher
```

真实发布到 GitHub 是外部写入，不属于自动测试；应使用你拥有的临时仓库，在阅读预检摘要后手动确认。

## 卸载

```powershell
dsh plugin --profile web remove dsh-github-publisher
```

然后重启 `dsh web`。
