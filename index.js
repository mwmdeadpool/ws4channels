const express = require('express');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const os = require('os');

// Increase the process listener limit. Puppeteer registers process-level
// exit/SIGINT/SIGTERM/SIGHUP listeners on every browser launch and does not
// always clean them up on close. This silences the noisy
// MaxListenersExceededWarning so real problems are easier to see in the logs.
process.setMaxListeners(50);

const app = express();

const VERSION = '2.6'; // version 2.6 - honour X-Forwarded-Proto so playlist.m3u and guide.xml emit correct URLs behind a TLS reverse proxy
const ZIP_CODE = process.env.ZIP_CODE || '90210';
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost';
const WS4KP_PORT = process.env.WS4KP_PORT || '8080';
const STREAM_PORT = process.env.STREAM_PORT || '9798';
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`;
const PERMALINK_URL = process.env.PERMALINK_URL || null;
const HLS_SETUP_DELAY = 2000;
const FRAME_RATE = process.env.FRAME_RATE || 10;
const HLS_SEGMENT_SECONDS = 2;

// Number of segments kept in the live playlist. This is the player's entire
// buffer: at the old value of 2 the client had only HLS_SEGMENT_SECONDS * 2 = 4
// seconds of runway, so any capture or encode hiccup drained the playlist before
// the next segment landed and playback stalled. 6 segments (12s) is the usual
// live-HLS range and absorbs a spike without a visible freeze. Raising it costs
// a little latency; lower it if you would rather be closer to live.
const HLS_LIST_SIZE = parseInt(process.env.HLS_LIST_SIZE || '6', 10);

// --- Hardware-accelerated encoding -------------------------------------------
// HWACCEL=nvenc moves H.264 encoding onto an NVIDIA GPU (h264_nvenc). The
// default 'none' leaves the original libx264 CPU path unchanged.
//
// Only the encode is offloaded. Frames arrive as PNGs from Puppeteer, so there
// is no video decode to accelerate, and the scale filter deliberately stays in
// software: at this resolution and frame rate it is nearly free, and keeping it
// there avoids a hwupload_cuda round trip that would add latency for no gain.
//
// Requires the container to be started with GPU access -- see README.
const HWACCEL = (process.env.HWACCEL || 'none').toLowerCase();
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '3000k';

// 'ultrafast' was chosen when this container was capped at a single CPU. With
// six cores and one 1280x720 10fps stream the encoder is nowhere near the
// budget -- measured 114% of a 600% allowance, and encode is a small slice of
// that -- while ultrafast spends a lot of bitrate for nothing. 'veryfast' is a
// large quality-per-bit gain paid for with CPU that is already sitting idle.
const X264_PRESET = process.env.X264_PRESET || 'veryfast';

// --- Capture format ----------------------------------------------------------
// This is the whole frame-rate budget. Chromium encodes a 1280x720 PNG in
// ~130ms; the capture loop ticks every 1000/FRAME_RATE ms and skips any tick
// whose predecessor is still running, so at FRAME_RATE=10 (a 100ms tick) every
// other tick was lost and the pipe received a hard 5fps -- while ffmpeg was
// still told the input was 10fps. The HLS timeline then advanced at half real
// time and every client rebuffered.
//
// Measured 2026-09-03 before this change: avgScreenshotMs 132, framesWritten
// +3000 per 594s (5.05fps), skippedOverlap +2936 over the same window, playlist
// emitting ~10s of content per ~16s of wall clock.
//
// JPEG is several times cheaper to encode and visually indistinguishable at q90
// for this content. Set CAPTURE_FORMAT=png to go back.
const CAPTURE_FORMAT = (process.env.CAPTURE_FORMAT || 'jpeg').toLowerCase();
const CAPTURE_QUALITY = parseInt(process.env.CAPTURE_QUALITY || '90', 10);

// --- Input timestamps --------------------------------------------------------
// 'wallclock' stamps each frame with its arrival time and lets the output
// resample to CFR, so a slow capture makes motion choppier but keeps playback at
// real time. 'nominal' is the old behaviour -- assume frames arrive at exactly
// FRAME_RATE, which stretches the timeline whenever they don't. Choppy is
// survivable; slower than real time is not, because the player runs out of
// playlist and stalls. This is the belt to JPEG's braces: it bounds the damage
// from any future capture slowdown instead of turning it back into a stall.
const TIMESTAMP_MODE = (process.env.TIMESTAMP_MODE || 'wallclock').toLowerCase();
// nvenc presets run p1 (fastest) .. p7 (best quality); p4 is the driver default.
const NVENC_PRESET = process.env.NVENC_PRESET || 'p4';
// Tuning: hq | ll (low latency) | ull (ultra low latency). Live HLS wants ll.
const NVENC_TUNE = process.env.NVENC_TUNE || 'll';
// cbr suits HLS: predictable segment sizes keep the playlist well behaved.
const NVENC_RC = process.env.NVENC_RC || 'cbr';

// Resolved at startup by probeEncoder(). Never trust HWACCEL alone: a container
// started without GPU access will happily set HWACCEL=nvenc and then crash-loop
// on every ffmpeg spawn, and the existing error handler restarts transcoding on
// failure, so an unusable encoder becomes an infinite restart loop.
let activeEncoder = 'libx264';

// Optional proactive browser refresh. If set to a number > 0, the browser
// will be relaunched on this interval (minutes) regardless of whether
// anything has gone wrong. 0 = disabled (default).
const BROWSER_REFRESH_MINUTES = parseInt(process.env.BROWSER_REFRESH_MINUTES || '0', 10);

// Segment freshness watchdog: HLS segments should land roughly every
// HLS_SEGMENT_SECONDS. If we go this long without any output file's mtime
// advancing, ffmpeg is stalled on the encode/write/mux side.
const SEGMENT_STALL_WARN_MS = 8000;
const SEGMENT_CHECK_INTERVAL_MS = 2000;
const STDERR_BUFFER_LINES = 40;

const OUTPUT_DIR = path.join(__dirname, 'output');
const AUDIO_DIR = path.join(__dirname, 'music');
const LOGO_DIR = path.join(__dirname, 'logo');
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8');

// ws4kp 7.x supports 4 view modes: standard, wide, wide-enhanced, portrait-enhanced
// sort out the user's preferences and set up appropriate constants
const validViewModes = ['standard', 'wide', 'wide-enhanced', 'portrait-enhanced'];
// get the view mode (or default) and make it lower case
const desiredViewMode = (process.env.VIEW_MODE || 'wide').toLowerCase();
// test against the valid modes and set up the constant
const VIEW_MODE = validViewModes.includes(desiredViewMode) ? desiredViewMode : 'wide';

// set up the width and height constants via immediately invoked function
const VIEW_DIMENSIONS = (()=>{
	switch(VIEW_MODE) {
		case 'standard':
			return {
				width: 640,
				height: 480,
			}
		case 'portrait-enhanced':
			return {
				width: 720,
				height: 1280,
			}
		case 'wide':
		case 'wide-enhanced':
		default:
			return {
				width: 1280,
				height: 720,
			}
	}
})();

[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir); });

app.use('/stream', express.static(OUTPUT_DIR));
app.use('/logo', express.static(LOGO_DIR));

let ffmpegProc = null;
let ffmpegStream = null;
let browser = null;
let page = null;
let captureInterval = null;
let refreshTimer = null;
let segmentWatchdogInterval = null;
let isStreamReady = false;

// --- State for backpressure + overlap protection + restart diagnostics ---
let isCapturing = false;         // prevents overlapping screenshot calls
let isRestartingBrowser = false; // prevents overlapping/concurrent browser launches
let canWrite = true;             // false when ffmpegStream's internal buffer is full
let browserRestartCount = 0;     // how many times we've had to relaunch the browser
let framesWritten = 0;
let framesSkippedBackpressure = 0;
let framesSkippedOverlap = 0;
let framesSkippedRestarting = 0;

// --- Screenshot timing (kept — cheap, and useful as a "capture side is
// healthy" baseline now that we've ruled it out as the freeze cause) ---
let totalScreenshotMs = 0;
let maxScreenshotMs = 0;
let captureStartedAt = null; // timestamp of the currently in-flight screenshot, or null

// --- ffmpeg-side instrumentation (new) ---
let stderrBuffer = [];              // rolling buffer of the last N ffmpeg stderr lines
let lastProgress = null;            // most recent fluent-ffmpeg 'progress' payload
let lastProgressAt = null;          // when we last received a progress event
let lastSegmentMtimeMs = null;      // newest mtime seen among output files
let lastSegmentChangeAt = null;     // wall-clock time that mtime last advanced
let segmentStallActive = false;     // whether we're currently in a detected stall
let segmentStallWarningsIssued = 0; // how many distinct stall episodes we've logged
let lastStallDumpAt = 0;            // throttles repeated stderr dumps during one long stall

const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));

function logTS(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Helper: Fisher–Yates shuffle
function shuffleArray(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getContainerLimits() {
  let cpuQuotaPath = '/sys/fs/cgroup/cpu.max';
  let memLimitPath = '/sys/fs/cgroup/memory.max';
  let cpus = os.cpus().length;
  let memory = os.totalmem();
  try { const [quota, period] = fs.readFileSync(cpuQuotaPath,'utf8').trim().split(' '); if(quota!=='max') cpus=parseFloat((parseInt(quota)/parseInt(period)).toFixed(2)); } catch {}
  try { const raw = fs.readFileSync(memLimitPath,'utf8').trim(); if(raw!=='max') memory=parseInt(raw); } catch {}
  return { cpus, memoryMB: Math.round(memory/(1024*1024)) };
}

function createAudioInputFile() {
  const defaultMp3s = [
    '01 Weatherscan Track 26.mp3','02 Weatherscan Track 3.mp3','03 Tropical Breeze.mp3',
    '04 Late Nite Cafe.mp3','05 Care Free.mp3','06 Weatherscan Track 14.mp3','07 Weatherscan Track 18.mp3'
  ];

  let files = [];
  try {
    // Read only MP3 files from AUDIO_DIR
    files = fs.readdirSync(AUDIO_DIR).filter(file => file.toLowerCase().endsWith('.mp3'));
    if (files.length === 0) {
      console.warn('No MP3 files found in music directory; using default music list');
      files = defaultMp3s;
    }
  } catch (err) {
    console.error(`Failed to read music directory: ${err.message}`);
    console.warn('Using default music list due to error');
    files = defaultMp3s;
  }
  
  // Shuffle if requested
  if (process.env.SHUFFLE_MUSIC?.toLowerCase() === 'true') {
    files = shuffleArray(files);
    console.log('Shuffled music list based on SHUFFLE_MUSIC=true');
  }

  console.log(`Loaded ${files.length} music files`);
  const audioList = files.map(file => `file '${path.join(AUDIO_DIR, file)}'`).join('\n');
  fs.writeFileSync(path.join(__dirname, 'audio_list.txt'), audioList);


  // Note: Update README to inform users they can add MP3 files to the 'music' folder
  // and that the default files (listed above) are used if no MP3s are found.
}

function generateXMLTV(baseUrl) {
  const now = new Date();
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="WS4000">
<display-name>WeatherStar 4000</display-name>
<icon src="${baseUrl}/logo/ws4000.png" />
</channel>`;
  for(let i=0;i<24;i++){
    const startTime = new Date(now.getTime()+i*3600*1000);
    const endTime = new Date(startTime.getTime()+3600*1000);
    const start = startTime.toISOString().replace(/[-:T]/g,'').split('.')[0]+' +0000';
    const end = endTime.toISOString().replace(/[-:T]/g,'').split('.')[0]+' +0000';
    xml += `
<programme start="${start}" stop="${end}" channel="WS4000">
<title lang="en">Local Weather</title>
<desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>
<icon src="${baseUrl}/logo/ws4000.png" />
</programme>`;
  }
  xml += `</tv>`;
  return xml;
}

