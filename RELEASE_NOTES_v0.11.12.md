# OpenRGB Companion v0.11.12

Initial public release.

## Highlights

- OpenRGB Profile の RGB 値を Companion 側で記録・確認
- OpenRGB Profile と Companion 記録を統合した Profiles 一覧
- Profile の新規作成 / 編集 / 複製
- Zone ごとの RGB 数値編集とカラーピッカー
- 約180ms debounce のライブ実機反映
- 実機プレビュー
- 編集破棄時の RGB 復元
- OpenRGB SDK Server の自動準備
- OpenRGB の最小化自動起動
- Scheduler Plugin 設定の表示・編集・反映
- Scheduler の未反映状態表示
- 520px 付近まで縮小可能な Responsive UI
- Standalone EXE / NSIS Installer

## Requirements

- Windows 10 / 11 x64
- OpenRGB
- OpenRGB SDK Protocol 5 環境

Scheduler 機能には OpenRGB Scheduler Plugin が必要です。

## Known limitations

- 日本語 UI のみ
- Windows のみ
- OpenRGB 1.0 / SDK Protocol 6 は未対応・未確認
- Companion から保存する Profile 名は ASCII の一部文字のみ
- Plugin 編集対応は Scheduler Plugin のみ
- OpenRGB / Scheduler Plugin は同梱しません
- 現時点ではコード署名なし

## Assets

GitHub Release には次の2ファイルを添付する想定です。

1. NSIS Installer
2. Standalone EXE

通常利用には Installer を推奨します。

## License

GNU General Public License v2.0 only (GPL-2.0-only)
