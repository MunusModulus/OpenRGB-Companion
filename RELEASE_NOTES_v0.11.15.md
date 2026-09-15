# OpenRGB Companion v0.11.15

## Fix

- v0.11.14で導入した `Command::set_zone_leds()` ベースのcontroller-wide適用を撤回。
- openrgb2 0.3.0では、ASRock B550 Steel Legendの1 LED Zoneを含むfull-zone指定が
  `Invalid command` として拒否されることを実機確認。
- v0.11.15では各Zoneの `offset` / `num_leds` を使ってcontroller全体のLED配列を構築し、
  Controllerごとに `set_leds()` を1回だけ送信します。
- これにより、Zoneごとの連続UPDATE_ZONE_LEDSを避けつつ、Command APIのfull-zone制約も回避します。

## Safety

- v0.11.13の保存前fresh read-back検証を維持。
- RGB不一致時はSAVE_PROFILEを送信しません。
- 既存Profile上書き前の `.orp` 自動バックアップを維持。

## Regression test

1. Addressable Header 1 = 45,20,25
2. Addressable Header 2 = 120,70,90
3. ライブ反映でエラーが出ない
4. OpenRGB本体でHeader 1 / 2が別々の値として見える
5. `OpenRGBに保存` → 上書き保存がRGB verification errorなしで通る
6. OpenRGB再起動後にSafetyTest01をロードし、同じ2色が再現される