async function startBrowser(reason = 'initial startup') {
  // Hard lock: only one browser launch can be in progress at a time.
  if (isRestartingBrowser) {
    logTS('startBrowser() called while a restart was already in progress — ignoring duplicate call');
    return;
  }
  isRestartingBrowser = true;

  try {
    browserRestartCount++;
    logTS(`Launching browser (launch #${browserRestartCount}, reason: ${reason})`);
    if(browser) await browser.close().catch(()=>{});
    browser = await puppeteer.launch({
      headless: true,
      args:[
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--ignore-certificate-errors',
        '--window-size=1280,720',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
      ],
      defaultViewport: null
    });
    page = await browser.newPage();
    if (PERMALINK_URL) {
      console.log(`Using custom permalink URL: ${PERMALINK_URL}`);
      await page.goto(PERMALINK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    } else {
      await page.goto(WS4KP_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      try {
        const zipInput = await page.waitForSelector('input[placeholder="Zip or City, State"], input', { timeout: 5000 });
        if (zipInput) {
          // type the zip code
          await zipInput.type(ZIP_CODE, { delay: 100 });
          // wit for suggestions box
          await page.waitForSelector('#divQuery .autocomplete-suggestions .suggestion');
          // select the first suggestion
          await page.keyboard.press('ArrowDown');
          // wait for the selection to be highlighted
          await page.waitForSelector('#divQuery .autocomplete-suggestions .suggestion.selected');
          // find and press the submit button
          const goButton = await page.$('button[type="submit"]');
          if (goButton) await goButton.click(); else await zipInput.press('Enter');
          // wait for weather content to update
          await page.waitForSelector('div.weather-display, #weather-content', { timeout: 30000 });
        }
      } catch {}

      // force ws4kp app to wide screen and kiosk (full screen), this removes the need to specify exactly where to crop for the screenshot

      try {
        // get the widescreen checkbox from the settings section
        // will throw if the element is not present on ws4kp 7.x and a different path is taken in the catch statement
        // which is the reason for the short timeout
        const widescreenCheckbox = await page.waitForSelector('#settings-wide-checkbox', {timeout: 100});


        // 6.x (classic) behavior
        // only supports standard and wide, check and exit with an error if not doable
        if (VIEW_MODE === 'wide-enhanced' || VIEW_MODE === 'portrait-enhanced') {
          console.error(`This version of ws4kp only supports VIEW_MODE 'standard' or 'enhanced'`);
          await browser.close();
          process.exit();
        }
        // get the checkbox's current state and click it to turn it on if necessary
        const widescreenChecked = await widescreenCheckbox.evaluate((el) => el.checked);
        // click the checkbox on a mismatch
        if (widescreenChecked && VIEW_MODE === 'standard' || !widescreenChecked && VIEW_MODE === 'wide') await widescreenCheckbox.click();
      } catch {
              try {
              // 7.x (wide/portrait/enhanced behavior)
              // get the selector box and select widescreen
              const viewSelector = await page.waitForSelector('#settings-viewMode-select');
              // set the desired mode
              await viewSelector.evaluate((el, VIEW_MODE) => {
                el.value = VIEW_MODE;
                el.dispatchEvent(new Event('change'));
              }, VIEW_MODE);
            } catch {}

      }
      finally {
        // both 6.x and 7.x support kiosk as a checkbox
        // and now for kiosk
        const kioskCheckbox = await page.waitForSelector('#settings-kiosk-checkbox');    // set the checkbox
        const kioskChecked = await kioskCheckbox.evaluate((el) => el.checked);
        if (!kioskChecked) await kioskCheckbox.click();
      }
    }
    await page.setViewport({ ...VIEW_DIMENSIONS });

    // Reset capture guards after a fresh browser/page is ready.
    isCapturing = false;
    canWrite = true;
    captureStartedAt = null;
    logTS(`Browser ready (launch #${browserRestartCount})`);
  } finally {
    isRestartingBrowser = false;
  }
}

function scheduleBrowserRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!BROWSER_REFRESH_MINUTES || BROWSER_REFRESH_MINUTES <= 0) {
    logTS('Scheduled browser refresh disabled (BROWSER_REFRESH_MINUTES not set)');
    return;
  }
  logTS(`Scheduled browser refresh enabled: every ${BROWSER_REFRESH_MINUTES} minute(s)`);
  refreshTimer = setInterval(() => {
    startBrowser(`scheduled refresh (${BROWSER_REFRESH_MINUTES}m interval)`);
  }, BROWSER_REFRESH_MINUTES * 60 * 1000);
}

