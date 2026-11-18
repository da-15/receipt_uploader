# receipt_uploader

スマホ・PCのブラウザからレシートや請求書を撮影・選択し、Google Drive へアップロードするウェブアプリです。電子領収書対応。

## 機能

- JPEG / PNG / PDF に対応
- アップロード前にブラウザ側で画像をリサイズ（転送量を削減）
- Google Drive OCR を使って日付・金額を自動読み取り（手動入力済みの場合はスキップ）
  - 定期の請求書（TEPCO・東京水道局・KDDI・GMO・Office365・Amazon）は書式ごとの専用ルールで読み、支払先欄（例：`TEPCO（01月20日〜02月19日分）`）も自動入力する
  - よく行くお店は `main.gs` の `SHOP_MEMOS` に登録すると支払先欄も自動入力される
- ファイル名は `日付_支払先_金額` 形式で自動生成
- パスワード認証によるアクセス制限
- PWA 対応：ホーム画面に追加するとアプリとして全画面で起動。画面はキャッシュされ、電波が弱い場所でもすぐ表示される（アップロード・OCR には通信が必要）

## 構成

| ファイル | 役割 |
|---|---|
| `docs/index.html` | フロントエンド（フォーム・OCR・アップロード処理） |
| `docs/assets/` | フロントエンド用の画像 |
| `docs/manifest.json` | PWA マニフェスト（アプリ名・アイコン・表示モード） |
| `docs/sw.js` | Service Worker（画面のキャッシュ。アセット変更時は `CACHE_NAME` の版数を上げる） |
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
