FROM node:24.22.1-alpine
ENV NODE_ENV=production PORT=8080 SITE_DIR=/app DATA_DIR=/data MEDIA_DIR=/media
WORKDIR /app
# Uploaded videos are converted with ffmpeg (H.264 MP4, metadata and location removed).
RUN apk add --no-cache ffmpeg \
  && ffmpeg -hide_banner -encoders | grep -q libx264 \
  && ffmpeg -hide_banner -encoders | grep -qE '^ A[.A-Z]+ aac '
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.html robots.txt ./
COPY assets ./assets
COPY compose ./compose
COPY manage ./manage
COPY profiles ./profiles
COPY welcome ./welcome
COPY login ./login
COPY data ./data
COPY server ./server
RUN mkdir -p /data /media && chown -R node:node /data /media
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
