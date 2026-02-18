import { FFmpeg } from "./lib/index.js";
import { fetchFile } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";

const ffmpeg = new FFmpeg({ log: true });

// DOM要素の取得
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const video = document.getElementById("video");
const start = document.getElementById("start");
const end = document.getElementById("end");
const startVal = document.getElementById("startVal");
const endVal = document.getElementById("endVal");
const fpsEnable = document.getElementById("fpsEnable");
const fpsValue = document.getElementById("fpsValue");
const fpsDisplay = document.getElementById("fpsDisplay");
const speed = document.getElementById("speed");
const speedDisplay = document.getElementById("speedDisplay");
const fadeInEnable = document.getElementById("fadeInEnable");
const fadeInDuration = document.getElementById("fadeInDuration");
const fadeOutEnable = document.getElementById("fadeOutEnable");
const fadeOutDuration = document.getElementById("fadeOutDuration");
const convertBtn = document.getElementById("convert");
const status = document.getElementById("status");
const download = document.getElementById("download");
const presetBtns = document.querySelectorAll(".preset-btn");

let file = null;
let ffmpegLoaded = false;
let videoDuration = 0;
let hasChanges = false;

// 秒を "mm:ss:ms" 形式に変換
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, "0")}:${ms.toString().padStart(2, "0")}`;
}

// 変更状態を更新
function updateChanges() {
  hasChanges = true;
  download.style.display = "none";
  convertBtn.disabled = false;
}

// 動画選択
fileInput.onchange = (e) => {
  file = e.target.files[0];
  if (!file) return;

  fileName.textContent = file.name;
  video.src = URL.createObjectURL(file);

  video.onloadedmetadata = () => {
    videoDuration = video.duration;
    start.max = videoDuration;
    end.max = videoDuration;
    end.value = videoDuration;

    startVal.textContent = formatTime(0);
    endVal.textContent = formatTime(videoDuration);

    convertBtn.disabled = false;
    status.textContent = "";
    status.classList.remove("loading", "success", "error");
    hasChanges = false;
    download.style.display = "none";
  };
};

// 開始時間スライダー
start.oninput = () => {
  if (+start.value >= +end.value) {
    start.value = end.value - 0.1;
  }
  startVal.textContent = formatTime(+start.value);
  updateChanges();
};

// 終了時間スライダー
end.oninput = () => {
  if (+end.value <= +start.value) {
    end.value = +start.value + 0.1;
  }
  endVal.textContent = formatTime(+end.value);
  updateChanges();
};

// フレームレート設定
fpsEnable.onchange = () => {
  fpsValue.disabled = !fpsEnable.checked;
  updateChanges();
  updateFpsDisplay();
};

fpsValue.oninput = () => {
  updateChanges();
  updateFpsDisplay();
};

function updateFpsDisplay() {
  if (fpsEnable.checked) {
    fpsDisplay.textContent = fpsValue.value + " fps";
  } else {
    fpsDisplay.textContent = "元動画のまま";
  }
}

// 倍速設定
speed.oninput = () => {
  const speedValue = parseFloat(speed.value).toFixed(2);
  speedDisplay.textContent = speedValue + "x";
  updateChanges();
  updatePresetButtons();
};

presetBtns.forEach((btn) => {
  btn.onclick = () => {
    const speedValue = btn.dataset.speed;
    speed.value = speedValue;
    const speedDisplay_val = parseFloat(speedValue).toFixed(2);
    speedDisplay.textContent = speedDisplay_val + "x";
    updateChanges();
    updatePresetButtons();
  };
});

function updatePresetButtons() {
  const currentSpeed = parseFloat(speed.value).toFixed(2);
  presetBtns.forEach((btn) => {
    const btnSpeed = parseFloat(btn.dataset.speed).toFixed(2);
    if (btnSpeed === currentSpeed) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

// オーディオ設定
fadeInEnable.onchange = () => {
  fadeInDuration.disabled = !fadeInEnable.checked;
  updateChanges();
};

fadeOutEnable.onchange = () => {
  fadeOutDuration.disabled = !fadeOutEnable.checked;
  updateChanges();
};

fadeInDuration.oninput = updateChanges;
fadeOutDuration.oninput = updateChanges;

// FFmpegロード
async function loadFFmpeg() {
  if (ffmpegLoaded) return;

  status.textContent = "FFmpegロード中...";
  status.classList.add("loading");

  await ffmpeg.load({
    classWorkerURL: new URL('./lib/worker.js', import.meta.url).href,
    coreURL: new URL('./lib/ffmpeg-core.js', import.meta.url).href,
    wasmURL: new URL('./lib/ffmpeg-core.wasm', import.meta.url).href
  });

  ffmpegLoaded = true;
}

// 動画変換処理
convertBtn.onclick = async () => {
  if (!file) return;

  convertBtn.disabled = true;
  status.classList.remove("loading", "success", "error");

  try {
    await loadFFmpeg();

    status.textContent = "動画処理中...";
    status.classList.add("loading");

    // FFmpegコマンドの構築
    const args = [
      "-ss", start.value.toString(),
      "-to", end.value.toString(),
      "-i", "input.mp4"
    ];

    // ビデオフィルタの構築
    let videoFilters = [];
    let audioFilters = [];

    // フレームレート変更
    if (fpsEnable.checked) {
      const fps = fpsValue.value;
      videoFilters.push(`fps=${fps}`);
    }

    // 倍速変更
    const speedValue = parseFloat(speed.value);
    if (speedValue !== 1) {
      videoFilters.push(`setpts=PTS/${speedValue}`);
    }

    // フェードイン・アウト
    if (fadeInEnable.checked || fadeOutEnable.checked) {
      if (fadeInEnable.checked) {
        const fadeInDur = parseFloat(fadeInDuration.value);
        audioFilters.push(`afade=t=in:st=0:d=${fadeInDur}`);
      }

      if (fadeOutEnable.checked) {
        const fadeOutDur = parseFloat(fadeOutDuration.value);
        const startTime = Math.max(0, (end.value - start.value) - fadeOutDur);
        audioFilters.push(`afade=t=out:st=${startTime}:d=${fadeOutDur}`);
      }
    }

    // 倍速のオーディオ処理
    if (speedValue !== 1) {
      audioFilters.push(`atempo=${speedValue}`);
    }

    // フィルタが何も指定されていない場合は、高速コピーモード
    const hasFilters = videoFilters.length > 0 || audioFilters.length > 0;

    if (videoFilters.length > 0) {
      args.push("-vf", videoFilters.join(","));
    }

    if (audioFilters.length > 0) {
      args.push("-af", audioFilters.join(","));
    }

    // コーデック設定 - フィルタがなければコピー（高速）、あればエンコード
    if (hasFilters) {
      args.push("-c:v", "libx264", "-preset", "fast", "-c:a", "aac");
    } else {
      args.push("-c", "copy");
    }

    args.push("out.mp4");

    args.push("out.mp4");

    await ffmpeg.writeFile("input.mp4", await fetchFile(file));
    await ffmpeg.exec(args);

    const data = await ffmpeg.readFile("out.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });

    download.href = URL.createObjectURL(blob);
    download.download = "converted.mp4";
    download.textContent = "⬇️ ダウンロード";
    download.style.display = "inline-block";

    status.textContent = "✓ 完了";
    status.classList.remove("loading");
    status.classList.add("success");
    hasChanges = false;
  } catch (err) {
    console.error(err);
    status.textContent = "✕ エラーが発生しました";
    status.classList.remove("loading");
    status.classList.add("error");
  }

  convertBtn.disabled = false;
};
