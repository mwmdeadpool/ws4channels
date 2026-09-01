FROM node:18

# Install FFmpeg and Puppeteer dependencies
RUN apt-get update && apt-get install -y \
  ffmpeg \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --verbose

# Copy application code, music, and logo files
COPY . .
RUN mkdir -p /app/music /app/logo
COPY music/*.mp3 /app/music/
COPY logo/*.png /app/logo/

# --- NVIDIA hardware acceleration --------------------------------------------
# Debian bookworm's ffmpeg already ships the h264_nvenc encoder, so no custom
# ffmpeg build is needed. What is needed is for the NVIDIA Container Toolkit to
# inject the driver's encode libraries at runtime, which it only does when these
# capabilities are requested. "video" is the one that carries libnvidia-encode;
# without it h264_nvenc is present but fails to open a session.
#
# Both variables are inert on a host with no NVIDIA runtime, so the image still
# runs unchanged on CPU. Set HWACCEL=nvenc to actually use the GPU.
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

# Use STREAM_PORT environment variable for dynamic port
EXPOSE $STREAM_PORT
CMD ["node", "index.js"]

