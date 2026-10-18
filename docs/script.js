import { FFmpeg } from "./lib/index.js";
import { CopyEditor, nearestBoundary, outputDuration, outputTimeline, validateSegments } from "./editor.js";

const $ = id => document.getElementById(id);
const video = $("video");
const ffmpeg = new FFmpeg();
const editor = new CopyEditor(ffmpeg, message => setStatus(message, "loading"));
let info = null;
let segments = [];
let selected = 0;
let busy = false;
let sourceURL = null;
let downloadURL = null;
let fileStem = "edited";
let previewing = false;
let previewIndex = 0;
let previewFrame = null;
let rotation = 0;

function fitVideo() {
  const box = video.parentElement;
  const sideways = rotation % 180 !== 0;
  const width = sideways ? video.offsetHeight : video.offsetWidth;
  const height = sideways ? video.offsetWidth : video.offsetHeight;
  const scale = width && height ? Math.min(1, box.clientWidth / width, box.clientHeight / height) : 1;
  video.style.transform = `rotate(${rotation}deg) scale(${scale})`;
}
new ResizeObserver(fitVideo).observe(video.parentElement);
video.addEventListener("loadedmetadata", fitVideo);

function formatTime(seconds) {
  const centis = Math.round(seconds * 100);
  return `${Math.floor(centis / 6000)}:${String(Math.floor(centis / 100) % 60).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`;
}

function setStatus(message, kind = "") {
  $("status").textContent = message;
  $("status").className = kind;
}

function invalidateDownload() {
  $("download").hidden = true;
  $("download").removeAttribute("href");
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null;
}

function controls() {
  const available = Boolean(info) && !busy;
  const hasSelection = available && Boolean(segments[selected]);
  $("fileInput").disabled = busy;
  for (const id of ["start", "end", "speed", "split"]) $(id).disabled = !hasSelection || previewing;
  for (const id of ["add", "audio"]) $(id).disabled = !available || previewing;
  for (const id of ["trim", "preview"]) $(id).disabled = !available || !segments.length;
  $("trim").disabled ||= previewing;
  document.querySelectorAll(".rotate-btn").forEach(button => { button.disabled = !available || previewing; });
  $("segments").querySelectorAll("button").forEach(button => { button.disabled = busy || previewing; });
}

function render() {
  const container = $("segments");
  container.replaceChildren();
  const timeline = outputTimeline(segments);
  segments.forEach((segment, i) => {
    const row = document.createElement("div");
    row.className = `segment-row${i === selected ? " selected" : ""}`;
    const choose = document.createElement("button");
    choose.className = "segment-select";
    const source = document.createElement("span");
    source.className = "segment-source";
    source.textContent = `${i + 1}. 元動画 ${formatTime(segment.start)} → ${formatTime(segment.end)}　${segment.speed}倍`;
    const edited = document.createElement("span");
    edited.className = "segment-output";
    edited.textContent = `編集後 ${formatTime(timeline[i].start)} → ${formatTime(timeline[i].end)} ／ 長さ ${formatTime(timeline[i].duration)}`;
    choose.append(source, edited);
    choose.setAttribute("aria-pressed", String(i === selected));
    choose.onclick = () => {
      selected = i;
      video.currentTime = segment.start;
      video.playbackRate = segment.speed;
      render();
    };
    const remove = document.createElement("button");
    remove.className = "remove-segment";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", `区間${i + 1}を削除`);
    remove.onclick = () => {
      segments.splice(i, 1);
      selected = Math.max(0, Math.min(selected, segments.length - 1));
      invalidateDownload();
      render();
    };
    row.append(choose, remove);
    container.append(row);
  });
  const segment = segments[selected];
  if (segment) {
    $("start").max = $("end").max = info.duration;
    $("start").value = segment.start;
    $("end").value = segment.end;
    $("startVal").textContent = formatTime(segment.start);
    $("endVal").textContent = formatTime(segment.end);
    $("speed").value = segment.speed;
    video.playbackRate = segment.speed;
  } else {
    $("startVal").textContent = $("endVal").textContent = "—";
  }
  $("summary").textContent = info
    ? `${segments.length}区間 ／ 書き出し後 ${formatTime(outputDuration(segments))} ／ 元動画 ${formatTime(info.duration)}`
    : "動画を選択してください。";
  controls();
}

function stopPreview() {
  previewing = false;
  cancelAnimationFrame(previewFrame);
  video.pause();
  video.playbackRate = segments[selected]?.speed || 1;
  $("preview").textContent = "編集結果をプレビュー";
  controls();
}

function tickPreview() {
  if (!previewing) return;
  const segment = segments[previewIndex];
  if (!video.seeking && (video.currentTime >= segment.end || video.ended)) {
    previewIndex++;
    if (previewIndex >= segments.length) { stopPreview(); return; }
    video.currentTime = segments[previewIndex].start;
    video.playbackRate = segments[previewIndex].speed;
    video.play().catch(error => { stopPreview(); setStatus(error.message, "error"); });
  }
  previewFrame = requestAnimationFrame(tickPreview);
}

$("preview").onclick = async () => {
  if (previewing) { stopPreview(); return; }
  try {
    validateSegments(segments, info.boundaries);
    previewing = true;
    previewIndex = 0;
    video.currentTime = segments[0].start;
    video.playbackRate = segments[0].speed;
    $("preview").textContent = "プレビュー停止";
    controls();
    await video.play();
    tickPreview();
  } catch (error) { stopPreview(); setStatus(error.message, "error"); }
};