function dumpFfmpegDiagnostics(gapMs) {
  logTS(`FFMPEG STALL WARNING: no new HLS segment/file activity in ${gapMs}ms (segments should land roughly every ${HLS_SEGMENT_SECONDS * 1000}ms)`);

  if (lastProgress) {
    const sinceProgress = lastProgressAt ? (Date.now() - lastProgressAt) : null;
    logTS(`Last ffmpeg progress event (${sinceProgress}ms ago): frames=${lastProgress.frames}, currentFps=${lastProgress.currentFps}, currentKbps=${lastProgress.currentKbps}, timemark=${lastProgress.timemark}`);
  } else {
    logTS('No ffmpeg progress events received yet this session');
  }

  if (stderrBuffer.length === 0) {
    logTS('(no ffmpeg stderr output captured yet)');
  } else {
    logTS(`Last ${stderrBuffer.length} ffmpeg stderr line(s):`);
    stderrBuffer.forEach(line => console.log(`  ffmpeg: ${line}`));
  }
}

function startSegmentWatchdog() {
  if (segmentWatchdogInterval) clearInterval(segmentWatchdogInterval);
  lastSegmentMtimeMs = null;
  lastSegmentChangeAt = Date.now();
  segmentStallActive = false;

  segmentWatchdogInterval = setInterval(() => {
    let files;
    try {
      files = fs.readdirSync(OUTPUT_DIR);
    } catch {
      return; // output dir momentarily unavailable, e.g. during a restart
    }

    let newestMtime = 0;
    for (const f of files) {
      if (!f.endsWith('.ts') && !f.endsWith('.m3u8')) continue;
      try {
        const stat = fs.statSync(path.join(OUTPUT_DIR, f));
        if (stat.mtimeMs > newestMtime) newestMtime = stat.mtimeMs;
      } catch {}
    }

    if (newestMtime > 0 && (lastSegmentMtimeMs === null || newestMtime > lastSegmentMtimeMs)) {
      lastSegmentMtimeMs = newestMtime;
      lastSegmentChangeAt = Date.now();
      if (segmentStallActive) {
        logTS('FFMPEG STALL RECOVERED: new segment activity detected, output is flowing again');
        segmentStallActive = false;
      }
      return;
    }

    const gapMs = Date.now() - lastSegmentChangeAt;
    if (gapMs > SEGMENT_STALL_WARN_MS) {
      // Log the initial detection immediately, then only re-dump every 5s
      // while the same stall continues, so a long stall doesn't spam the log.
      if (!segmentStallActive || Date.now() - lastStallDumpAt > 5000) {
        segmentStallActive = true;
        lastStallDumpAt = Date.now();
        segmentStallWarningsIssued++;
        dumpFfmpegDiagnostics(gapMs);
      }
    }
  }, SEGMENT_CHECK_INTERVAL_MS);
}

