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

const QUESTION_FONT = 34;
const HOOK_FONT = 34;
const ANSWER_FONT = 30;

const QUESTION_CY = 529;
const ANSWER_CY = [785, 890, 999.5];
const QUESTION_WRAP = 24;
const ANSWER_WRAP = 22;

app.get('/health', (req, res) => res.json({ ok: true }));

// --- перенос строк (как было) ---
function wrap(text, maxChars) {
  const words = String(text == null ? '' : text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxChars) { cur += ' ' + w; }
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
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
function assDialoguesForBlock({ start, end, textLines, fontsize, colorHex, cy, lineFactor }) {
  const lineH = Math.round(fontsize * (lineFactor || 1.28));
  const n = textLines.length;
  const startCy = cy - ((n - 1) * lineH) / 2;
  const col = assColor(colorHex);
  const st = secToAss(start);
  const en = secToAss(end);
  const x = Math.round(W / 2);

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
    'Style: Default,' + MAIN_FONT + ',34,' + assColor(BROWN) + ',&H00FFFFFF&,1,3,0,1,5,0,0,0,1\n\n' +
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
    { name: 'inscription', maxCount: 1 },
    { name: 'animal', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
    { name: 'niz-pravo', maxCount: 1 },
    { name: 'audio', maxCount: 1 },
  ]),
  (req, res) => {
    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); }
    catch (e) { return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

    const f = req.files || {};
    const need = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];
    for (const k of need) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'MISSING_FILE', field: k });
    }
    const hasAudioFile = !!(f.audio && f.audio[0]);

    const t = payload.timings || {};
    const duration = Number(payload.duration) || Number(t.duration) || 10;
    const hookStart = Number(t.hook_start != null ? t.hook_start : 0);
    const questionStart = Number(t.question_start != null ? t.question_start : 1);
    const answerStart = Number(t.answer_start != null ? t.answer_start : 4);
    const answerStep = Number(t.answer_step != null ? t.answer_step : 0.3);
    const revealStart = Number(t.reveal_start != null ? t.reveal_start : 9);

    const question = payload.question || '';
    const hook = payload.hook || '';
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const correctIndex = (Number(payload.correct_answer_position) || 1) - 1;

    // === стиль и габариты из payload ===
    const style = payload.style || {};
    const box = payload.box || {};
    const qFont = Number(style.fontSize) || QUESTION_FONT;
    const lineFactor = Number(style.lineSpacing) || 1.28;
    const qHex = style.textColor ? String(style.textColor).replace(/^#/, '') : BROWN;
    const qCy = (box.y != null && box.height != null)
      ? Math.round(Number(box.y) + Number(box.height) / 2)
      : QUESTION_CY;
    const qWrap = (box.width != null)
      ? Math.max(8, Math.floor(Number(box.width) / (qFont * 0.55)))
      : QUESTION_WRAP;

    const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');
    const assPath = path.join(os.tmpdir(), 'text_' + Date.now() + '.ass');

    // === слои-оверлеи (как было) ===
    const segs = [];
    segs.push('[0:v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[b]');
    segs.push('[b][1:v]overlay=0:0[o1]');
    segs.push('[o1][2:v]overlay=0:0[o2]');
    segs.push('[o2][3:v]overlay=0:0[o3]');
    segs.push('[o3][4:v]overlay=0:0[o4]');
    segs.push('[o4][5:v]overlay=0:0[o5]');
    segs.push('[o5][6:v]overlay=0:0[o6]');

    // === СОБИРАЕМ СОБЫТИЯ ДЛЯ .ASS (те же тайминги/позиции, что были в drawtext) ===
    const events = [];

    if (hook) {
      events.push({
        start: hookStart, end: questionStart,
        textLines: wrap(hook, qWrap),
        fontsize: qFont, colorHex: qHex, cy: qCy, lineFactor,
      });
    }

    if (question) {
      events.push({
        start: questionStart, end: duration,
        textLines: wrap(question, qWrap),
        fontsize: qFont, colorHex: qHex, cy: qCy, lineFactor,
      });
    }

    for (let i = 0; i < 3; i++) {
      const ans = answers[i];
      if (ans == null) continue;
      const appear = answerStart + i * answerStep;
      const cy = ANSWER_CY[i] != null ? ANSWER_CY[i] : (785 + i * 105);
      const wrapped = wrap(ans, ANSWER_WRAP);

      if (i === correctIndex) {
        // до раскрытия — обычный цвет
        events.push({ start: appear, end: revealStart, textLines: wrapped, fontsize: ANSWER_FONT, colorHex: qHex, cy, lineFactor });
        // после раскрытия — зелёный
        events.push({ start: revealStart, end: duration, textLines: wrapped, fontsize: ANSWER_FONT, colorHex: GREEN, cy, lineFactor });
      } else {
        events.push({ start: appear, end: revealStart, textLines: wrapped, fontsize: ANSWER_FONT, colorHex: qHex, cy, lineFactor });
      }
    }

    // пишем .ass файл
    try {
      fs.writeFileSync(assPath, buildAss(events), 'utf8');
    } catch (e) {
      return res.status(500).json({ error: 'ASS_WRITE_FAILED', detail: String(e) });
    }

    // накладываем субтитры (libass) поверх собранной картинки
    // ВАЖНО: в filter_complex экранируем спецсимволы пути
    const assArg = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    segs.push('[o6]ass=' + assArg + ':fontsdir=' + FONTS_DIR + '[vout]');

    const filterComplex = segs.join(';');

    const args = [
      '-y',
      '-stream_loop', '-1', '-i', f.fon[0].path,
      '-loop', '1', '-i', f.topleft[0].path,
      '-loop', '1', '-i', f.inscription[0].path,
      '-loop', '1', '-i', f.animal[0].path,
      '-loop', '1', '-i', f.item[0].path,
      '-loop', '1', '-i', f.transport[0].path,
      '-loop', '1', '-i', f['niz-pravo'][0].path,
    ];
    if (hasAudioFile) {
      args.push('-i', f.audio[0].path);
    }
    args.push(
      '-filter_complex', filterComplex,
      '-map', '[vout]',
    );
    if (hasAudioFile) {
      args.push('-map', '7:a:0');
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