$("fileInput").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  stopPreview();
  invalidateDownload();
  info = null;
  segments = [];
  busy = true;
  render();
  $("fileName").textContent = file.name;
  fileStem = file.name.replace(/\.[^.]+$/, "") || "edited";
  rotation = 0;
  document.querySelectorAll(".rotate-btn").forEach(button => button.classList.toggle("active", button.dataset.rotate === "0"));
  $("rotateDisplay").textContent = "なし";
  video.style.transform = "";
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  try {
    setStatus("動画を確認中…", "loading");
    if (file.size > 1024 ** 3) throw new Error("メモリ使用量を抑えるため、1GB以下の動画を選択してください。");
    const metadata = new Promise((resolve, reject) => {
      const clean = () => { video.onloadedmetadata = null; video.onerror = null; clearTimeout(timer); };
      const timer = setTimeout(() => { clean(); reject(new Error("動画の読み込みがタイムアウトしました。")); }, 30000);
      video.onloadedmetadata = () => { clean(); resolve(); };
      video.onerror = () => { clean(); reject(new Error("このブラウザでは動画を読み込めません。別の形式の動画を選んでください。")); };
    });
    sourceURL = URL.createObjectURL(file);
    video.src = sourceURL;
    video.load();
    await metadata;
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("動画の長さを取得できませんでした。");
    if (!ffmpeg.loaded) {
      setStatus("FFmpegをロード中…", "loading");
      await ffmpeg.load({
        classWorkerURL: new URL("./lib/worker.js", import.meta.url).href,
        coreURL: new URL("./lib/ffmpeg-core.js", import.meta.url).href,
        wasmURL: new URL("./lib/ffmpeg-core.wasm", import.meta.url).href,
      });
    }
    info = await editor.prepare(file, video.duration);
    segments = [{ start: 0, end: info.duration, speed: 1 }];
    selected = 0;
    $("audioHint").textContent = info.hasAudio ? "音声付きの倍速では、音声の変換時間が加わります。" : "この動画に音声はありません。";
    setStatus(`準備完了。${info.boundaries.length - 1}個のカット開始位置が見つかりました。`, "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), "error");
    info = null;
  } finally {
    busy = false;
    render();
    event.target.value = "";
  }
};

for (const side of ["start", "end"]) {
  $(side).oninput = () => { $(side + "Val").textContent = formatTime(Number($(side).value)); };
  $(side).onchange = () => {
    const segment = segments[selected];
    if (!segment || busy) return;
    const value = nearestBoundary(Number($(side).value), info.boundaries);
    const candidate = { ...segment, [side]: value };
    try {
      validateSegments(segments.map((item, i) => i === selected ? candidate : item), info.boundaries);
      segments[selected] = candidate;
      segments.sort((a, b) => a.start - b.start);
      selected = segments.indexOf(candidate);
      video.currentTime = side === "start" ? value : Math.max(candidate.start, value - 0.1);
      invalidateDownload();
      setStatus(`カット位置を ${formatTime(value)} に調整しました。`);
    } catch (error) { setStatus(error.message, "error"); }
    render();
  };
}

$("speed").onchange = () => {
  if (!segments[selected] || busy) return;
  segments[selected].speed = Number($("speed").value);
  invalidateDownload();
  render();
};

$("split").onclick = () => {
  const segment = segments[selected];
  if (!segment) return;
  const point = nearestBoundary(video.currentTime, info.boundaries);
  if (point <= segment.start || point >= segment.end) {
    setStatus("選択区間の内側にあるカット位置へ移動してから分割してください。", "error");
    return;
  }
  if (segments.length >= 100) { setStatus("区間は100個までにしてください。", "error"); return; }
  segments.splice(selected, 1, { ...segment, end: point }, { ...segment, start: point });
  selected++;
  invalidateDownload();
  setStatus(`${formatTime(point)} で分割しました。`);
  render();
};

$("add").onclick = () => {
  if (!info) return;
  let cursor = 0;
  let gap = null;
  for (const segment of segments) {
    if (segment.start - cursor > 0.00001) { gap = { start: cursor, end: segment.start, speed: 1 }; break; }
    cursor = segment.end;
  }
  if (!gap && info.duration - cursor > 0.00001) gap = { start: cursor, end: info.duration, speed: 1 };
  if (!gap) { setStatus("削除されている区間はありません。まず分割や時間の調整で区間を作成してください。"); return; }
  if (segments.length >= 100) { setStatus("区間は100個までにしてください。", "error"); return; }
  segments.push(gap);
  segments.sort((a, b) => a.start - b.start);
  selected = segments.indexOf(gap);
  video.currentTime = gap.start;
  invalidateDownload();
  render();
};

document.querySelectorAll(".rotate-btn").forEach(button => {
  button.onclick = () => {
    rotation = Number(button.dataset.rotate) * 90;
    document.querySelectorAll(".rotate-btn").forEach(item => item.classList.toggle("active", item === button));
    $("rotateDisplay").textContent = rotation ? `${rotation}°` : "なし";
    fitVideo();
    invalidateDownload();
  };
});
document.querySelector('.rotate-btn[data-rotate="0"]').classList.add("active");
$("audio").onchange = () => { video.muted = $("audio").value === "mute"; invalidateDownload(); };

$("trim").onclick = async () => {
  if (busy || !info) return;
  stopPreview();
  busy = true;
  invalidateDownload();
  controls();
  const started = performance.now();
  try {
    const blob = await editor.export(segments, { mute: $("audio").value === "mute", rotation });
    downloadURL = URL.createObjectURL(blob);
    $("download").href = downloadURL;
    $("download").download = `${fileStem}-edited.mp4`;
    $("download").hidden = false;
    setStatus(`✓ 完了（${((performance.now() - started) / 1000).toFixed(1)}秒）`, "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "書き出しに失敗しました。", "error");
  } finally { busy = false; controls(); }
};

window.addEventListener("pagehide", () => {
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  if (downloadURL) URL.revokeObjectURL(downloadURL);
});
controls();
