'use strict';
const CONF = {
  FOLER_ID: '19WXq1CqvDV9dTmiS8HKiXuRbx19f_vxe', //保存先のフォルダID
  RESIZE: 2500
}

function doGet(e) {
  //アクセスできるか確認用
  return message('request:ok');
}

function doPost(e) {
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

  try{
    const data = Utilities.base64Decode(e.parameters.fileuri, Utilities.Charset.UTF_8);
    const blob = Utilities.newBlob(data, e.parameters.filetype, filename);
    
    //アップロードされたファイルをDriveに保存
    const originalFile = DriveApp.getFolderById(CONF.FOLER_ID).createFile(blob);
    const fileId = originalFile.getId();

    //リサイズしないチェックボックスの判定
    if(!e.parameters.noresize || e.parameters.noresize != 'on'){
      //指定サイズより大きい場合にリサイズ
      resizeImage(fileId, CONF.FOLER_ID, CONF.RESIZE);
    }
  }
  catch(ex){
    return message('ERROR: unexpected error(' + ex + ')');
  }

  return message('ok');
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
  if(!params.memo || !params.fileuri || !params.price){
    //パラメーターがセットされていない
    return 'no_required'; //NG
  }else if(params.memo == '' || params.fileuri == '' || params.price == ''){
    return 'no_required'; //NG
    //パラメーターが空
  }else if(params.filetype != 'image/jpeg' && params.filetype != 'image/png' && params.filetype != 'application/pdf' ){
    //ファイルタイプがjpg、png、pdf以外
    return 'illegal_mime_type'; //NG
  }

  return ''; //OK
}


//メッセージの生成 JSON
function message(msg) {
  return ContentService.createTextOutput(JSON.stringify({result: msg})).setMimeType(ContentService.MimeType.JSON);
}