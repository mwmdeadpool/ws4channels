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

const VERSION = '2.3'; // version 2.3 - dev-shm fix, screenshot timing + hang watchdog, restart lock, optional scheduled refresh
const ZIP_CODE = process.env.ZIP_CODE || '90210';
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost';
const WS4KP_PORT = process.env.WS4KP_PORT || '8080';
const STREAM_PORT = process.env.STREAM_PORT || '9798';
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`;
const PERMALINK_URL = process.env.PERMALINK_URL || null;
const HLS_SETUP_DELAY = 2000;
const FRAME_RATE = process.env.FRAME_RATE || 10;

// Optional proactive browser refresh. If set to a number > 0, the browser
// will be relaunched on this interval (minutes) regardless of whether
// anything has gone wrong. 0 = disabled (default).
const BROWSER_REFRESH_MINUTES = parseInt(process.env.BROWSER_REFRESH_MINUTES || '0', 10);

// Watchdog thresholds for a single page.screenshot() call.
// WARN: log loudly that a capture is taking unusually long, but keep waiting.
// FORCE_RESTART: give up on it entirely and relaunch the browser, since a
// screenshot stuck this long is effectively a hang, not just slowness.
const SCREENSHOT_WARN_MS = 3000;
const SCREENSHOT_FORCE_RESTART_MS = 15000;

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
let watchdogInterval = null;
let refreshTimer = null;
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

// --- Screenshot timing + hang watchdog instrumentation ---
let totalScreenshotMs = 0;
let maxScreenshotMs = 0;
let captureStartedAt = null;   // timestamp of the currently in-flight screenshot, or null
let hangWarningsIssued = 0;    // how many times a single screenshot exceeded SCREENSHOT_WARN_MS
let hangForcedRestarts = 0;    // how many times a single screenshot exceeded SCREENSHOT_FORCE_RESTART_MS
let lastHangWarnLoggedAt = 0;  // avoid spamming the log every watchdog tick for the same stuck call

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

function generateXMLTV(host) {
  const now = new Date();
  const baseUrl = `http://${host}`;
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
        // These four are common fixes for headless Chrome intermittently
        // hanging/stalling inside Docker containers, most notably the tiny
        // (64MB) default /dev/shm size. --disable-dev-shm-usage makes
        // Chrome use /tmp instead, which is the leading suspect for the
        // "screenshot calls hang for seconds despite the page rendering
        // fine" pattern we're seeing.
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

function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  // Checks once a second whether the currently in-flight screenshot call
  // has been running suspiciously long. This is the piece that lets us see
  // a hang WHILE it's happening, rather than only after it eventually
  // resolves (if it ever does).
  watchdogInterval = setInterval(() => {
    if (!isCapturing || !captureStartedAt) return;
    const inFlightMs = Date.now() - captureStartedAt;

    if (inFlightMs > SCREENSHOT_FORCE_RESTART_MS) {
      hangForcedRestarts++;
      logTS(`WATCHDOG: screenshot has been stuck for ${inFlightMs}ms (over the ${SCREENSHOT_FORCE_RESTART_MS}ms limit) — forcing a browser restart`);
      captureStartedAt = null;
      startBrowser(`screenshot hang timeout (${inFlightMs}ms)`);
      return;
    }

    if (inFlightMs > SCREENSHOT_WARN_MS && Date.now() - lastHangWarnLoggedAt > 1000) {
      lastHangWarnLoggedAt = Date.now();
      hangWarningsIssued++;
      logTS(`WATCHDOG WARNING: screenshot has been in-flight for ${inFlightMs}ms so far (frame #${framesWritten})`);
    }
  }, 1000);
}

