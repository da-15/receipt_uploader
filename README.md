# receipt_uploader

スマホ・PCのブラウザからレシートや請求書を撮影・選択し、Google Drive へアップロードするウェブアプリです。

## 機能

- JPEG / PNG / PDF に対応
- アップロード前にブラウザ側で画像をリサイズ（転送量を削減）
- Google Drive OCR を使って日付・金額を自動読み取り（手動入力済みの場合はスキップ）
- ファイル名は `日付_支払先_金額` 形式で自動生成
- パスワード認証によるアクセス制限

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | フロントエンド（フォーム・OCR・アップロード処理） |
| `*.gs` | Google Apps Script（バックエンド）|
| `appsscript.json` | GAS プロジェクト設定 |

## セットアップ

1. Google Apps Script プロジェクトを作成し、`*.gs` と `appsscript.json` をデプロイする
2. スクリプトプロパティに `PASSWORD` を設定する（`SEC.PASSWORD` として参照）
3. `index.html` の `CONF.DEPLOY_ID` をデプロイ ID に書き換える
4. `index.html` を任意のウェブサーバーまたは GAS の `doGet` で配信する

## 依存ライブラリ（GAS）

- [ImgApp](https://github.com/tanaikech/ImgApp) — サーバーサイドでの画像リサイズに使用
- Drive API v2（GAS の高度なサービスから有効化）
