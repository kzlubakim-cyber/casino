const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

// Основной шрифт задаём ПО ИМЕНИ (не по файлу) — libass резолвит через fontconfig,
// а для эмодзи автоматически подставит Noto Color Emoji.
const MAIN_FONT = 'DejaVu Sans';
const FONTS_DIR = '/usr/share/fonts';

const W = 900;
const H = 1600;
const FPS = 30;

const BROWN = '2E2320';   // hex без # (тёмный)
const GREEN = '1E7A1E';

const DEFAULT_FONT = 60;

app.get('/health', (req, res) => res.json({ ok: true }));

// --- перенос строк ---
// Уважает явные переносы \n из payload (каждый \n -> новая визуальная строка),
// а внутри каждой строки дополнительно переносит по количеству символов.
function wrap(text, maxChars) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const paragraphs = raw.split('\n');
  const lines = [];
  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (const w of words) {
      if (!cur) { cur = w; continue; }
      if ((cur + ' ' + w).length <= maxChars) { cur += ' ' + w; }
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

// --- экранирование текста для .ass ---
function assEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, ' ');
}

// секунды -> H:MM:SS.CC
function secToAss(s) {
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let sec = s - h * 3600 - m * 60;
  let whole = Math.floor(sec);
  let cc = Math.round((sec - whole) * 100);
  if (cc === 100) { cc = 0; whole += 1; }
  const pad = (n) => String(n).padStart(2, '0');
  return h + ':' + pad(m) + ':' + pad(whole) + '.' + pad(cc);
}

