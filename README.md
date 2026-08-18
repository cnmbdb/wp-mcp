# WordPress MCP Server

一个面向 Cursor、ChatGPT、Codex、Claude 等 MCP 客户端的 WordPress 内容管理服务。它直接调用 WordPress 原生 REST API，不要求在 WordPress 内安装本项目的插件。

## 核心能力

- 零 WordPress 插件：默认使用 WordPress 5.6+ 原生 Application Password。
- Docker 一键部署：`./deploy.sh` 或 `docker compose up -d --build`。
- 双传输：远程 Streamable HTTP（`/mcp`）和本地 stdio。
- 内容管理：文章、页面、自定义 REST 内容类型、分类、标签、媒体、评论。
- AI 检索兼容：实现标准 `search` / `fetch` 工具，返回可引用的 WordPress 永久链接。
- 安全默认值：新内容默认草稿；文章、媒体、评论默认软删除；内容类型有显式白名单。
- 两种 WordPress 鉴权：Application Password 与已有 JWT Bearer Token。

## 重要的鉴权边界

“零插件”和“JWT”需要区分清楚：

- `application_password` 是推荐默认值。它从 WordPress 5.6 起属于核心功能，不需要额外插件。
- WordPress Core 本身不签发通用 REST JWT。`jwt` 模式只用于你的站点已经通过现有插件、反向代理或身份网关接受 JWT 的情况。本项目不会要求你额外安装插件，但也不会伪装成 WordPress 原生 JWT。
- `MCP_API_KEY` 保护的是 AI 客户端到本 MCP 服务的连接；`WP_*` 凭据保护的是 MCP 服务到 WordPress 的连接，两者互相独立。

## 工具

| 工具 | 作用 | 风险属性 |
|---|---|---|
| `search` / `fetch` | 标准检索与完整内容读取 | 只读 |
| `wp_site_info` | 检查站点及 REST 能力 | 只读 |
| `wp_list_content` / `wp_get_content` | 读取文章、页面或白名单中的自定义类型 | 只读 |
| `wp_create_content` / `wp_update_content` | 创建、修改内容 | 写入 |
| `wp_delete_content` | 回收或永久删除内容 | 破坏性 |
| `wp_list_terms` / `wp_create_term` / `wp_update_term` / `wp_delete_term` | 管理分类和标签 | 读写 |
| `wp_list_media` / `wp_upload_media` / `wp_update_media` / `wp_delete_media` | 管理媒体库 | 读写 |
| `wp_list_comments` / `wp_update_comment` / `wp_delete_comment` | 审核、编辑、删除评论 | 读写 |

## 1. 创建 WordPress Application Password

1. 登录 WordPress 后台。
2. 打开“用户 → 个人资料”。
3. 找到“应用程序密码”，输入名称，例如 `WordPress MCP Server`。
4. 点击“添加新应用程序密码”，立即复制生成的密码；它只显示一次。
5. 建议新建一个专用 WordPress 用户，只授予实际需要的角色。发布、上传、评论管理权限最终由该用户角色决定。

生产环境只使用 HTTPS。Application Password 通过 HTTP Basic Auth 发送，HTTP 明文链路不安全。

## 2. Docker 一键部署

```bash
cp .env.example .env
# 编辑 .env，至少填写 WP_URL、WP_USERNAME、WP_APPLICATION_PASSWORD
./deploy.sh
```

默认从 `ghcr.io/cnmbdb/wp-mcp:latest` 拉取生产镜像。可通过
`MCP_IMAGE` 环境变量固定到版本或提交 SHA 标签。

检查状态：

```bash
docker compose ps
curl http://127.0.0.1:3000/health
docker compose logs -f wordpress-mcp
```

默认 MCP 地址：`http://127.0.0.1:3000/mcp`。

### 本地开发：远程镜像 + Compose 补丁 + 源码挂载

