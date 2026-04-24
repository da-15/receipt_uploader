'use strict';
const CONF = {
  RESIZE: 2500
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
    return message('ERROR: unexpected error(' + ex + ')');
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
  if(!params.memo || !params.fileuri || !params.price || !params.password){
    //パラメーターがセットされていない
    return 'no_required'; //NG
  }else if(params.password != SEC.PASSWORD){
    //パスワード違い
    return 'password_incorrect'; //NG
  }else if(params.memo == '' || params.fileuri == '' || params.price == ''){
    return 'no_required'; //NG
    //パラメーターが空
  }else if(params.filetype != 'image/jpeg' && params.filetype != 'image/png' && params.filetype != 'application/pdf' ){
    //ファイルタイプがjpg、png、pdf以外
    return 'illegal_mime_type'; //NG
  }

  return ''; //OK
}

//自身の格納されているフォルダーIDを取得
function getMyFolderId(){
  return DriveApp.getFileById(ScriptApp.getScriptId()).getParents().next().getId();
}

// 画像からOCRでテキストを抽出し、日付・金額を返す
function handleOCR(e) {
  if (!e.parameters.password || e.parameters.password != SEC.PASSWORD) {
    return message('ERROR: password_incorrect');
  }
  if (!e.parameters.fileuri || !e.parameters.filetype) {
    return message('ERROR: no_required');
  }

  try {
    const data = Utilities.base64Decode(e.parameters.fileuri, Utilities.Charset.UTF_8);
    const blob = Utilities.newBlob(data, e.parameters.filetype, 'ocr_temp');
    const resource = { title: 'ocr_temp' };
    const file = insertWithOCR(resource, blob);
    const token = ScriptApp.getOAuthToken();
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + file.id + '/export?mimeType=text/plain',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const text = normalizeOCRText(res.getContentText());
    DriveApp.getFileById(file.id).setTrashed(true);

    return ContentService.createTextOutput(
      JSON.stringify({ result: 'ok', price: extractPrice(text), date: extractDate(text) })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch(ex) {
    return message('ERROR: ocr_failed(' + ex + ')');
  }
}

// レート制限に対してエクスポネンシャルバックオフでリトライ
function insertWithOCR(resource, blob, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'ja', convert: true });
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
    .replace(/(\d)[\s　]+(\d)/g, '$1$2')
    .replace(/　/g, ' ');
}

function extractPrice(text) {
  // 合計・お会計・TOTALに続く金額を優先
  const patterns = [
    /合[計税][^\d\n]*([1-9][0-9,]+)/,
    /お会計[^\d\n]*([1-9][0-9,]+)/,
    /TOTAL[^\d\n]*([1-9][0-9,]+)/i,
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