// Encode one throwaway frame to prove the requested encoder actually works
// before committing the real pipeline to it. Checking that h264_nvenc is listed
// in `-encoders` is not enough: the encoder is compiled into Debian's ffmpeg
// whether or not a GPU is present, so the listing succeeds on a container with
// no GPU access and the failure only surfaces later, on every restart.
function probeEncoder() {
  return new Promise(resolve => {
    if (HWACCEL !== 'nvenc') {
      if (HWACCEL !== 'none') logTS(`Unknown HWACCEL '${HWACCEL}', falling back to libx264`);
      return resolve('libx264');
    }
    const { spawn } = require('child_process');
    const probe = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `nullsrc=s=${VIEW_DIMENSIONS.width}x${VIEW_DIMENSIONS.height}:d=0.1`,
      '-c:v', 'h264_nvenc', '-preset', NVENC_PRESET,
      '-frames:v', '1', '-f', 'null', '-',
    ]);
    let stderr = '';
    probe.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { probe.kill('SIGKILL'); }, 15000);
    probe.on('error', err => {
      clearTimeout(timer);
      logTS(`NVENC probe could not run ffmpeg (${err.message}); using libx264`);
      resolve('libx264');
    });
    probe.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        logTS(`NVENC probe OK - encoding on h264_nvenc (preset ${NVENC_PRESET}, tune ${NVENC_TUNE}, rc ${NVENC_RC})`);
        return resolve('h264_nvenc');
      }
      logTS('NVENC requested but unusable - falling back to libx264. Is the container started with GPU access?');
      stderr.trim().split('\n').filter(Boolean).slice(-4).forEach(l => logTS(`  nvenc probe: ${l}`));
      resolve('libx264');
    });
  });
}