async function startTranscoding() {
  await startBrowser('initial startup');
  createAudioInputFile();
  scheduleBrowserRefresh();
  startWatchdog();

  // Give the PassThrough a modest, explicit buffer size. This is what makes
  // backpressure kick in quickly rather than silently buffering an
  // ever-growing backlog of frames in memory.
  ffmpegStream = new PassThrough({ highWaterMark: 1024 * 1024 * 4 }); // ~4MB
  ffmpegStream.on('drain', () => {
    canWrite = true;
  });

  const HLS_SEGMENT_SECONDS = 2;

  ffmpegProc = ffmpeg()
    .input(ffmpegStream)
    .inputFormat('image2pipe')
    .inputOptions([`-framerate ${FRAME_RATE}`])
    .input(path.join(__dirname,'audio_list.txt'))
    .inputOptions(['-f concat','-safe 0','-stream_loop -1','-vcodec png'])
    .complexFilter([`[0:v]scale=${VIEW_DIMENSIONS.width}:${VIEW_DIMENSIONS.height}[v]`,'[1:a]volume=0.5[a]'])
    .outputOptions(['-map [v]','-map [a]','-c:v libx264','-c:a aac','-b:a 128k','-preset ultrafast',`-g ${FRAME_RATE * HLS_SEGMENT_SECONDS}`,'-b:v 1000k','-f hls',`-hls_time ${HLS_SEGMENT_SECONDS}`,'-hls_list_size 2','-hls_flags delete_segments'])
    .output(HLS_FILE)
    .on('start',()=>{ logTS(`Started FFmpeg - Version ${VERSION}`); setTimeout(()=>isStreamReady=true,HLS_SETUP_DELAY); })
    .on('error', async err=>{ logTS(`FFmpeg error: ${err.message}`); await stopTranscoding(); startTranscoding(); })
    .on('end',()=>{ ffmpegProc=null; ffmpegStream=null; isStreamReady=false; });

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
        type:'png',
        clip:{ x:0, y:0, ...VIEW_DIMENSIONS } // crop top, right, and bottom based on your measurements
      });

      const elapsedMs = Date.now() - captureStartedAt;
      totalScreenshotMs += elapsedMs;
      if (elapsedMs > maxScreenshotMs) maxScreenshotMs = elapsedMs;

      const ok = ffmpegStream.write(screenshot);
      framesWritten++;
      if (!ok) canWrite = false; // wait for 'drain' before writing again

      // Every 5 minutes, log a quick health summary including average
      // screenshot duration, so we can watch it trend over the container's
      // lifetime.
      if (framesWritten % (FRAME_RATE * 60 * 5) === 0) {
        const avgMs = Math.round(totalScreenshotMs / framesWritten);
        logTS(`Health check: framesWritten=${framesWritten}, avgScreenshotMs=${avgMs}, maxScreenshotMs=${maxScreenshotMs}, skippedBackpressure=${framesSkippedBackpressure}, skippedOverlap=${framesSkippedOverlap}, skippedRestarting=${framesSkippedRestarting}, browserRestarts=${browserRestartCount}, hangWarnings=${hangWarningsIssued}, hangForcedRestarts=${hangForcedRestarts}`);
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
  if(watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval=null;
  if(ffmpegProc) ffmpegProc.kill('SIGINT'); ffmpegProc=null;
  if(browser) await browser.close().catch(()=>{}); browser=null;
}

app.get('/playlist.m3u',(req,res)=>{
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  const baseUrl = `http://${host}`;
  const m3uContent = `#EXTM3U
#EXTINF:-1 channel-id="weatherStar4000" tvg-id="weatherStar4000" tvg-channel-no="275" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`;
  res.set('Content-Type','application/x-mpegURL'); res.send(m3uContent);
});

app.get('/guide.xml',(req,res)=>{
  const host = req.headers.host || `localhost:${STREAM_PORT}`;
  res.set('Content-Type','application/xml'); res.send(generateXMLTV(host));
});

app.get('/health',(req,res)=>{
  const avgScreenshotMs = framesWritten > 0 ? Math.round(totalScreenshotMs / framesWritten) : 0;
  const currentlyStuckMs = (isCapturing && captureStartedAt) ? (Date.now() - captureStartedAt) : 0;
  res.status(isStreamReady?200:503).json({
    ready:isStreamReady,
    browserRestarts: browserRestartCount,
    framesWritten,
    framesSkippedBackpressure,
    framesSkippedOverlap,
    framesSkippedRestarting,
    avgScreenshotMs,
    maxScreenshotMs,
    hangWarningsIssued,
    hangForcedRestarts,
    currentlyStuckMs
  });
});

const { cpus, memoryMB } = getContainerLimits();
console.log(`Version ${VERSION} | Running with ${cpus} CPU cores, ${memoryMB}MB RAM`);

app.listen(STREAM_PORT, async ()=>{
  console.log(`Streaming server running on port ${STREAM_PORT}`);
  await startTranscoding();
});

process.on('SIGINT', async ()=>{ console.log('SIGINT received'); await stopTranscoding(); process.exit(); });
process.on('SIGTERM', async ()=>{ console.log('SIGTERM received'); await stopTranscoding(); process.exit(); });
