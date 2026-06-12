'use strict';
const CONF = {
  RESIZE: 2500,
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
    const originalFile = DriveApp.getFolderById(folderId).createFile(blob);
    const fileId = originalFile.getId();

    //リサイズしないチェックボックスの判定
    if(!e.parameters.noresize || e.parameters.noresize != 'on'){
      //指定サイズより大きい場合にリサイズ
      resizeImage(fileId, folderId, CONF.RESIZE);
    }
  }
  catch(ex){
    //詳細はログにのみ残し、クライアントには返さない
    console.error('upload failed: ' + ((ex && ex.stack) || ex));
    return message('ERROR: unexpected_error');
  }

  return message('ok', folderId);
}


//縦横比がsize内におさまるように、画像jpg、pngのリサイズをする。
function resizeImage(fileId, outputFolderId, resize) {
  // ファイルを取得
  const file = DriveApp.getFileById(fileId); 

  //ファイルタイプの判定
  const mimeType = file.getMimeType();
  if(mimeType != 'image/jpeg' && mimeType != 'image/png'){
    //jpgでもpngでもない場合は何もしない
    return;
  }
  
  //getSizeメソッド実行
  let fileSize = ImgApp.getSize(file.getBlob());
  const width = fileSize.width;
  const height = fileSize.height;
  
  // リサイズする必要があるかどうかを判定
  if (width > resize || height > resize) {
    // 縮小倍率を計算
    const scale = Math.min(resize / width, resize / height);
    const res = ImgApp.doResize(fileId, parseInt(width * scale));

    //リサイズ後のファイルを保存
    DriveApp.getFolderById(outputFolderId).createFile(res.blob.setName(file.getName()));
    
    //元ファイルを削除（ごみ箱へ移動）
    file.setTrashed(true);
  }
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

// 画像からOCRでテキストを抽出し、日付・金額を返す
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
    const text = normalizeOCRText(res.getContentText());
    //デバッグ用: OCR結果テキストをログに残す（原因究明が終わったら削除する）
    console.log('ocr text(' + text.length + '): ' + text.slice(0, 1000));
    console.log('extracted date=' + extractDate(text) + ' price=' + extractPrice(text));
    return ContentService.createTextOutput(
      JSON.stringify({ result: 'ok', price: extractPrice(text), date: extractDate(text) })
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

function normalizeOCRText(text) {
  return text
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ',')
    .replace(/(\d),[ \t　]+(\d)/g, '$1,$2')
    .replace(/(\d)[ \t　]+(\d)/g, '$1$2')
    .replace(/　/g, ' ');
}

function extractPrice(text) {
  // 合計・お会計・TOTALに続く金額を優先
  const patterns = [
    /(?<!税)合[計税](?:[^\d\n]*\n[ \t　]*[¥￥]?[ \t　]*|[^\d\n]*)([1-9][0-9,]+)/,
    /お会計(?:[^\d\n]*\n[ \t　]*[¥￥]?[ \t　]*|[^\d\n]*)([1-9][0-9,]+)/,
    /TOTAL(?:[^\d\n]*\n[ \t　]*[¥￥]?[ \t　]*|[^\d\n]*)([1-9][0-9,]+)/i,
    /[¥￥]\s*([1-9][0-9,]+)/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''));
      if (n > 0 && n < 100000) return String(n);
    }
  }
  // フォールバック: テキスト中の最大金額
  const amounts = [...text.matchAll(/([1-9][0-9,]{2,})/g)]
    .map(m => parseInt(m[1].replace(/,/g, '')))
    .filter(n => n > 0 && n < 100000);
  return amounts.length > 0 ? String(Math.max(...amounts)) : '';
}

function extractDate(text) {
  // 西暦 (YYYY/MM/DD, YYYY-MM-DD, YYYY年MM月DD日)
  const western = text.match(/(\d{4})\s*[\/\-年]\s*(\d{1,2})\s*[\/\-月]\s*(\d{1,2})/);
  if (western && parseInt(western[1]) >= 2000) {
    return `${western[1]}-${western[2].padStart(2,'0')}-${western[3].padStart(2,'0')}`;
  }
  // 令和
  const reiwa = text.match(/令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/);
  if (reiwa) {
    return `${2018 + parseInt(reiwa[1])}-${reiwa[2].padStart(2,'0')}-${reiwa[3].padStart(2,'0')}`;
  }
  return '';
}

//メッセージの生成 JSON

function message(msg,fId) {
  let jsonVal = '';
  if(fId){
    jsonVal = fId;
  }
  return ContentService.createTextOutput(JSON.stringify({result: msg, folderId: jsonVal})).setMimeType(ContentService.MimeType.JSON);
}