// Video filter chain. nvenc accepts system-memory frames directly, but the PNG
// input arrives as RGB and yuv420p is what players expect from HLS, so the
// conversion is made explicit on the GPU path. The libx264 path is left exactly
// as it was (x264 performs the same conversion implicitly).
function videoFilter() {
  const scale = `[0:v]scale=${VIEW_DIMENSIONS.width}:${VIEW_DIMENSIONS.height}`;
  return activeEncoder === 'h264_nvenc' ? `${scale},format=yuv420p[v]` : `${scale}[v]`;
}

function videoOutputOptions() {
  const gop = FRAME_RATE * HLS_SEGMENT_SECONDS;
  if (activeEncoder === 'h264_nvenc') {
    return [
      '-c:v h264_nvenc',
      `-preset ${NVENC_PRESET}`,
      `-tune ${NVENC_TUNE}`,
      `-rc ${NVENC_RC}`,
      '-profile:v high',
      `-b:v ${VIDEO_BITRATE}`,
      `-maxrate ${VIDEO_BITRATE}`,
      `-bufsize ${VIDEO_BITRATE}`,
      `-g ${gop}`,
    ];
  }
  return ['-c:v libx264', `-preset ${X264_PRESET}`, `-g ${gop}`, `-b:v ${VIDEO_BITRATE}`];
}

