# 飞牛文件资源管理器 (FN File Manager)

飞牛 NAS 专属的轻量级 Web 文件资源管理器，深色扁平设计，支持多存储卷管理与在线预览。

## ✨ 功能特性

- **列表 / 网格双视图** — 一键切换，网格视图适配图片/视频浏览
- **彩色文件类型图标** — 图片、视频、音频、文档、压缩包、代码各有专属配色
- **在线预览** — 图片、视频、音频、PDF、文本文件直接预览
- **拖拽上传** — 拖文件/文件夹到窗口直接上传，支持多文件并发
- **文件夹打包下载** — 一键将整个目录打包为 zip 下载
- **搜索** — 递归搜索当前目录
- **多存储卷** — 自动识别挂载的存储空间，实时显示容量
- **移动端适配** — 响应式布局，手机浏览器可用

## 🛠️ 技术栈

- 后端：Node.js（零第三方运行时依赖，仅 `archiver` 用于 zip 打包）
- 前端：原生 HTML / CSS / JavaScript，无框架

## 🚀 快速开始

### Docker 部署

```bash
docker run -d \
  --name fn-file-manager \
  --restart always \
  -p 8888:8888 \
  -e PORT=8888 \
  -e PASSWORD=your-password \
  -e ROOT=/data \
  -v /path/to/storage:/data/storage \
  fn-file-manager:latest
```

> 访问 `http://<服务器IP>:8888`，密码为 `PASSWORD` 环境变量设置的值。

### 本地构建

```bash
docker build -t fn-file-manager:latest .
```

### 直接运行（开发）

```bash
npm install
PASSWORD=your-password PORT=8888 ROOT=/data node server.js
```

## ⚙️ 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `8888` |
| `PASSWORD` | 访问密码 | `changeme`（务必修改） |
| `ROOT` | 数据根目录 | `/data` |

## 🔒 安全说明

- 请务必通过 `PASSWORD` 环境变量设置强密码，不要使用默认值
- 建议部署在反向代理（如 Caddy / Nginx）后并启用 HTTPS
- 访问密码通过 SHA-256 派生出无状态 token，服务重启后登录态仍有效

## 📄 License

MIT
