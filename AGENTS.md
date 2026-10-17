# AGENTS.md — 给 AI 助手的仓库须知

## 分发方式：仅 Git（Git-only）

- 本仓库是上游 [`Han-1413141/dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter) 的 fork（MIT；历史与署名见 `LICENSE`、`CHANGELOG.md` 与 `docs/release-notes/`），**仅通过 Git 分发**：安装一律使用固定完整提交（40 位 commit sha）的 Git 地址 `github:Subin-Gurung49/dsh-cost-meter#<full-commit-sha>`；不发布 npm 包，也不提交 DSH 插件市场（STORE）。
- 上游的一键安装脚本与发版脚本（`install.ps1`、`scripts/release.mjs`）已从本仓库移除；本仓库**不保存、不引用、不探测任何 npm / GitHub / 商店凭据或发布令牌**（环境变量、`.npmrc`、注册表均不在本仓库的自动化范围内）。

## 安全约定

- **绝对不要**把密钥、令牌、凭据或真实用户路径写入仓库文件、issue、PR、评论或命令输出——本仓库是公开的；
- 不要读取或检测环境中的凭据（`NPM_TOKEN`、`GH_TOKEN`、各家 provider API key 等）；构建与测试一律使用合成环境（见 `test/helpers/isolated-run.mjs` 与 `test/helpers/synthetic-env.mjs`）；
- 改分发/元数据时，除版本号与仓库地址类字段外，保持 `package.json` 的 `name`、`exports`、`bin`、`dsh`/`dshhub`、`files`、`dependencies`、`scripts`、`engines` 等字段不变；
- 安装文档中的 Git 地址示例必须固定到完整 40 位 commit sha，不使用浮动分支或短 sha。