// hex 'RRGGBB' -> ASS '&H00BBGGRR&'
function assColor(hex) {
  const c = String(hex).replace(/^#/, '').replace(/^0x/i, '');
  const r = c.substring(0, 2), g = c.substring(2, 4), b = c.substring(4, 6);
  return '&H00' + b + g + r + '&';
}

// Разворачивает один блок текста в массив строк Dialogue (по одной на визуальную строку)
function assDialoguesForBlock({ start, end, textLines, fontsize, colorHex, cx, cy, lineFactor }) {
  const lineH = Math.round(fontsize * (lineFactor || 1.28));
  const n = textLines.length;
  const startCy = cy - ((n - 1) * lineH) / 2;
  const col = assColor(colorHex);
  const st = secToAss(start);
  const en = secToAss(end);
  const x = Math.round(cx != null ? cx : W / 2);

  return textLines.map((ln, i) => {
    const yc = Math.round(startCy + i * lineH);
    const ov =
      '{\\an5\\pos(' + x + ',' + yc + ')' +
      '\\fs' + fontsize +
      '\\1c' + col +
      '\\3c&H00FFFFFF&\\bord3\\b1}';
    return 'Dialogue: 0,' + st + ',' + en + ',Default,,0,0,0,,' + ov + assEsc(ln);
  });
}

function buildAss(events) {
  const header =
    '[Script Info]\n' +
    'ScriptType: v4.00+\n' +
    'PlayResX: ' + W + '\n' +
    'PlayResY: ' + H + '\n' +
    'WrapStyle: 2\n' +
    'ScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Bold, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Default,' + MAIN_FONT + ',' + DEFAULT_FONT + ',' + assColor(BROWN) + ',&H00FFFFFF&,1,3,0,1,5,0,0,0,1\n\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

  const lines = [];
  for (const ev of events) {
    lines.push(...assDialoguesForBlock(ev));
  }
  return header + lines.join('\n') + '\n';
}

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'topleft', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]),
  (req, res) => {
    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); }
    catch (e) { return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

    const f = req.files || {};
    const need = ['fon', 'topleft', 'item', 'transport'];
    for (const k of need) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'MISSING_FILE', field: k });
    }
    const hasAudioFile = !!(f.audio && f.audio[0]);

    const duration = Number(payload.duration) || Number((payload.timings || {}).duration) || 15;

    // === громкость аудио (0..1), из payload.audioVolume или payload.volume ===
    const audioVolume = (typeof payload.audioVolume === 'number') ? payload.audioVolume
      : (typeof payload.volume === 'number') ? payload.volume
      : 0.1;

    // === стиль и габариты рамки ===
    const style = payload.style || {};
    const box = payload.box || {};
    const baseFont = Number(style.fontSize) || DEFAULT_FONT;
    const lineFactor = Number(style.lineSpacing) || 1.28;
    const baseHex = style.textColor ? String(style.textColor).replace(/^#/, '') : BROWN;

    // центр рамки (позиция "middle")
    const middleCy = (box.y != null && box.height != null)
      ? Math.round(Number(box.y) + Number(box.height) / 2)
      : Math.round(H / 2);
    // верх рамки (позиция "top")
    const topCy = (box.y != null)
      ? Math.round(Number(box.y) + baseFont * 1.2)
      : Math.round(H * 0.18);

    const wrapFor = (fontsize) => (box.width != null)
      ? Math.max(8, Math.floor(Number(box.width) / (fontsize * 0.55)))
      : 20;

    const cyFor = (position) => (String(position) === 'top' ? topCy : middleCy);

    // === СОБЫТИЯ ДЛЯ .ASS ===
    const events = [];

    // Предпочитаем массив segments из payload; иначе собираем из timings + полей.
    let segments = Array.isArray(payload.segments) ? payload.segments : null;

    if (!segments) {
      const t = payload.timings || {};
      segments = [
        { text: payload.hook,      start: t.hook_start,      end: t.hook_end,      position: 'middle' },
        { text: payload.bet_open,  start: t.bet_open_start,  end: t.bet_open_end,  position: 'middle' },
        { text: payload.bet_close, start: t.bet_close_start, end: t.bet_close_end, position: 'middle' },
        { text: payload.support,   start: t.support_start,   end: t.support_end,   position: 'top' },
      ];
    }

    for (const seg of segments) {
      if (!seg || seg.text == null || String(seg.text).trim() === '') continue;
      const fontsize = Number(seg.fontSize) || baseFont;
      const start = Number(seg.start) || 0;
      const end = Number(seg.end != null ? seg.end : duration);

      // горизонталь: seg.x / seg.posX, иначе центр кадра
      const cx = (seg.x != null) ? Number(seg.x)
        : (seg.posX != null) ? Number(seg.posX)
        : Math.round(W / 2);

      // вертикаль: seg.y / seg.posY, иначе старая логика по position
      const cy = (seg.y != null) ? Math.round(Number(seg.y))
        : (seg.posY != null) ? Math.round(Number(seg.posY))
        : cyFor(seg.position);

      events.push({
        start,
        end,
        textLines: wrap(seg.text, wrapFor(fontsize)),
        fontsize,
        colorHex: baseHex,
        cx,
        cy,
        lineFactor,
      });
    }

    const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');
    const assPath = path.join(os.tmpdir(), 'text_' + Date.now() + '.ass');

    // === слои-оверлеи: fon -> topleft -> item -> transport ===
    const segs = [];
    segs.push('[0:v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[b]');
    segs.push('[b][1:v]overlay=0:0[o1]');   // topleft
    segs.push('[o1][2:v]overlay=0:0[o2]');  // item
    segs.push('[o2][3:v]overlay=0:0[o3]');  // transport

    // пишем .ass файл
    try {
      fs.writeFileSync(assPath, buildAss(events), 'utf8');
    } catch (e) {
      return res.status(500).json({ error: 'ASS_WRITE_FAILED', detail: String(e) });
    }

    // накладываем субтитры (libass) поверх собранной картинки
    const assArg = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    segs.push('[o3]ass=' + assArg + ':fontsdir=' + FONTS_DIR + '[vout]');

    // === аудио через filter_complex (чтобы применить громкость) ===
    let audioOutLabel = null;
    
    
    
    if (hasAudioFile) {
  // Смешиваем исходный звук видео + наложенный звук
  segs.push('[0:a][4:a]amix=inputs=2:duration=first:dropout_transition=0[aout]');
  audioOutLabel = '[aout]';
}


    
    const filterComplex = segs.join(';');

    const args = [
      '-y',
      '-stream_loop', '-1', '-i', f.fon[0].path,   // 0
      '-loop', '1', '-i', f.topleft[0].path,       // 1
      '-loop', '1', '-i', f.item[0].path,          // 2
      '-loop', '1', '-i', f.transport[0].path,     // 3
    ];
    if (hasAudioFile) {
      args.push('-i', f.audio[0].path);            // 4
    }
    args.push(
      '-filter_complex', filterComplex,
      '-map', '[vout]',
    );
    if (hasAudioFile) {
      args.push('-map', audioOutLabel);
    } else {
      args.push('-map', '0:a?');
    }
    args.push(
      '-t', String(duration),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '2',
      '-filter_complex_threads', '1',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      outPath,
    );

    const cleanup = () => {
      try { fs.unlinkSync(assPath); } catch (e) {}
    };

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        console.error('FFMPEG FAILED code=' + code);
        console.error(stderr);
        cleanup();
        return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => {
        try { fs.unlinkSync(outPath); } catch (e) {}
        cleanup();
      });
    });

    ff.on('error', (err) => {
      console.error('SPAWN ERROR', err);
      cleanup();
      res.status(500).json({ error: 'SPAWN_ERROR', detail: String(err) });
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
