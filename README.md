# Latest Update

08/31/2026 version2.4 - Added ffmpeg-side logging (segment watchdog, progress tracking, stderr capture); removed capture-side hang watchdog (proven unnecessary).

08/16/2026 version2.3 Added more logging.  Added another attempt to fix rare stream being more than 3 minutes behind and racing catchup. 

08/10/2026 version2.2  Added another attempt to fix rare stream being more than 3 minutes behind and racing catchup.  Updates so regional maps and radar are drawn full-screen and properly centered on the user's location.


07/11/2026 version2.1  Added attempt to fix rare stream being more than 3 minutes behind and racing catchup.  Added better logging to troubleshoot this issue.http://<host>:9798/health

05/04/2026
Added PR from netbymatt changing from jpeg to png.

05/03/2026
Added PR from ws4kp's netbymatt in anticipation of ws4kp versions 7.X and addition of PERMALINK_URL: Pass configuration parameters via permalink generated from ws4kp.  As usual I did not have time to test the update so please report any issues.

Pull ws4kp container.

```bash

docker pull ghcr.io/netbymatt/ws4kp:latest
```

Run ws4kp container.

```bash

docker run -d \
  --name ws4kp \
  --restart unless-stopped \
  -p 9090:8080 \
  ghcr.io/netbymatt/ws4kp:latest
```




# Known Bugs
Rare cases of the stream getting 30+ minutes behind and racing to catch up after stream is played long term.

# ws4channels

A Dockerized Node.js application to stream WeatherStar 4000 data into Channels DVR using Puppeteer and FFmpeg.

## Prerequisites

- 850MB availabe RAM
- Docker installed
- WS4KP running and installed
   https://github.com/netbymatt/ws4kp
  
## Usage

Build and run the container:

Step 1: Pull the Docker Image

```bash

docker pull ghcr.io/rice9797/ws4channels:latest
```

Step 2: Run the Container

Next, run the container using the following command. This will start the container in detached mode and set the required environment variables.

```bash

docker run -d \
  --name ws4channels \
  --restart unless-stopped \
  --memory="1096m" \
  --cpus="1.0" \
  -p 9798:9798 \
  -e PERMALINK_URL=your_permalink_generated_from_ws4kp \
  -e ZIP_CODE=your_zip_code \
  -e WS4KP_HOST=ws4kp_host \
  -e WS4KP_PORT=ws4kp_port \
http://ghcr.io/rice9797/ws4channels:latest
```

Example:

 --memory="1096m" --cpus="1.0" -p 9798:9798 -e ZIP_CODE=63101 -e WS4KP_PORT=8080 -e WS4KP_HOST=192.168.1.152

-1096m=the amount of maximum ram the container can use in mb. 

-1.0= maximum amount of cpu cores the container can use. Default is 1 core

-PERMALINK_URL=  Add if you created a permalink within ws4kp, delete this variable if not.

-63101= enter your zip code

-WS4KP_PORT= this is the port you set up WeatherStar4000 container with if you didn’t choose another port that container defaults to 8080.

-WS4KP_HOST= the ip of the machine that WeatherStar4000 container runs on.

Environment Variables

	•  ZIP_CODE: Your ZIP code (default: 90210)
 
	•  WS4KP_HOST: Host running WS4KP (default: localhost)
 
	•  WS4KP_PORT: Port for WS4KP (default: 8080)
 
	•  --cpus: CPU limit (default: 1.0)
 
	•  --memory: RAM limit in MB (default: 1096)
 
	•  FRAME_RATE: Stream frame rate (default: 10)

	•  CHANNEL_NUMBER: Sets the channel number (default: 275)
  
    •  SHUFFLE_MUSIC: Randomize the order in which detected mp3s are played (default: false)
  
    •  PERMALINK_URL: Pass configuration parameters via permalink generated from ws4kp
	
	•  VIEW_MODE: One of: `standard`, `wide` (default), `wide-enhanced` or `portrait-enhanced`. These values correspond to the modes available in ws4kp, with the last two only available in ws4kp v7.0+. Video sizes are 640x480, 1280x720 or 720x1280 to match.

## Hardware Acceleration, ARM Multi Arch Support

