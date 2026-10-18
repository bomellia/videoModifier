// Packet-copy editing. No decoded video frames enter an encoder.
export const SPEEDS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const EPSILON = 0.00001;
const number = value => Number(value.toFixed(9)).toString();

export function nearestBoundary(value, boundaries) {
  return boundaries.reduce((best, point) =>
    Math.abs(point - value) < Math.abs(best - value) ? point : best);
}

export function parseKeyframes(text, duration) {
  const match = text.match(/^#tb 0:\s*(\d+)\/(\d+)/m);
  if (!match) throw new Error("この動画の時刻情報を解析できませんでした。");
  const timeBase = Number(match[1]) / Number(match[2]);
  const packets = text.split("\n").filter(line => /^0,/.test(line)).map(line => {
    const fields = line.split(",").map(field => Number(field.trim()));
    return { dts: fields[1] * timeBase, pts: fields[2] * timeBase };
  }).filter(packet => Number.isFinite(packet.pts) && Number.isFinite(packet.dts));
  const keys = [...new Set(packets.map(packet => packet.pts)
    .filter(time => time >= -EPSILON && time < duration - EPSILON)
    .map(time => Math.max(0, time)))].sort((a, b) => a - b);
  // MP4 edit lists can hide a preceding GOP at negative timestamps. Those
  // packets are necessary to decode time zero and must survive streamcopy.
  const hasPreroll = packets.some(packet => packet.pts < -EPSILON);
  if ((!keys.length || keys[0] > 0.05) && !hasPreroll) {
    throw new Error("先頭から安全に再生できるキーフレームが見つかりませんでした。");
  }
  if (hasPreroll && (!keys.length || keys[0] > EPSILON)) keys.unshift(0);
  else keys[0] = 0;
  return {
    boundaries: [...keys, duration],
    // Keep a common decoding lead at speed transitions, including B-frames.
    decodeLead: packets.reduce((lead, packet) => Math.max(lead, packet.pts - packet.dts), 0),
  };
}

export function validateSegments(segments, boundaries) {
  if (!segments.length) throw new Error("残す区間を追加してください。");
  if (segments.length > 100) throw new Error("区間は100個までにしてください。");
  const sorted = segments.map(segment => ({ ...segment })).sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const { start, end, speed } = sorted[i];
    if (![start, end, speed].every(Number.isFinite) || !SPEEDS.includes(speed) || end - start <= EPSILON) {
      throw new Error("区間の開始・終了時間と速度を確認してください。");
    }
    if (![start, end].every(time => boundaries.some(point => Math.abs(time - point) < EPSILON))) {
      throw new Error("カット位置をキーフレームに合わせてください。");
    }
    if (i && start < sorted[i - 1].end - EPSILON) throw new Error("区間が重なっています。");
  }
  return sorted;
}

export function outputDuration(segments) {
  return segments.reduce((total, segment) => total + (segment.end - segment.start) / segment.speed, 0);
}

export function outputTimeline(segments) {
  let cursor = 0;
  return segments.map(segment => {
    const duration = (segment.end - segment.start) / segment.speed;
    const start = cursor;
    cursor += duration;
    return { start, end: cursor, duration };
  });
}

export function mergeAdjacent(segments) {
  const result = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    if (previous && previous.speed === segment.speed && Math.abs(previous.end - segment.start) < EPSILON) {
      previous.end = segment.end;
    } else result.push({ ...segment });
  }
  return result;
}

export function audioFilter(segments) {
  const filters = segments.map(({ start, end, speed }, i) => {
    // atempo > 2 can skip samples. Chain factors of 2 instead.
    const tempos = [];
    let remaining = speed;
    while (remaining > 2) {
      tempos.push(2);
      remaining /= 2;
    }
    tempos.push(remaining);
    const length = number((end - start) / speed);
    // Preserve delayed audio and pad short tracks before trimming each range.
    return `[0:a:0]aresample=async=1:first_pts=0,apad,atrim=start=${number(start)}:end=${number(end)},asetpts=PTS-STARTPTS,` +
      tempos.map(tempo => `atempo=${tempo}`).join(",") +
      `,apad,atrim=duration=${length},asetpts=PTS-STARTPTS[a${i}]`;
  });
  filters.push(segments.map((_, i) => `[a${i}]`).join("") + `concat=n=${segments.length}:v=0:a=1[aout]`);
  return filters.join(";");
}

export class CopyEditor {
  constructor(ffmpeg, update = () => {}) {
    this.ffmpeg = ffmpeg;
    this.update = update;
    this.logs = [];
    this.ffmpeg.on("log", ({ message }) => {
      this.logs.push(message);
      if (this.logs.length > 80) this.logs.shift();
    });
    this.info = null;
  }

  async run(args) {
    this.logs = [];
    const code = await this.ffmpeg.exec(["-hide_banner", "-y", ...args]);
    if (code !== 0) {
      console.error(this.logs.join("\n"));
      throw new Error("動画処理に失敗しました。この動画の形式は対応していない可能性があります。");
    }
    if (this.logs.some(line => /Non-monotonous DTS|non monotonically|pts .* < dts/i.test(line))) {
      console.error(this.logs.join("\n"));
      throw new Error("区間の接続時に時刻の不整合を検出しました。この動画では高速書き出しを利用できません。");
    }
  }