GitHub Actions 同时发布 `latest` 生产镜像与 `dev` 开发镜像。本机不重复构建
基础镜像，使用第二个 Compose 文件补丁服务命令，并把本地源码只读挂载进容器：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml pull
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f wordpress-mcp
```

`tsx watch` 会监控挂载的 `src/`。若需要固定开发镜像，可设置
`MCP_DEV_IMAGE=ghcr.io/cnmbdb/wp-mcp:dev-sha-<commit>`。

Compose 默认通过 `BIND_ADDRESS=127.0.0.1` 只监听本机。若使用反向代理，保持该默认值即可；只有明确需要局域网直连时才改成 `0.0.0.0`，并同时启用 MCP 鉴权。

### JWT 兼容模式

仅当 WordPress 现有入口已经接受 JWT 时：

```dotenv
WP_AUTH_METHOD=jwt
WP_JWT_TOKEN=your-existing-wordpress-jwt
```

JWT 的签发、刷新和过期策略由你现有的 WordPress JWT 方案或身份网关负责。

### 自定义内容类型

自定义 Post Type 必须在 WordPress 中以 `show_in_rest=true` 注册，然后加入白名单：

```dotenv
WP_CONTENT_TYPES=posts,pages,product,portfolio
```

服务只会访问这里列出的 `/wp-json/wp/v2/<type>` 路径。

## 3. 连接 AI 客户端

### Codex

远程 HTTP：

```bash
codex mcp add wordpress --url https://mcp.example.com/mcp
```

若启用了 `MCP_API_KEY`：

```bash
export WORDPRESS_MCP_TOKEN='与服务器 MCP_API_KEY 相同的值'
codex mcp add wordpress \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var WORDPRESS_MCP_TOKEN
```

不要把真实密钥提交到配置仓库。

### Cursor

项目级 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "wordpress": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

也可以用 stdio 直接启动本地 Docker 镜像：

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/to/WordPress MCP Server/.env",
        "-e", "TRANSPORT=stdio",
        "wordpress-mcp-server:local"
      ]
    }
  }
}
```

### Claude Desktop / Claude Code

Claude Desktop 可使用上面的 stdio 配置，写入其 `claude_desktop_config.json`。Claude Code 可添加远程 Streamable HTTP 地址；具体命令以当前客户端版本的 MCP 添加界面或 `claude mcp --help` 为准。

### ChatGPT

1. 把服务部署到稳定的公网 HTTPS 域名，例如 `https://mcp.example.com/mcp`。ChatGPT 不能访问 `localhost`。
2. 在 ChatGPT 中打开 **Settings → Apps & Connectors → Advanced settings**，启用 Developer Mode。
3. 新建 App（旧界面可能叫 Connector），填入公网 `/mcp` URL。
4. 工具定义变更后刷新 App，让 ChatGPT 重新读取描述。

ChatGPT 公网生产连接建议使用标准 OAuth 身份网关。`MCP_API_KEY` 是适合支持自定义 Authorization Header 的客户端的轻量保护，不等同于 ChatGPT OAuth；若暂时不接 OAuth，不要把无鉴权的 `/mcp` 直接暴露到互联网。

## 4. 本地开发

```bash
npm install
cp .env.example .env
npm run dev
```

可用脚本：

```bash
npm run typecheck
npm test
npm run build
npm start
```

stdio 模式：

```bash
TRANSPORT=stdio npm start
```

注意：stdio 模式下协议走 stdout，日志只写 stderr。

## 5. 生产部署建议

- 使用 Caddy、Nginx、Traefik 或云负载均衡终止 TLS，只代理 `/mcp` 与 `/health`。
- 配置 `ALLOWED_HOSTS=mcp.example.com`，只填主机名，不含协议和端口。
- 将 `.env` 放入服务器或密钥管理器，绝不提交真实 WordPress 凭据。
- 使用专用低权限 WordPress 用户，定期轮换 Application Password。
- `force=true` 会永久删除；正常自动化应保留默认的回收站行为。
- 媒体上传受 `MAX_MEDIA_BYTES` 限制，默认 10 MiB。
- 容器默认非 root、只读文件系统、移除 Linux capabilities。

## 目录结构

```text
src/
  index.ts             # 传输模式入口
  http-server.ts       # Streamable HTTP /mcp
  mcp-server.ts        # 工具定义与安全注解
  wordpress-client.ts  # WordPress REST API 客户端
  config.ts            # 环境变量校验
test/                  # 配置与 REST 客户端测试
Dockerfile
docker-compose.yml
.env.example
```

## 设计依据

- OpenAI Apps SDK：MCP Server、工具定义与远程部署指南。
- Model Context Protocol 官方 TypeScript SDK：Streamable HTTP 与 stdio 传输。
- WordPress REST API Handbook：文章、页面、媒体、分类、标签、评论端点。
- WordPress Application Passwords：WordPress 5.6+ 原生 API 鉴权。

## License

MIT
