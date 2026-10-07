# receipt_uploader

スマホ・PCのブラウザからレシートや請求書を撮影・選択し、Google Drive へアップロードするウェブアプリです。電子領収書対応。

## 機能

- JPEG / PNG / PDF に対応
- アップロード前にブラウザ側で画像をリサイズ（転送量を削減）
- Google Drive OCR を使って日付・金額を自動読み取り（手動入力済みの場合はスキップ）
- ファイル名は `日付_支払先_金額` 形式で自動生成
- パスワード認証によるアクセス制限

## 構成

| ファイル | 役割 |
|---|---|
| `docs/index.html` | フロントエンド（フォーム・OCR・アップロード処理） |
| `docs/assets/` | フロントエンド用の画像 |
| `main.gs` | Google Apps Script（バックエンド：アップロード・OCR・認証）|
| `secret.gs.sample` | パスワード定義（`SEC`）のサンプル |
| `appsscript.json` | GAS プロジェクト設定 |

## セットアップ

1. Google Apps Script プロジェクトを作成し、`main.gs` と `appsscript.json` をデプロイする
2. `secret.gs.sample` を参考に、GAS プロジェクトに `secret.gs` を作成して `SEC.PASSWORD` を設定する（`secret.gs` はリポジトリにコミットしない）
3. `docs/index.html` の `CONF.DEPLOY_ID` をデプロイ ID に書き換える
4. GitHub Pages の公開元を `main` ブランチの `/docs` フォルダに設定する（Settings → Pages）

## 依存ライブラリ（GAS）

- Drive API v3（GAS の高度なサービスから有効化）