// Wall-clock input timestamps make the pipe variable-rate, so the output has to
// be pinned back to CFR explicitly -- otherwise a dropped capture becomes a
// variable-rate HLS segment and players handle those badly. Duplicating a frame
// costs nothing at this bitrate and keeps the timeline honest.
function frameRateOutputOptions() {
  return TIMESTAMP_MODE === 'wallclock'
    ? [`-r ${FRAME_RATE}`, '-fps_mode cfr']
    : [];
}

async function startTranscoding() {
  await startBrowser('initial startup');
  createAudioInputFile();
  scheduleBrowserRefresh();

  // Give the PassThrough a modest, explicit buffer size. This is what makes
  // backpressure kick in quickly rather than silently buffering an
  // ever-growing backlog of frames in memory.
  ffmpegStream = new PassThrough({ highWaterMark: 1024 * 1024 * 4 }); // ~4MB
  ffmpegStream.on('drain', () => {
    canWrite = true;
  });

  stderrBuffer = [];
  lastProgress = null;
  lastProgressAt = null;

  ffmpegProc = ffmpeg()
    .input(ffmpegStream)
    .inputFormat('image2pipe')
    .inputOptions(
      TIMESTAMP_MODE === 'wallclock'
        // -framerate stays as the nominal hint for anything that asks before a
        // second frame has arrived; the wallclock stamps are what actually
        // drive the timeline.
        ? ['-use_wallclock_as_timestamps 1', `-framerate ${FRAME_RATE}`]
        : [`-framerate ${FRAME_RATE}`]
    )
    .input(path.join(__dirname,'audio_list.txt'))
    .inputOptions(['-f concat','-safe 0','-stream_loop -1','-vcodec png'])
    .complexFilter([videoFilter(),'[1:a]volume=0.5[a]'])
    .outputOptions(['-map [v]','-map [a]','-c:a aac','-b:a 128k',...videoOutputOptions(),...frameRateOutputOptions(),'-f hls',`-hls_time ${HLS_SEGMENT_SECONDS}`,`-hls_list_size ${HLS_LIST_SIZE}`,'-hls_flags delete_segments'])
    .output(HLS_FILE)
    .on('start',(cmd)=>{ logTS(`Started FFmpeg - Version ${VERSION} - video encoder ${activeEncoder}`); setTimeout(()=>isStreamReady=true,HLS_SETUP_DELAY); })
    .on('stderr', line => {
      stderrBuffer.push(line);
      if (stderrBuffer.length > STDERR_BUFFER_LINES) stderrBuffer.shift();
    })
    .on('progress', p => {
      lastProgress = p;
      lastProgressAt = Date.now();
    })
    .on('error', async err=>{ logTS(`FFmpeg error: ${err.message}`); await stopTranscoding(); startTranscoding(); })
    .on('end',()=>{ ffmpegProc=null; ffmpegStream=null; isStreamReady=false; });

  startSegmentWatchdog();

  captureInterval = setInterval(async ()=>{
    if(!ffmpegProc || !ffmpegStream || !page) return;

    // A browser relaunch is already in progress — don't touch the page or
    // trigger another one.
    if (isRestartingBrowser) {
      framesSkippedRestarting++;
      return;
    }

    // Don't start a new screenshot if the previous one hasn't finished yet.
    if (isCapturing) {
      framesSkippedOverlap++;
      return;
    }

    // Don't capture new frames if ffmpeg can't keep up.
    if (!canWrite) {
      framesSkippedBackpressure++;
      return;
    }

    isCapturing = true;
    captureStartedAt = Date.now();
    try{
      if(page.isClosed()){ isCapturing = false; captureStartedAt = null; await startBrowser('page was closed'); return; }
      // Updated 16:9 capture for version 1.6
      const screenshot = await page.screenshot({
        type: CAPTURE_FORMAT,
        // quality is only valid for jpeg/webp -- passing it with png throws.
        ...(CAPTURE_FORMAT === 'png' ? {} : { quality: CAPTURE_QUALITY }),
        clip:{ x:0, y:0, ...VIEW_DIMENSIONS }, // crop top, right, and bottom based on your measurements
        // The clip matches the viewport exactly, so there is nothing beyond it
        // to capture; letting Puppeteer resize for an off-screen area is pure
        // cost on every single frame.
        captureBeyondViewport: false
      });

      const elapsedMs = Date.now() - captureStartedAt;
      totalScreenshotMs += elapsedMs;
      if (elapsedMs > maxScreenshotMs) maxScreenshotMs = elapsedMs;

      const ok = ffmpegStream.write(screenshot);
      framesWritten++;
      if (!ok) canWrite = false; // wait for 'drain' before writing again

      // Every 5 minutes, log a quick health summary.
      if (framesWritten % (FRAME_RATE * 60 * 5) === 0) {
        const avgMs = Math.round(totalScreenshotMs / framesWritten);
        const sinceProgress = lastProgressAt ? (Date.now() - lastProgressAt) : null;
        logTS(`Health check: framesWritten=${framesWritten}, avgScreenshotMs=${avgMs}, maxScreenshotMs=${maxScreenshotMs}, skippedBackpressure=${framesSkippedBackpressure}, skippedOverlap=${framesSkippedOverlap}, skippedRestarting=${framesSkippedRestarting}, browserRestarts=${browserRestartCount}, segmentStallWarnings=${segmentStallWarningsIssued}, msSinceLastFfmpegProgress=${sinceProgress}`);
      }
    } catch(err){
      console.warn('Capture error, retrying...', err.message);
      isCapturing = false;
      captureStartedAt = null;
      await startBrowser(`capture error: ${err.message}`);
      return;
    }
    isCapturing = false;
    captureStartedAt = null;
  },1000/FRAME_RATE);

  ffmpegProc.run();
}