NVIDIA hardware encoding (NVENC) is supported. Multi Arch is not.

Set `HWACCEL=nvenc` and give the container access to a GPU. Encoding moves from
`libx264` to `h264_nvenc`, which frees up most of the CPU the stream was using.

No custom ffmpeg build is required — the `h264_nvenc` encoder is already present
in the Debian ffmpeg package the image installs. What the container needs is the
NVIDIA Container Toolkit on the host, and the `video` driver capability, which is
what causes the driver's encode libraries to be injected at runtime. The image
sets `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video` for you.

Docker run:

```
docker run -d --name ws4channels \
  --runtime=nvidia \
  -p 9798:9798 \
  -e HWACCEL=nvenc \
  -e ZIP_CODE=63101 \
  -e WS4KP_HOST=192.168.1.152 \
  ws4channels:latest
```

Docker compose:

```yaml
services:
  ws4channels:
    image: ws4channels:latest
    runtime: nvidia
    environment:
      - HWACCEL=nvenc
      - ZIP_CODE=63101
```

On Unraid, add `--runtime=nvidia` to *Extra Parameters* and set `HWACCEL=nvenc`
as a variable.

### Falling back safely

`HWACCEL=nvenc` is a request, not a guarantee. At startup the app encodes one
throwaway frame to check the GPU is genuinely usable, and if it is not, it logs
the reason and continues on `libx264`. This matters because a container started
without GPU access still reports `h264_nvenc` as an available encoder — the
encoder is compiled in whether or not hardware is present — so the failure would
otherwise only appear when the real pipeline starts, and the existing error
handler restarts transcoding on failure, turning it into a restart loop.

Which encoder was chosen is logged on every ffmpeg start:

```
Started FFmpeg - Version 2.4 - video encoder h264_nvenc
```

To confirm the GPU is actually working, run `nvidia-smi` on the host while the
stream is live and look for a non-zero encoder session count.

### NVENC tuning

	•  `HWACCEL`: `none` (default) or `nvenc`

	•  `NVENC_PRESET`: `p1` (fastest) through `p7` (best quality), default `p4`

	•  `NVENC_TUNE`: `hq`, `ll` (low latency, default) or `ull` (ultra low latency)

	•  `NVENC_RC`: rate control, `cbr` (default), `vbr` or `constqp`

	•  `VIDEO_BITRATE`: video bitrate, default `1000k` (applies to both encoders)

Only the encode is offloaded. Frames arrive as PNGs from Puppeteer, so there is
no video decode to accelerate, and the scale filter is deliberately left in
software — at this resolution and frame rate it costs almost nothing, and moving
it to the GPU would add a `hwupload_cuda` round trip for no benefit.


### Accessing the Stream

M3U Playlist:

 http://<ip.of.pc.running.ws4channels>:9798/playlist.m3u

Example: <http://192.168.1.131:9798/playlist.m3u>
In Channels DVR, use MPEG-TS format with this URL.

  Guide Data
  XMLTV Guide:
  
 http://<ip.of.pc.running.ws4channels>:9798/guide.xml

Example: <http://192.168.1.131:9798/guide.xml>

Latest additions
 6/21/25 Update:

## Music Configuration

- The application plays MP3 files from the `music` folder in the project root.
- Default tracks included:
  - 01 WST26.mp3
  - 02 WST3.mp3
  - 03 TB.mp3
  - 04 LNC.mp3
  - 05 CF.mp3
  - 06 WST14.mp3
  - 07 WST18.mp3
  
- To customize, add your own MP3 files to the `music` folder. Only `.mp3` files are included in the stream.
- If no MP3s are found, the default tracks are used.
- After adding your mp3 tracks to the music folder restart the container so the app will pick up the new music.

 Prior Updates:

 -Includes seven looping jazz tracks as background music.

-Provides an XMLTV guide with hourly “Local Weather” entries.

-Added guide logo

-Optimized cropping for a clean video feed by removing white bars.

-Changed default cpu and memory limits to 1 cpu core and 1gb ram. Adjust if your system requires.

About:

A nostalgic weather streaming solution for Channels DVR, built with Node.js, Puppeteer, and FFmpeg.

[Buy me a coffee ☕](https://www.buymeacoffee.com/rice9797)
