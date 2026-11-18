'use strict';
const CONF = {
  AUTH_MAX_ATTEMPTS: 10,   //認証失敗の許容回数
  AUTH_LOCKOUT_SEC: 600    //ロックアウト時間（秒）
}

function doGet(e) {
  //アクセスできるか確認用
  return message('request:ok');
}

function doPost(e) {
  // OCRアクション
  if (e.parameters.action == 'ocr') {
    return handleOCR(e);
  }

  //エラーチェック
  const check = checkParameters(e.parameters);
  if (check !== ''){
    return message('ERROR: bad parameters(' + check + ')');
  }

  //不正な文字を排除
  let filename = '';
  filename += ('' + e.parameters.date).replace(/[^0-9]/g,'') + '_';
  filename += ('' + e.parameters.memo).replace(/[\\/:*?"<>|_]/g,'') + '_';
  filename += ('' + e.parameters.price).replace(/[^0-9]/g,'');
  if(filename == ''){
    filename = 'noname';
  }

  //ファイルタイプをチェック
  if(e.parameters.filetype == 'image/jpeg'){
    filename += '.jpg';
  }else if(e.parameters.filetype == 'image/png'){
    filename += '.png';
  }else if(e.parameters.filetype == 'application/pdf'){
    filename += '.pdf';
  }

  let folderId;

  try{
    folderId = getMyFolderId();
    const data = Utilities.base64Decode(e.parameters.fileuri, Utilities.Charset.UTF_8);
    const blob = Utilities.newBlob(data, e.parameters.filetype, filename);
    
    //アップロードされたファイルをDriveに保存
    DriveApp.getFolderById(folderId).createFile(blob);
  }
  catch(ex){
    //詳細はログにのみ残し、クライアントには返さない
    console.error('upload failed: ' + ((ex && ex.stack) || ex));
    return message('ERROR: unexpected_error');
  }

  return message('ok', folderId);
}


//入力されたパラメーターの不正チェック
function checkParameters(params){
  if(!params.date || !params.memo || !params.fileuri || !params.price || !params.password){
    //パラメーターがセットされていない
    return 'no_required'; //NG
  }

  const auth = checkPassword('' + params.password);
  if(auth !== ''){
    return auth; //NG
  }

  if(!isAllowedFiletype(params.filetype)){
    //ファイルタイプがjpg、png、pdf以外
    return 'illegal_mime_type'; //NG
  }

  return ''; //OK
}

//許可されたファイルタイプか
function isAllowedFiletype(filetype){
  return filetype == 'image/jpeg' || filetype == 'image/png' || filetype == 'application/pdf';
}

//パスワード認証（総当たり対策つき）
//一定回数失敗するとロックアウト時間中はすべて拒否する
function checkPassword(password){
  const cache = CacheService.getScriptCache();
  const failed = parseInt(cache.get('auth_failed_count') || '0', 10);
  if(failed >= CONF.AUTH_MAX_ATTEMPTS){
    return 'locked_out'; //NG
  }
  if(password !== SEC.PASSWORD){
    cache.put('auth_failed_count', String(failed + 1), CONF.AUTH_LOCKOUT_SEC);
    return 'password_incorrect'; //NG
  }
  cache.remove('auth_failed_count');
  return ''; //OK
}

//自身の格納されているフォルダーIDを取得
function getMyFolderId(){
  return DriveApp.getFileById(ScriptApp.getScriptId()).getParents().next().getId();
}

// 画像からOCRでテキストを抽出し、日付・金額・支払先欄を返す
function handleOCR(e) {
  const auth = checkPassword('' + (e.parameters.password || ''));
  if (auth !== '') {
    return message('ERROR: ' + auth);
  }
  if (!e.parameters.fileuri || !e.parameters.filetype) {
    return message('ERROR: no_required');
  }
  if (!isAllowedFiletype('' + e.parameters.filetype)) {
    return message('ERROR: illegal_mime_type');
  }

  let file = null;
  try {
    const data = Utilities.base64Decode(e.parameters.fileuri, Utilities.Charset.UTF_8);
    const blob = Utilities.newBlob(data, e.parameters.filetype, 'ocr_temp');
    const folderId = getMyFolderId();
    //Googleドキュメントに変換することでOCRが実行される（Drive API v3）
    const resource = {
      name: 'ocr_temp',
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId]
    };
    file = insertWithOCR(resource, blob);
    const token = ScriptApp.getOAuthToken();
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + file.id + '/export?mimeType=text/plain',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const parsed = parseReceipt(res.getContentText());
    return ContentService.createTextOutput(
      JSON.stringify({ result: 'ok', price: parsed.price, date: parsed.date, memo: parsed.memo })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch(ex) {
    //詳細はログにのみ残し、クライアントには返さない
    console.error('ocr failed: ' + ((ex && ex.stack) || ex));
    return message('ERROR: ocr_failed');
  } finally {
    if (file) DriveApp.getFileById(file.id).setTrashed(true);
  }
}

// レート制限に対してエクスポネンシャルバックオフでリトライ
function insertWithOCR(resource, blob, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return Drive.Files.create(resource, blob, { ocrLanguage: 'ja' });
    } catch(ex) {
      if (i < maxRetries - 1 && ex.toString().includes('rate limit')) {
        Utilities.sleep(Math.pow(2, i) * 2000); // 2s, 4s, 8s
        continue;
      }
      throw ex;
    }
  }
}

//=== OCR解析 ===
//OCRで読み取った文字から、日付・金額・支払先欄を取り出す。
//定期の請求書（TEPCO・東京水道局・KDDI・GMO・Office365）は書式が決まっているので専用ルールで読み、
//それ以外のレシートは汎用ルールで読む。

//よく行くお店：OCR文字に pattern が含まれていたら、支払先欄に memo を入れる
const SHOP_MEMOS = [
  { pattern: /STARBUCKS|スターバックス/i, memo: 'Starbucks（雑費）' },
  { pattern: /MOS\s*BURGER|モスバーガー/i, memo: 'モスバーガー（雑費）' },
];

//OCR文字から { date: 'YYYY-MM-DD', price: '1234', memo: '支払先欄' } を返す（読めない項目は空文字）
function parseReceipt(rawText) {
  const text = normalizeOCRText(rawText);
  for (const rule of BILL_RULES) {
    if (rule.match.test(text)) {
      const r = rule.parse(text);
      return {
        date: r.date || '',
        price: r.price || (r.noPriceFallback ? '' : extractPrice(text)),
        memo: r.memo || ''
      };
    }
  }
  const shop = SHOP_MEMOS.find(s => s.pattern.test(text));
  return { date: extractDate(text), price: extractPrice(text), memo: shop ? shop.memo : '' };
}

function normalizeOCRText(text) {
  let t = String(text);
  //全角英数字・CJK互換文字（PDFの「⽉」など）を通常の文字にそろえる
  try { t = t.normalize('NFKC'); } catch (e) {
    t = t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }
  return t
    .replace(/\r/g, '')
    .replace(/[，]/g, ',')
    .replace(/[～~]/g, '〜')
    //「¥1, 539」「1 , 169」のように桁区切りの前後に入った空白を詰める
    .replace(/(\d)[ \t]*,[ \t]*(?=\d{3}(?!\d))/g, '$1,')
    //「2. 425」「¥1.581」のように桁区切りのカンマがピリオドに化けたものを直す
    .replace(/(^|[^\d.])(\d{1,3})\.[ \t]?(\d{3})(?![\d.%])/gm, '$1$2,$3')
    .replace(/　/g, ' ');
}

//---- 共通の小道具 ----
function toInt(s) { return parseInt(String(s).replace(/[,\s]/g, ''), 10); }
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function monthEnd(y, m) { return ymd(y, m, new Date(y, m, 0).getDate()); }
function isValidDate(y, m, d) {
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}
function amountStr(n) { return (n > 0 && n < 10000000) ? String(n) : ''; }

//---- 定期の請求書 ----
const BILL_RULES = [
  { name: 'TEPCO', match: /TEPCO|東京電力|電気料金等領収済/, parse: parseTepco },
  { name: '東京水道局', match: /東京都水道局|下水道使用量/, parse: parseTokyoWater },
  //GMOの請求書の注意書きに「KDDI」が出てくるので、GMOを先に判定する
  { name: 'GMO', match: /GMOとくとくBB|GMOインターネット/, parse: parseGmo },
  { name: 'KDDI', match: /KDDIをご利用|KDDI料金|RECEIPT FOR SERVICES/, parse: parseKddi },
  { name: 'Office365', match: /Microsoft/, parse: parseMicrosoft },
  { name: 'Amazon', match: /amazon\.co\.jp|Amazon\.com, Inc/i, parse: parseAmazon },
  { name: 'Claude', match: /Anthropic, PBC/, parse: parseAnthropic },
];

//TEPCO：「電気料金等領収済みのお知らせ2025年2月」「1月20日〜2月19日」「13,211円 (うち消費税等相当額」
function parseTepco(text) {
  const r = { memo: 'TEPCO（●月20日〜●月19日分）' };
  const price = text.match(/([\d,]+)\s*円\s*[(（]\s*うち消費税/);
  if (price) r.price = amountStr(toInt(price[1]));
  const ym = text.match(/お知らせ\s*(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (ym) r.date = monthEnd(+ym[1], +ym[2]);
  const period = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*〜\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (period) {
    r.memo = `TEPCO（${pad2(period[1])}月${pad2(period[2])}日〜${pad2(period[3])}月${pad2(period[4])}日分）`;
  }
  return r;
}

//東京水道局（検針票）：今回の使用期間にかかる月を支払先欄に、その最終月の末日を日付に、
//「合計金額 − 口座割引予定額」を金額にする（前回分の「振替済金額」は使わない）
function parseTokyoWater(text) {
  const r = { memo: '東京水道局（●、●、●月分）' };
  //「令和7年1月分」のうち一番新しいものが今回分の最終月
  let latest = null;
  for (const m of text.matchAll(/(?:令和|令|和)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月分/g)) {
    const y = 2018 + parseInt(m[1], 10), mo = parseInt(m[2], 10);
    if (mo < 1 || mo > 12) continue;
    if (!latest || y * 12 + mo > latest.y * 12 + latest.m) latest = { y: y, m: mo };
  }
  if (latest) r.date = monthEnd(latest.y, latest.m);

  //使用期間「7月11日〜9月10日」：最終月が今回分と一致するものを選ぶ
  const periods = [...text.matchAll(/(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日[ \t]*〜?[ \t]*(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日/g)]
    .map(m => ({ from: parseInt(m[1], 10), to: parseInt(m[3], 10) }))
    .filter(p => p.from >= 1 && p.from <= 12 && p.to >= 1 && p.to <= 12);
  const period = periods.find(p => latest && p.to === latest.m) || periods[periods.length - 1];
  if (period) {
    const months = [];
    for (let m = period.from; months.length < 12; m = m % 12 + 1) {
      months.push(pad2(m));
      if (m === period.to) break;
    }
    r.memo = `東京水道局（${months.join('、')}月分）`;
  }

  //金額
  const yen = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*円/g)].map(m => toInt(m[1]));
  const disc = text.match(/口座割引予定額\s*([\d,]+)\s*円/);
  const discount = disc ? toInt(disc[1]) : 110;
  let best = 0;
  for (const total of yen) {
    if (total > discount && yen.includes(total - discount) && total > best) best = total;
  }
  if (best) r.price = String(best - discount);
  return r;
}

//KDDI料金領収証（PDF）：文字が1字ずつ空白で区切られて読まれる
//「2 0 2 5」の次の行に「請求月」と「利用月」の数字が続けて並ぶ（例「1 1 2」= 1月請求 12月利用）
function parseKddi(text) {
  const r = { memo: 'KDDI（●月請求 ●月利用分）' };
  const amount = text.match(/AMOUNT\s+RECEIVED\s*\n+\s*([\d ,]+?)\s*円/);
  if (amount) r.price = amountStr(toInt(amount[1]));
  const ym = text.match(/\b2\s?0\s?(\d)\s?(\d)\s*\n+\s*([\d ]+?)\s*\n/);
  if (ym) {
    const year = 2000 + parseInt(ym[1] + ym[2], 10);
    const digits = ym[3].replace(/\s/g, '');
    //請求月 = 利用月の翌月 になる分け方を探す
    for (let i = 1; i < digits.length; i++) {
      const bill = parseInt(digits.slice(0, i), 10), use = parseInt(digits.slice(i), 10);
      if (bill >= 1 && bill <= 12 && use >= 1 && use <= 12 && bill === use % 12 + 1 && digits.slice(i)[0] !== '0') {
        r.date = monthEnd(year, bill);
        r.memo = `KDDI（${pad2(bill)}月請求 ${pad2(use)}月利用分）`;
        break;
      }
    }
  }
  return r;
}

//GMOとくとくBB：「請求年月 2025年01月」「今回請求額 ¥4,711」
function parseGmo(text) {
  const r = { memo: 'GMOインターネット（●月分）' };
  const price = text.match(/今\s*回\s*請\s*求\s*額[^\d\n]{0,10}?([\d,]+)/);
  if (price) r.price = amountStr(toInt(price[1]));
  const ym = text.match(/請\s*求\s*年\s*月\s*(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (ym) {
    r.date = monthEnd(+ym[1], +ym[2]);
    r.memo = `GMOインターネット（${pad2(ym[2])}月分）`;
  }
  return r;
}

//Microsoft（Office365・年払い）：金額は「Total (including Tax) JPY 16,315」
//日付は「Invoice for activity on 2026/04/10」の日付、支払先は「Microsoft（Office365）」
function parseMicrosoft(text) {
  const r = { memo: 'Microsoft（Office365）' };
  const price = text.match(/Total\s*\(including Tax\)\s*(?:JPY)?\s*([\d,]+)/i);
  if (price) r.price = amountStr(toInt(price[1]));
  const act = text.match(/activity on\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/i)
    || text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*-\s*\d{4}\/\d{1,2}\/\d{1,2}/);
  if (act) r.date = ymd(+act[1], +act[2], +act[3]);
  return r;
}

//Amazonの領収書（注文履歴から印刷したPDF）：日付は注文日
//金額は「ご請求額」。ギフトカード払いで0円のときは「商品の小計」
function parseAmazon(text) {
  const r = { memo: '' };
  const d = text.match(/注文日\s*[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (d) r.date = ymd(+d[1], +d[2], +d[3]);
  const billed = [...text.matchAll(/ご請求額\s*[:：]?\s*[¥]?\s*([\d,]+)/g)].map(m => toInt(m[1]));
  const subtotal = text.match(/商品の小計\s*[:：]?\s*[¥]?\s*([\d,]+)/);
  if (billed.length && billed[billed.length - 1] > 0) r.price = String(billed[billed.length - 1]);
  else if (subtotal) r.price = amountStr(toInt(subtotal[1]));
  return r;
}

//Claude（Anthropic）の領収書：ドル建てなので金額は空欄にする（円換算は手入力）
//日付は「Date paid April 22, 2026」、なければ「Date of issue」
function parseAnthropic(text) {
  const r = { memo: 'Claude', price: '' };
  const m = text.match(/Date (?:paid|of issue)\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const mo = MONTHS_EN.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (mo > 0 && isValidDate(+m[3], mo, +m[2])) r.date = ymd(+m[3], mo, +m[2]);
  }
  r.noPriceFallback = true;
  return r;
}
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

//---- 汎用ルール（一般のレシート） ----

//金額らしい文字列を1つ取り出す（「19点」「10%」「2名」などは金額扱いしない）
//「¥5,899外」のように外税の税抜額を示すものも合計ではないので除く
const AMOUNT_RE = /(?:[¥\\#]\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?![\d,]|\s*[%点名個本枚日月年時分秒外])(\s*円)?/g;
function amountsInLine(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const hasYen = /^[¥\\#]/.test(m[0]) || !!m[2] || m[1].includes(',');
    out.push({ value: toInt(m[1]), hasYen: hasYen });
  }
  return out;
}
//行全体が金額1つだけか（「¥1,234」「¥1,234)」「1,234円」など）
function lineAmount(line) {
  const m = line.match(/^[(（]?\s*[¥\\#]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?\s*[)）]?$/);
  return m ? toInt(m[1]) : null;
}

const TOTAL_KEYWORDS = [
  /総合計/, /合計金額/, /(?<![税小])合[計计](?!点数|\s*\d+\s*点)/, /お支払金額|お支払い金額/, /ご請求額|請求金額/,
  /税込計|税込合計|税込価格計/, /領収金額/, /お会計/, /TOTAL/i, /^\s*計\s*$/
];

function extractPrice(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(s => s !== '');
  //1. 合計などの見出しの後ろにある最初の金額
  for (const kw of TOTAL_KEYWORDS) {
    for (let i = 0; i < lines.length; i++) {
      const km = lines[i].match(kw);
      if (!km) continue;
      //表形式「小計 消費税 合計金額」の次の行に同じ数だけ金額が並ぶ場合は列で対応させる
      const headers = lines[i].split(/\s+/).filter(Boolean);
      if (headers.length >= 2 && i + 1 < lines.length) {
        const row = amountsInLine(lines[i + 1]);
        const col = headers.findIndex(h => kw.test(h));
        if (row.length === headers.length && col >= 0) return amountStr(row[col].value);
      }
      //見出しだけの行が何行か続き、その後に金額だけの行が同じ数以上続く場合は、順番で対応させる
      //（例「10%税抜対象額 / 10%税額 / 合計」の後に「¥300 / ¥30 / ¥330」）
      if (lines[i].trim() === km[0]) {
        let s = i, e = i;
        while (s > 0 && lineAmount(lines[s - 1]) === null && amountsInLine(lines[s - 1]).length === 0) s--;
        while (e + 1 < lines.length && lineAmount(lines[e + 1]) === null && amountsInLine(lines[e + 1]).length === 0) e++;
        const labels = e - s + 1;
        const vals = [];
        for (let j = e + 1; j < lines.length && lineAmount(lines[j]) !== null; j++) vals.push(lineAmount(lines[j]));
        if (labels >= 2 && vals.length >= labels && vals[i - s] >= 10) return amountStr(vals[i - s]);
      }
      const rest = [lines[i].slice(km.index + km[0].length)].concat(lines.slice(i + 1, i + 5));
      for (const line of rest) {
        if (/税|お預|お釣|おつり|残高|対象/.test(line)) continue;
        const a = amountsInLine(line).find(x => x.value >= 10 && (x.hasYen || /^\s*[\d,]+\s*$/.test(line)));
        if (a) return amountStr(a.value);
      }
    }
  }
  //2. 見出しが読めなかった場合：¥/円つきの金額のうち、一番多く出てくるもの（同数なら大きい方）
  const counts = {};
  for (const line of lines) {
    if (/お預|お釣|おつり|残高|前残高|税/.test(line)) continue;
    for (const a of amountsInLine(line)) {
      if (a.hasYen && a.value > 0) counts[a.value] = (counts[a.value] || 0) + 1;
    }
  }
  const best = Object.keys(counts).map(Number)
    .sort((a, b) => counts[b] - counts[a] || b - a)[0];
  return best ? amountStr(best) : '';
}

function extractDate(text) {
  const cands = [];
  const thisYear = new Date().getFullYear();
  const push = (y, m, d, idx, len) => {
    y = +y; m = +m; d = +d;
    if (y < 100) y += 2000;
    //「2026」が「2016」「2006」と読まれることがあるので、ありえない年は下1桁が同じ近い年に直す（優先度は下げる）
    let fixed = false;
    if (y < thisYear - 5 || y > thisYear + 1) {
      const c = Math.floor(thisYear / 10) * 10 + (y % 10);
      y = c > thisYear + 1 ? c - 10 : c;
      fixed = true;
    }
    if (!isValidDate(y, m, d)) return;
    //直後に時刻（12:34 / 12時34分）があれば会計日時とみなして優先する
    const after = text.slice(idx + len, idx + len + 16);
    const hasTime = /^\s*(?:\([^)]{0,3}\)|（[^）]{0,3}）)?\s*\d{1,2}\s*(?::|時)\s*\d{2}/.test(after);
    cands.push({ date: ymd(y, m, d), idx: idx, hasTime: hasTime, fixed: fixed });
  };
  for (const m of text.matchAll(/(20\d{2})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})\s*日?/g)) push(m[1], m[2], m[3], m.index, m[0].length);
  for (const m of text.matchAll(/(?<![\d\/])(\d{2})[\/.](\d{1,2})[\/.](\d{1,2})(?![\d\/])/g)) push(m[1], m[2], m[3], m.index, m[0].length);
  for (const m of text.matchAll(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) push(2018 + +m[1], m[2], m[3], m.index, m[0].length);
  for (const m of text.matchAll(/R\s*(\d{1,2})[.\/](\d{1,2})[.\/](\d{1,2})/g)) push(2018 + +m[1], m[2], m[3], m.index, m[0].length);
  for (const m of text.matchAll(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(20\d{2})/g)) {
    const mo = MONTHS_EN.indexOf(m[1].toLowerCase()) + 1;
    if (mo > 0) push(m[3], mo, m[2], m.index, m[0].length);
  }
  //区切りが読めなかった「2025917 19:17」のような日付（時刻が続くときだけ）
  for (const m of text.matchAll(/(?<!\d)(20\d{2})[ ]?(\d{3,4})(?!\d)/g)) {
    if (!/^.{0,8}?\d{1,2}:\d{2}/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 16))) continue;
    const md = m[2];
    for (let i = 1; i < md.length; i++) {
      const before = cands.length;
      push(m[1], md.slice(0, i), md.slice(i), m.index, m[0].length);
      if (cands.length > before) cands[cands.length - 1].hasTime = true;
    }
  }
  if (cands.length === 0) return '';
  cands.sort((a, b) => (a.fixed - b.fixed) || (b.hasTime - a.hasTime) || (a.idx - b.idx));
  return cands[0].date;
}

//メッセージの生成 JSON

function message(msg,fId) {
  let jsonVal = '';
  if(fId){
    jsonVal = fId;
  }
  return ContentService.createTextOutput(JSON.stringify({result: msg, folderId: jsonVal})).setMimeType(ContentService.MimeType.JSON);
}