async function stopTranscoding(){
  if(captureInterval) clearInterval(captureInterval);
  captureInterval=null; isStreamReady=false;
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer=null;
  if(segmentWatchdogInterval) clearInterval(segmentWatchdogInterval);
  segmentWatchdogInterval=null;
  if(ffmpegProc) ffmpegProc.kill('SIGINT'); ffmpegProc=null;
  if(browser) await browser.close().catch(()=>{}); browser=null;
}

// Behind a TLS-terminating reverse proxy the request arrives as plain http, so
// a hard-coded http:// scheme emits a playlist whose inner stream URL points at
// http://<public-host>. That survives only because the proxy redirects, costing
// an extra round trip on every segment fetch -- and it breaks outright anywhere
// mixed content is refused. Trust X-Forwarded-Proto when a proxy sets it.
function externalBase(req) {
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${host}`;
}

app.get('/playlist.m3u',(req,res)=>{
  const baseUrl = externalBase(req);
  const m3uContent = `#EXTM3U
#EXTINF:-1 channel-id="weatherStar4000" tvg-id="weatherStar4000" tvg-channel-no="275" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`;
  res.set('Content-Type','application/x-mpegURL'); res.send(m3uContent);
});

app.get('/guide.xml',(req,res)=>{
  res.set('Content-Type','application/xml'); res.send(generateXMLTV(externalBase(req)));
});

