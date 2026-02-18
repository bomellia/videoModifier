import { FFmpeg } from "./lib/index.js";
import { fetchFile } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js";

const ffmpeg = new FFmpeg({ log: true });

const fileInput = document.getElementById("fileInput");
const video = document.getElementById("video");
const start = document.getElementById("start");
const end = document.getElementById("end");
const startVal = document.getElementById("startVal");
const endVal = document.getElementById("endVal");
const trimBtn = document.getElementById("trim");
const status = document.getElementById("status");
const download = document.getElementById("download");

let file = null;
let ffmpegLoaded = false;

/* 動画選択 */
fileInput.onchange = (e) => {
  file = e.target.files[0];
  if (!file) return;

  video.src = URL.createObjectURL(file);

  video.onloadedmetadata = () => {
    start.max = video.duration;
    end.max = video.duration;
    end.value = video.duration;

    startVal.textContent = "0";
    endVal.textContent = video.duration.toFixed(2);

    trimBtn.disabled = false;
  };
};

/* スライダー表示更新 */
start.oninput = () => {
  if (+start.value >= +end.value) {
    start.value = end.value - 0.1;
  }
  startVal.textContent = (+start.value).toFixed(2);
};

end.oninput = () => {
  if (+end.value <= +start.value) {
    end.value = +start.value + 0.1;
  }
  endVal.textContent = (+end.value).toFixed(2);
};

/* FFmpegロード */
async function loadFFmpeg() {
  if (ffmpegLoaded) return;

  status.textContent = "FFmpegロード中...";

  await ffmpeg.load({
    classWorkerURL: new URL('./lib/worker.js', import.meta.url).href,
    coreURL: new URL('./lib/ffmpeg-core.js', import.meta.url).href,
    wasmURL: new URL('./lib/ffmpeg-core.wasm', import.meta.url).href
  });

  ffmpegLoaded = true;
}

/* トリミング処理 */
trimBtn.onclick = async () => {
  if (!file) return;

  trimBtn.disabled = true;

  try {
    await loadFFmpeg();

    status.textContent = "動画処理中...";

    await ffmpeg.writeFile("input.mp4", await fetchFile(file));

    await ffmpeg.exec([
      "-ss", start.value,
      "-to", end.value,
      "-i", "input.mp4",
      "-c", "copy",
      "out.mp4"
    ]);

    const data = await ffmpeg.readFile("out.mp4");
    const blob = new Blob([data.buffer], { type: "video/mp4" });

    download.href = URL.createObjectURL(blob);
    download.download = "trimmed.mp4";
    download.textContent = "ダウンロード";
    download.style.display = "block";

    status.textContent = "完了";
  } catch (err) {
    console.error(err);
    status.textContent = "エラーが発生しました";
  }

  trimBtn.disabled = false;
};
