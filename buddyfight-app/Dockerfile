# 権威サーバ(オンライン対戦)を常時起動ホストへ載せる最小 Node イメージ。
# 依存ゼロ(バニラJS・package.json は engines のみ)なので npm install 不要。
FROM node:20-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# SSE 常時接続。PORT は env で注入される（fly.toml / PaaS が設定）。
CMD ["node", "server/authoritative-server.js", "--host", "0.0.0.0"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
