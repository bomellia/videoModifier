import { FFmpeg } from '/node_modules/@ffmpeg/ffmpeg/dist/esm/index.js';
import { fetchFile } from '/node_modules/@ffmpeg/util/dist/esm/index.js';

document.addEventListener('DOMContentLoaded', async () => {
  const ffmpeg = new FFmpeg();

  const fileInput = document.getElementById("fileInput");
  const video = document.getElementById("video");
  const startRange = document.getElementById("startRange");
  const endRange = document.getElementById("endRange");
  const startVal = document.getElementById("startVal");
  const endVal = document.getElementById("endVal");
  const trimBtn = document.getElementById("trimBtn");
  const progress = document.getElementById("progress");
  const downloadLink = document.getElementById("downloadLink");

  let currentFile = null;

  fileInput.addEventListener("change", (e) => {
    currentFile = e.target.files[0];
    if (!currentFile) return;

    const url = URL.createObjectURL(currentFile);
    video.src = url;
    video.load();

    video.onloadedmetadata = () => {
      const duration = video.duration;

      startRange.max = duration;
      endRange.max = duration;
      endRange.value = duration;

      startVal.textContent = "0";
      endVal.textContent = duration.toFixed(2);

      trimBtn.disabled = false;
    };

    video.onerror = (err) => {
      console.error("Video load error:", err);
      alert("動画を読み込めません。コーデック非対応の可能性があります。");
    };
  });

  startRange.addEventListener("input", () => {
    if (+startRange.value >= +endRange.value) {
      startRange.value = endRange.value - 0.1;
    }
    startVal.textContent = (+startRange.value).toFixed(2);
  });

  endRange.addEventListener("input", () => {
    if (+endRange.value <= +startRange.value) {
      endRange.value = +startRange.value + 0.1;
    }
    endVal.textContent = (+endRange.value).toFixed(2);
  });

  trimBtn.addEventListener("click", async () => {
    if (!currentFile) return;

    try {
      progress.textContent = "FFmpegロード中...";
      trimBtn.disabled = true;

      if (!ffmpeg.loaded) {
        await ffmpeg.load();
      }

      progress.textContent = "動画処理中...";

      await ffmpeg.writeFile("input.mp4", await fetchFile(currentFile));

      const start = startRange.value;
      const end = endRange.value;

      await ffmpeg.exec([
        "-ss", start,
        "-to", end,
        "-i", "input.mp4",
        "-c", "copy",
        "output.mp4"
      ]);

      const data = await ffmpeg.readFile("output.mp4");

      const blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      downloadLink.href = url;
      downloadLink.download = "trimmed.mp4";
      downloadLink.style.display = "block";
      downloadLink.textContent = "トリミング動画をダウンロード";

      progress.textContent = "完了";
    } catch (e) {
      console.error(e);
      progress.textContent = "エラー発生。Consoleを確認してください。";
    }

    trimBtn.disabled = false;
  });
});