# OpenRGB Companion

OpenRGB Companion は、OpenRGB をハードウェア制御のバックエンドとして利用しつつ、
Profile の RGB 値を見やすく確認・編集するための Windows 向け Companion アプリです。

OpenRGB 本体の代替ではありません。OpenRGB の SDK Server / Profile / Plugin を利用し、
OpenRGB だけでは確認しにくい RGB 数値や Profile 編集、Scheduler Plugin 設定を扱いやすくします。

> **UI language:** 日本語のみ  
> **Platform:** Windows  
> **License:** GNU GPL v2.0 only

## 主な機能

- OpenRGB の Controller / Zone を取得して RGB 値を表示
- OpenRGB Profile を Companion 側へ記録し、RGB 値を数値で確認
- Profile の新規作成・編集・複製
- Zone ごとの RGB 数値入力 / カラーピッカー
- 編集中の RGB を実機へライブ反映
- 保存前の実機プレビュー
- 編集破棄時に実機 RGB を編集開始時の状態へ復元
- OpenRGB Profile と Companion 記録を1つの一覧で表示
- OpenRGB の SDK Server が必要な場合は自動で起動・再起動
- Scheduler Plugin 導入済み環境ではスケジュール設定を Companion から編集
- 狭いウィンドウでも主要操作を維持する Responsive UI

## 必要なもの

- Windows 10 / 11 x64
- [OpenRGB](https://openrgb.org/)
- OpenRGB から認識される RGB デバイス

Scheduler 機能を利用する場合のみ、OpenRGB の Scheduler Plugin が別途必要です。

**OpenRGB 本体および Scheduler Plugin は OpenRGB Companion に同梱されません。**

## OpenRGB との接続

Companion はローカルの OpenRGB SDK Server (`127.0.0.1:6742`) を利用します。

SDK Server がすでに利用可能な場合、動作中の OpenRGB には触れません。
OpenRGB が起動していない、または SDK Server 無効で起動している場合は、
必要に応じて OpenRGB を `--gui --server --startminimized` で起動・再起動します。

## Profile

OpenRGB Profile と Companion の記録は別々に保持されます。

Companion に記録した Profile では RGB 値を確認・編集できます。
編集結果は実機へプレビューした後、OpenRGB Profile として保存できます。

### 保存時の安全策

- 新規 Profile は作成開始時に現在の実機 RGB を読み直し、その値を初期値にします。
- Profile 保存前に、OpenRGB から RGB を再読込して保存予定値と一致することを確認します。一致しない場合は `SAVE_PROFILE` を送信せず中止します。
- 既存 OpenRGB Profile を上書きする場合は、変更前の `.orp` を自動バックアップしてから保存します。
- 保存後にも Profile を再ロードし、RGB が保存予定値と一致することを確認します。

上書き前のバックアップは通常 `%LOCALAPPDATA%\OpenRGB Companion\profile-backups` に保存されます。

### Profile 名の制限

OpenRGB 側でのファイル名互換性と安定性を優先するため、
Companion から作成・別名保存する Profile 名は次の文字に制限しています。

- `A-Z`
- `a-z`
- `0-9`
- 半角スペース
- `-`
- `_`

## Scheduler Plugin

Scheduler Plugin が検出された場合のみ `Plugins > Scheduler` が表示されます。

現在対応している主な操作:

- スケジュール ON / OFF
- 名前
- 毎日の実行時刻
- Profile 読込
- 消灯
- カスタム Cron の保持・編集
- 変更前バックアップ
- 変更反映後の OpenRGB 再起動

未反映の編集は `新規・未反映` / `変更あり` / `削除予定` として表示されます。

## ダウンロード

通常利用では GitHub Releases の **Installer** を推奨します。

- **Installer**: Windows へ通常インストール
- **Standalone EXE**: インストールせず直接起動

現時点ではコード署名を行っていないため、環境によっては Windows SmartScreen の警告が表示される場合があります。

## 既知の制限

- UI は日本語のみです。
- Windows のみを対象としています。
- Companion の低レベル Profile 操作は **OpenRGB SDK Protocol 5** を前提にしています。
- **OpenRGB 1.0 / SDK Protocol 6 は現時点では対応確認していません。**
- Profile 名は ASCII の一部文字に制限しています。
- Plugin 設定編集は現在 Scheduler Plugin のみ対応しています。
- RGB デバイス自体の対応可否は OpenRGB 側の対応状況に依存します。

## ソースからのビルド

必要なもの:

- Node.js / npm
- Rust / Cargo
- Windows 上の Tauri ビルド環境
- NSIS 関連コンポーネント（Tauri が必要に応じて取得）

```powershell
npm install
npm run tauri build -- --bundles nsis
```

同梱の `Build-Release.cmd` でも Release build を実行できます。

## ライセンス

OpenRGB Companion は **GNU General Public License v2.0 only (GPL-2.0-only)** で公開します。
詳細は [LICENSE](LICENSE) を参照してください。

主要な外部コンポーネントについては [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

## OpenRGB について

OpenRGB Companion は OpenRGB の非公式 Companion アプリです。
OpenRGB プロジェクトおよび各 Plugin の公式製品・公式サポートツールではありません。

OpenRGB:
https://openrgb.org/
