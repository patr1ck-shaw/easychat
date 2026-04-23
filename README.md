# EasyChat

轻量聊天 UI + Node.js 代理服务（默认端口 `7777`）。

## 功能

- 多模型预设（在线管理）
- 流式回复
- 粘贴截图（Ctrl+V）直接识图
- 一键文生图（🎨 按钮）
- 服务端保存 API Key（前端不直连模型厂商）

## Docker 运行

### 1) 启动

```bash
docker run -d \
  --name easychat \
  -p 7777:7777 \
  -e EASYCHAT_ADMIN_PASSWORD=change-this-password \
  -e CONFIG_PATH=/data/presets.json \
  -e LOG_PATH=/data/easychat.log \
  -e UPLOAD_DIR=/data/uploads \
  -e SESSIONS_PATH=/data/sessions.json \
  -e PUBLIC_BASE_URL=https://你的域名 \
  -v easychat-data:/data \
  --restart unless-stopped \
  ghcr.io/patr1ck-74/easychat:latest
```

说明：

- `CONFIG_PATH=/data/presets.json`：配置持久化到 volume
- `LOG_PATH=/data/easychat.log`：服务端日志持久化到 volume
- `UPLOAD_DIR=/data/uploads`：用户上传图片持久化到 volume
- `SESSIONS_PATH=/data/sessions.json`：会话历史持久化到 volume（刷新/重建容器后可恢复）
- `PUBLIC_BASE_URL`：用于图片识图场景生成可访问的绝对地址（建议配置）

### 2) 更新

```bash
docker pull ghcr.io/patr1ck-74/easychat:latest
docker stop easychat
docker rm easychat
# 然后用上面的 docker run 原命令重新启动
```

### 3) 查看日志

```bash
docker logs -f easychat

# 若需要看持久化日志文件（容器内）
docker exec -it easychat sh -c 'tail -f /data/easychat.log'
```

## 首次使用

1. 打开页面：`http://你的服务器IP:7777`
2. 点击齿轮，输入 `Admin Password`
3. 加载配置并填写 `Base URL / Model / API Key`
4. 保存后测试连通性
5. 之后聊天、出图、截图上传都需要该管理密码（仅管理员可用）

### 访问控制（方案 A：仅管理员可用）

- 以下接口已强制管理员鉴权（请求头必须带 `x-admin-password`）：
  - `/api/config`
  - `/api/test`
  - `/api/upload-image`
  - `/api/chat`
  - `/api/image-generate`
  - `/api/admin/config`
- 若服务端未设置 `EASYCHAT_ADMIN_PASSWORD`，上述能力会返回 `503`。
- 若密码错误，会返回 `401`。

### 出图配置说明

- 在管理面板的每个 Preset 中可配置：
  - `model`：聊天模型（走 `/chat/completions`）
  - `imageModel`：出图模型（走 `/images/generations`，如 `gpt-image-1`）
- 聊天输入框右侧点击 `🎨` 可触发出图；点击发送按钮仍是普通对话。

## 本地开发（可选）

```powershell
cd D:\github\easychat\server
npm install
$env:EASYCHAT_ADMIN_PASSWORD="change-this-password"
node server.js
```

## 注意

- `server/presets.json` 不要提交到仓库
- 对话历史会同时保存在浏览器本地与服务端 `SESSIONS_PATH`（默认 `server/sessions.json`）
- 容器重建不会影响 `/data/presets.json`、`/data/easychat.log`、`/data/uploads`、`/data/sessions.json`