app.get('/health',(req,res)=>{
  const avgScreenshotMs = framesWritten > 0 ? Math.round(totalScreenshotMs / framesWritten) : 0;
  const currentlyStuckMs = (isCapturing && captureStartedAt) ? (Date.now() - captureStartedAt) : 0;
  const msSinceLastSegmentChange = lastSegmentChangeAt ? (Date.now() - lastSegmentChangeAt) : null;
  const msSinceLastFfmpegProgress = lastProgressAt ? (Date.now() - lastProgressAt) : null;

  res.status(isStreamReady?200:503).json({
    ready:isStreamReady,
    browserRestarts: browserRestartCount,
    framesWritten,
    framesSkippedBackpressure,
    framesSkippedOverlap,
    framesSkippedRestarting,
    avgScreenshotMs,
    maxScreenshotMs,
    currentlyStuckMs,
    segmentStallWarningsIssued,
    segmentStallActive,
    msSinceLastSegmentChange,
    msSinceLastFfmpegProgress,
    lastFfmpegTimemark: lastProgress ? lastProgress.timemark : null
  });
});

const { cpus, memoryMB } = getContainerLimits();
console.log(`Version ${VERSION} | Running with ${cpus} CPU cores, ${memoryMB}MB RAM`);
console.log(`Capture: ${CAPTURE_FORMAT}${CAPTURE_FORMAT === 'png' ? '' : ` q${CAPTURE_QUALITY}`} @ ${FRAME_RATE}fps | timestamps: ${TIMESTAMP_MODE} | bitrate: ${VIDEO_BITRATE} | x264 preset: ${X264_PRESET}`);

app.listen(STREAM_PORT, async ()=>{
  console.log(`Streaming server running on port ${STREAM_PORT}`);
  // Probe once at boot, not per restart: startTranscoding() is re-entered by the
  // ffmpeg error handler, and re-probing there would add a GPU test to every
  // recovery attempt.
  activeEncoder = await probeEncoder();
  await startTranscoding();
});

process.on('SIGINT', async ()=>{ console.log('SIGINT received'); await stopTranscoding(); process.exit(); });
process.on('SIGTERM', async ()=>{ console.log('SIGTERM received'); await stopTranscoding(); process.exit(); });