  async remove(paths) {
    for (const path of paths) {
      try { await this.ffmpeg.deleteFile(path); } catch { /* Already absent. */ }
    }
  }

  async prepare(file, duration) {
    this.info = null;
    await this.remove(["source.bin", "keys.txt", "output.mp4"]);
    this.update("動画を読み込み中…");
    try {
      await this.ffmpeg.writeFile("source.bin", new Uint8Array(await file.arrayBuffer()));
      this.update("カット位置を解析中…（映像の再圧縮は行いません）");
      await this.run(["-i", "source.bin", "-map", "0:v:0", "-an", "-c:v", "copy",
        "-bsf:v", "noise=drop=not(key)", "-f", "framecrc", "keys.txt"]);
      const hasAudio = this.logs.some(line => /Stream #0:\d+.*Audio:/.test(line));
      const sourceRotation = Number(this.logs.join("\n").match(/displaymatrix: rotation of ([\d.+-]+) degrees/)?.[1] || 0);
      this.info = { ...parseKeyframes(await this.ffmpeg.readFile("keys.txt", "utf8"), duration), hasAudio, duration, sourceRotation };
      return this.info;
    } catch (error) {
      await this.remove(["source.bin"]);
      throw error;
    } finally {
      await this.remove(["keys.txt"]);
    }
  }

  async export(segments, { mute = false, rotation = 0 } = {}) {
    if (!this.info) throw new Error("動画を読み込んでください。");
    const plan = mergeAdjacent(validateSegments(segments, this.info.boundaries));
    const speedChanged = plan.some(segment => segment.speed !== 1);
    const hasAudio = this.info.hasAudio && !mute;
    const transcodeAudio = hasAudio && speedChanged;
    const lead = this.info.decodeLead / Math.min(...plan.map(segment => segment.speed));
    const temporary = ["join.txt", "audio.m4a", "output.mp4"];
    // MP4's positive rotation is counterclockwise; the UI uses clockwise.
    const metadata = ["-metadata:s:v:0", `rotate=${this.info.sourceRotation - rotation}`];
    try {
      // A single ordinary trim remains one remux, just like the original app.
      if (plan.length === 1 && !speedChanged) {
        const { start, end } = plan[0];
        this.update("映像・音声をコピー中…");
        await this.run(["-ss", number(start), "-t", number(end - start), "-i", "source.bin",
          "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : ["-an"]), "-c", "copy",
          "-bsf:v", `noise=drop=gte(pts*tb\\,${number(end - start)})`, ...metadata, "output.mp4"]);
        return new Blob([await this.ffmpeg.readFile("output.mp4")], { type: "video/mp4" });
      }
      const files = [];
      for (const [i, { start, end, speed }] of plan.entries()) {
        this.update(`映像をコピー中… ${i + 1} / ${plan.length}`);
        const path = `part-${i}.mp4`;
        files.push(path);
        temporary.push(path);
        const duration = number(end - start);
        const args = ["-ss", number(start), "-t", duration, "-i", "source.bin", "-map", "0:v:0"];
        if (hasAudio && !transcodeAudio) args.push("-map", "0:a:0", "-c:a", "copy",
          "-bsf:a", `noise=drop=lt(pts*tb\\,0)+gt((pts+duration)*tb\\,${duration})`);
        else args.push("-an");
        // Drop trailing packets read ahead for B-frame decoding. Keep PTS and
        // DTS separate: setting both to DTS would corrupt B-frame timing.
        const filter = `noise=drop=gte(pts*tb\\,${duration}),` +
          `setts=pts=PTS/${speed}:dts=(DTS-STARTDTS+STARTPTS)/${speed}-${number(lead)}/TB:duration=DURATION/${speed}`;
        args.push("-c:v", "copy", "-bsf:v", filter, ...metadata, path);
        await this.run(args);
      }

      if (transcodeAudio) {
        this.update("音声の速度を調整中…（声の高さを維持）");
        await this.run(["-i", "source.bin", "-filter_complex", audioFilter(plan), "-map", "[aout]",
          "-vn", "-c:a", "aac", "-b:a", "160k", "audio.m4a"]);
      }
      const list = "ffconcat version 1.0\n" + files.map((path, i) =>
        `file '${path}'\nduration ${number((plan[i].end - plan[i].start) / plan[i].speed)}\n`).join("");
      await this.ffmpeg.writeFile("join.txt", new TextEncoder().encode(list));
      this.update("MP4にまとめています…");
      // Every part comes from the same source/extradata. Avoid unnecessary
      // H.264 Annex-B conversion (and repeated SPS/PPS injection) by concat.
      const args = ["-f", "concat", "-safe", "0", "-auto_convert", "0", "-i", "join.txt"];
      if (transcodeAudio) args.push("-i", "audio.m4a", "-map", "0:v:0", "-map", "1:a:0");
      else args.push("-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : ["-an"]));
      args.push("-c", "copy", ...metadata, "output.mp4");
      await this.run(args);
      const data = await this.ffmpeg.readFile("output.mp4");
      return new Blob([data], { type: "video/mp4" });
    } finally {
      await this.remove(temporary);
    }
  }
}
